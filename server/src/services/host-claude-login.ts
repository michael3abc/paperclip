import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { badRequest, HttpError, notFound } from "../errors.js";
const conflict = (message: string) => new HttpError(409, message);

type Host = { id: string; label: string; sshAlias?: string; companyIds: string[]; claudeLogin?: { command: string; configDir?: string } };
export type HostClaudeLogin = { id: string; hostId: string; status: "starting" | "waiting" | "verifying" | "authenticated" | "failed" | "cancelled"; authorizationUrl?: string; expiresAt: string };
type Session = { companyId: string; userId: string; host: Host; view: HostClaudeLogin; child?: ChildProcessWithoutNullStreams; submitted: boolean; timer?: NodeJS.Timeout };
const sessions = new Map<string, Session>();

// A finite terminal on the selected host. Its CLI owns credential storage. The
// remote deadline also kills the CLI if the SSH client disappears. No shell input.
export const HOST_CLAUDE_TERMINAL = String.raw`
import os, sys, json, subprocess, pty, select, signal, time, fcntl, termios, struct
cfg = json.loads(sys.argv[1])
env = dict(os.environ)
for key in list(env):
    if key.startswith(('ANTHROPIC_', 'CLAUDE_CODE_')) or key == 'CLAUDE_CONFIG_DIR':
        env.pop(key, None)
env['BROWSER'] = 'true'
if cfg.get('configDir'): env['CLAUDE_CONFIG_DIR'] = cfg['configDir']
command = os.path.expanduser(cfg['command'])
if sys.argv[2] == 'status':
    try:
        result = subprocess.run([command, 'auth', 'status', '--json'], env=env, capture_output=True, timeout=20)
        data = json.loads(result.stdout)
        print(json.dumps({'loggedIn': data.get('loggedIn') is True and data.get('authMethod') == 'claude.ai'}))
    except Exception: sys.exit(1)
    sys.exit(0)
pid, master = pty.fork()
if pid == 0:
    os.execvpe(command, [command, 'auth', 'login', '--claudeai'], env)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 4096, 0, 0))
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(1)))
deadline = time.monotonic() + 300
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master, 0], [], [], min(1, max(0, deadline-time.monotonic())))
        if 0 in ready:
            data = os.read(0, 4096)
            if not data: sys.exit(1)
            os.write(master, data)
        if master in ready:
            try: data = os.read(master, 8192)
            except OSError: break
            if not data: break
            os.write(1, data)
    else: sys.exit(1)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    stop()
`;

async function hosts(companyId: string): Promise<Host[]> {
  const file = process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE ?? path.join(homedir(), ".config/paperclip-ccpocket/hosts.json");
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.hosts)) throw badRequest("Invalid host registry");
  return data.hosts.filter((h: Host) => Array.isArray(h.companyIds) && h.companyIds.includes(companyId)).map((h: Host) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(h.id) || (h.sshAlias && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(h.sshAlias))
      || (h.claudeLogin && (!/^\/[a-zA-Z0-9/_.@+-]+$/.test(h.claudeLogin.command)
        || (h.claudeLogin.configDir && !/^\/[a-zA-Z0-9/_.-]+$/.test(h.claudeLogin.configDir))))) throw badRequest("Invalid host login configuration");
    return h;
  });
}

function launch(host: Host, mode: "status" | "login") {
  if (!host.claudeLogin) throw badRequest("Claude login is not configured on this host");
  const args = ["-u", "-c", HOST_CLAUDE_TERMINAL, JSON.stringify(host.claudeLogin), mode];
  const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  const child = host.sshAlias
    ? spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", host.sshAlias, ["python3", ...args].map(quote).join(" ")], { stdio: "pipe" })
    : spawn("python3", args, { stdio: "pipe" });
  child.stderr.resume(); // Never retain provider/SSH diagnostics.
  return child;
}

async function status(host: Host): Promise<boolean | null> {
  return new Promise(resolve => {
    const child = launch(host, "status");
    let output = "";
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 30_000);
    child.stdout.on("data", bytes => { output = (output + bytes.toString()).slice(-4096); });
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", code => {
      clearTimeout(timer);
      try { resolve(code === 0 ? JSON.parse(output).loggedIn === true : null); } catch { resolve(null); }
    });
  });
}

export async function listHostClaudeLogins(companyId: string) {
  return (await hosts(companyId)).map(h => ({ id: h.id, label: h.label, available: !!h.claudeLogin }));
}
export async function checkHostClaudeLogin(companyId: string, hostId: string) {
  const host = (await hosts(companyId)).find(h => h.id === hostId);
  if (!host) throw notFound("Host not found");
  return { loggedIn: await status(host) };
}

export function authorizationUrl(output: string): string | undefined {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const candidates = plain.match(/https:\/\/[^\s\x1b\x07<>]+/g) ?? [];
  for (const raw of candidates) {
    try {
      const url = new URL(raw);
      if (["https://claude.ai/oauth/authorize", "https://claude.com/cai/oauth/authorize"].includes(url.origin + url.pathname)
        && !url.username && !url.password && !url.hash && raw.length < 8192 && !/sk-ant-/i.test(raw)
        && ["client_id", "state", "code_challenge"].every(key => url.searchParams.getAll(key).length === 1)) return raw;
    } catch { /* Incomplete terminal chunk. */ }
  }
}

function finish(session: Session, state: HostClaudeLogin["status"]) {
  clearTimeout(session.timer);
  session.view.status = state;
  delete session.view.authorizationUrl;
  session.child?.stdin.end();
  session.child?.kill("SIGTERM");
  session.child = undefined;
  session.timer = setTimeout(() => sessions.delete(session.view.id), 60_000);
  session.timer.unref();
}
export async function startHostClaudeLogin(companyId: string, userId: string, hostId: string) {
  const host = (await hosts(companyId)).find(h => h.id === hostId);
  if (!host) throw notFound("Host not found");
  if ([...sessions.values()].some(s => s.host.id === hostId && ["starting", "waiting", "verifying"].includes(s.view.status))) throw conflict("A sign-in is already active on this host");
  const child = launch(host, "login");
  const session: Session = { companyId, userId, host, child, submitted: false, view: { id: randomUUID(), hostId, status: "starting", expiresAt: new Date(Date.now() + 300_000).toISOString() } };
  sessions.set(session.view.id, session);
  session.timer = setTimeout(() => finish(session, "failed"), 300_000);
  session.timer.unref();
  let output = "";
  child.stdout.on("data", bytes => {
    if (session.view.status !== "starting") return;
    output = (output + bytes.toString()).slice(-32_768);
    const url = authorizationUrl(output);
    if (url) { session.view.authorizationUrl = url; session.view.status = "waiting"; output = ""; }
  });
  child.once("error", () => finish(session, "failed"));
  child.once("close", async code => {
    if (!["starting", "waiting", "verifying"].includes(session.view.status)) return;
    session.child = undefined;
    if (code !== 0) { finish(session, "failed"); return; }
    session.view.status = "verifying";
    const loggedIn = await status(host);
    if (session.view.status === "verifying") finish(session, loggedIn === true ? "authenticated" : "failed");
  });
  return { ...session.view };
}
export function hostClaudeSession(companyId: string, userId: string, id: string, action?: "cancel" | "code", code?: unknown) {
  const session = sessions.get(id);
  if (!session || session.companyId !== companyId || session.userId !== userId) throw notFound("Sign-in expired or unavailable; start again");
  if (["starting", "waiting", "verifying"].includes(session.view.status) && Date.now() >= Date.parse(session.view.expiresAt)) finish(session, "failed");
  if (action === "cancel") finish(session, "cancelled");
  if (action === "code") {
    if (session.view.status !== "waiting" || session.submitted) throw conflict("This sign-in cannot accept a code");
    if (typeof code !== "string" || !/^[A-Za-z0-9_#.-]{1,4096}$/.test(code)) throw badRequest("Invalid authorization code");
    session.submitted = true;
    session.view.status = "verifying";
    delete session.view.authorizationUrl;
    session.child?.stdin.write(code + "\n");
  }
  return { ...session.view };
}
