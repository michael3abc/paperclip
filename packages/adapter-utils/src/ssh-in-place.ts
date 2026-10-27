import path from 'node:path';
import type { SshConnectionConfig, SshRemoteExecutionSpec, runSshCommand } from './ssh.js';

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
export interface SshSessionIdentity {
  transport: 'ssh'; host: string; port: number; username: string; remoteCwd: string;
}
type SshLease = {
  provider: string | null; companyId: string; heartbeatRunId: string | null;
  providerLeaseId: string | null; metadata: RecordValue | null;
};


/** Control-plane proof only; caller must also rule out leases and launch events. */
export function isUndispatchedCredentialWait(run: RecordValue): boolean {
  const result = object(run.resultJson);
  const recovery = object(result.executionRecovery);
  const cancellation = object(result.cancellation);
  return run.status === 'cancelled' && run.errorCode === 'ai_connection_busy'
    && run.runtimeMode === 'legacy' && run.executionStage === 'settled' && Boolean(run.finishedAt)
    && !run.processPid && !run.processGroupId && !run.processStartedAt && !run.sessionIdAfter
    && !run.nativeSessionId && !run.nativeIssueId && !run.controllerLeaseExpiresAt
    && object(object(run.runnerProfileJson).adapterDispatch).adapterType === 'codex_local'
    && recovery.kind === 'ai_connection_wait'
    && recovery.providerWorkStarted === false
    && cancellation.source === 'control_plane'
    && cancellation.expected === true
    && object(cancellation.initiator).type === 'system';
}

/** Keep SSH session identity, never transport credentials or inferred legacy state. */
export function sshSessionIdentity(input: unknown): SshSessionIdentity | null {
  const value = object(input);
  if (!value || value.transport !== 'ssh' || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  if (['host', 'username', 'remoteCwd'].some(k => typeof value[k] !== 'string' || !(value[k] as string).trim())) return null;
  if (typeof value.remoteCwd !== 'string' || !path.posix.isAbsolute(value.remoteCwd)) return null;
  return {transport: 'ssh', host: value.host as string, port: value.port, username: value.username as string, remoteCwd: value.remoteCwd};
}

/** A stopped process may still have made changes: never automatically replay it. */
export function blocksAutomaticSshReplay(run: RecordValue, agent: RecordValue): boolean {
  if (run.processStartedAt == null) return false;
  const context = object(run.contextSnapshot);
  const environment = object(context.paperclipEnvironment);
  const immutable = object(object(run.runnerProfileJson).adapterDispatch).adapterType === 'codex_local'
    && environment.driver === 'ssh'
    && (object(environment.workspaceRealization).mode === 'in_place'
      || object(object(context.paperclipWorkspace).realization).mode === 'in_place');
  return immutable || (agent.adapterType === 'codex_local'
    && typeof object(agent.adapterConfig).command === 'string'
      && path.posix.basename(object(agent.adapterConfig).command as string) === 'codex-managed');
}

/** A receipt is issued only after the remote run is stopped and fenced from reuse. */
export async function stopInPlaceLease(lease: SshLease, spec: SshConnectionConfig, runSshCommand: typeof import("./ssh.js").runSshCommand) {
  const metadata = object(lease.metadata);
  if (lease.provider !== 'ssh' || object(metadata.workspaceRealization).mode !== 'in_place') return null;
  for (const value of [lease.companyId, metadata.agentId, lease.heartbeatRunId]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(typeof value === 'string' ? value : '')) throw new Error('Missing SSH lease ownership');
  }
  for (const key of ['host', 'port', 'username'] as const) {
    if (spec[key] !== metadata[key]) throw new Error('SSH lease host changed; reconcile on original host');
  }
  const home = (await runSshCommand(spec, 'printf "%s" "$HOME"')).stdout.trim();
  if (!path.posix.isAbsolute(home) || home === '/') throw new Error('Invalid remote HOME');
  const record = path.posix.join(home, '.local/state/paperclip-ssh', lease.companyId, metadata.agentId as string, 'codex/processes', `${lease.heartbeatRunId}.json`);
  const wrapper = path.posix.join(home, '.local/lib/paperclip-ssh/codex-managed');
  const response = await runSshCommand(spec, `${quote(wrapper)} --stop-record ${quote(record)}`, {timeoutMs: 30000, maxBuffer: 65536});
  const receipt = JSON.parse(response.stdout);
  if (receipt.stopped !== true || receipt.runId !== lease.heartbeatRunId
      || receipt.unit !== `paperclip-ssh-${lease.heartbeatRunId}.scope`) throw new Error('Remote stop unverified');
  return {providerLeaseId: lease.providerLeaseId, state: 'stopped' as const};
}

/** Resolve only the explicitly selected remote project; never inspect it locally. */
export function resolveInPlaceAnchor<Hint>({ rows, preferredId, driver, config, projectId, workspaceHints }: {
  rows: Array<{id: string; sourceType: string; cwd: string | null; isPrimary: boolean; repoUrl?: string | null}>;
  preferredId?: string | null; driver?: string | null; config?: RecordValue | null;
  projectId: string | null; workspaceHints: Hint[];
}) {
  if (driver !== 'ssh' || config?.workspaceMode !== 'in_place') return null;
  const selected = preferredId ? rows.find(w => w.id === preferredId) : rows.find(w => w.isPrimary) ?? (rows.length === 1 ? rows[0] : null);
  if (!selected || selected.sourceType !== 'remote_managed' || !path.posix.isAbsolute(selected.cwd ?? '')
      || selected.cwd !== config.remoteWorkspacePath || selected.repoUrl) {
    throw new Error('SSH in_place requires an explicit remote-managed project workspace matching the environment path; no local fallback or clone is permitted');
  }
  return { cwd: selected.cwd!, source: 'project_primary' as const, projectId, workspaceId: selected.id,
    repoUrl: null, repoRef: null, workspaceHints, warnings: [], baseCwdFallback: false,
    materializationFailures: [], localPathOnlyWorkspace: false };
}

export function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Validate an existing directory without creating or changing it. */
export function existingWorkspaceCommand(cwd: string) {
  if (!path.posix.isAbsolute(cwd) || cwd === '/') throw new Error('Invalid SSH in_place workspace');
  return `test -d ${quote(cwd)} && cd ${quote(cwd)} && pwd -P`;
}

/** Separate persistent agent state from every project and from the user's Codex home. */
export async function prepareInPlaceRuntime(input: {
  inPlaceRuntime?: boolean; syncWorkspace?: boolean; runtimeOwnerId?: string; adapterKey: string;
  spec: SshRemoteExecutionSpec; workspaceRemoteDir?: string;
}, runSshCommand: typeof import("./ssh.js").runSshCommand): Promise<string | null> {
  if (input.inPlaceRuntime !== true) return null;
  if (input.syncWorkspace !== false) throw new Error('SSH in_place cannot synchronize the project');
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(input.runtimeOwnerId ?? '') || !/^[a-zA-Z0-9_-]+$/.test(input.adapterKey)) {
    throw new Error('SSH in_place runtime requires company/agent ownership');
  }
  const response = await runSshCommand(input.spec, 'printf "%s" "$HOME"');
  const home = response.stdout.trim();
  if (!path.posix.isAbsolute(home) || home === '/') throw new Error('Invalid remote HOME');
  const root = path.posix.join(home, '.local/state/paperclip-ssh', input.runtimeOwnerId!, input.adapterKey);
  const workspace = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  if (root === workspace || root.startsWith(workspace + '/') || workspace.startsWith(root + '/')) throw new Error('Runtime overlaps project workspace');
  // Resolve both roots remotely and reject symlinks into the project or other homes.
  const script = `import os,pathlib,sys\np=pathlib.Path(sys.argv[1]); w=pathlib.Path(sys.argv[2]).resolve(strict=True)\nif p.resolve()!=p or p==w or w in p.parents or p in w.parents: raise SystemExit('Unsafe runtime path')\np.mkdir(parents=True,exist_ok=True,mode=0o700)\nif p.stat().st_uid!=os.getuid(): raise SystemExit('Runtime owner mismatch')\np.chmod(0o700)\n`;
  await runSshCommand(input.spec, `umask 077; python3 -c ${quote(script)} ${quote(root)} ${quote(workspace)}`);
  return root;
}
