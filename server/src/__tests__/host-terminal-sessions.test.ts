import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostTerminalSessions, type TerminalAudit, type TerminalScope } from "../services/host-terminal-sessions.js";
import { getTerminalHost, listTerminalHosts } from "../services/host-terminal-registry.js";
import { cleanTerminalEnvironment, launchHostTerminal, terminalCommand } from "../services/host-terminal-pty.js";

let root: string, registry: string;
let stores: HostTerminalSessions[];
const scope: TerminalScope = { companyId: "company", userId: "owner", hostId: "local" };
const local = { id: "local", label: "Local", companyIds: ["company"], terminal: { enabled: true } };
async function save(hosts: unknown[] = [local]) { await writeFile(registry, JSON.stringify({ version: 1, hosts })); }
function store(options: { idleMs?: number; maxMs?: number; tokenMs?: number } = {}) {
  const audit = vi.fn(async (_event: TerminalAudit) => {}), errors = vi.fn();
  const service = new HostTerminalSessions(audit, { ...options, onError: errors,
    launch: host => launchHostTerminal(host, { ...userInfo(), homedir: root, shell: "/bin/sh" }) });
  stores.push(service);
  return { service, audit, errors };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paperclip-terminal-")); registry = path.join(root, "hosts.json");
  vi.stubEnv("PAPERCLIP_CCPOCKET_HOSTS_FILE", registry); stores = []; await save();
});
afterEach(async () => {
  vi.useRealTimers(); await Promise.all(stores.map(s => s.shutdown()));
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

describe("operator host registry", () => {
  it("lists only opted-in hosts in this company", async () => {
    await save([local, { ...local, id: "off", terminal: { enabled: false } }, { ...local, id: "old", terminal: undefined },
      { ...local, id: "foreign", companyIds: ["other"] }]);
    expect((await listTerminalHosts("company")).map(h => h.id)).toEqual(["local"]);
    await expect(getTerminalHost("company", "off")).rejects.toMatchObject({ status: 404 });
    await expect(getTerminalHost("company", "foreign")).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    { terminal: { enabled: true, cwd: "relative/path" } },
    { terminal: { enabled: true, cwd: "/tmp;id" } },
    { terminal: { enabled: true, cwd: "/tmp\nwhoami" } },
    { terminal: { enabled: true, shell: "/bin/sh" } },
    { terminal: { enabled: "true" } }, { sshAlias: "-oProxyCommand=id" }, { id: "bad/host" },
  ])("rejects malformed terminal registry fields: %j", async patch => {
    await save([{ ...local, ...patch }]);
    await expect(listTerminalHosts("company")).rejects.toMatchObject({ status: 400 });
  });
  it("rejects duplicate IDs and invalid registry versions", async () => {
    await save([local, local]); await expect(listTerminalHosts("company")).rejects.toMatchObject({ status: 400 });
    await writeFile(registry, '{"version":2,"hosts":[]}');
    await expect(listTerminalHosts("company")).rejects.toMatchObject({ status: 400 });
  });
  it("builds a pinned strict SSH command and never uses local cwd remotely", () => {
    const command = terminalCommand({ ...local, sshAlias: "Remote-host-B", terminal: { enabled: true, cwd: "/work/project" } }, "/bin/sh");
    expect(command.argv).toEqual(["/usr/bin/ssh", "-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", "Remote-host-B", 'cd -- \'/work/project\' && exec "${SHELL:-/bin/sh}" -l']);
    expect(command.cwd).toBeUndefined();
  });
});

describe("host terminal session authority and deadlines", () => {
  it("binds single-use tokens to the company, human and host", async () => {
    const { service } = store(); const minted = await service.create(scope);
    expect(Date.parse(minted.expiresAt) - Date.now()).toBeGreaterThan(59_000);
    for (const patch of [{ userId: "another" }, { companyId: "other" }, { hostId: "other" }]) {
      expect(() => service.consume(minted.id, minted.token, { ...scope, ...patch })).toThrow();
    }
    expect(() => service.consume(minted.id, "wrong", scope)).toThrow();
    service.consume(minted.id, minted.token, scope);
    expect(() => service.consume(minted.id, minted.token, scope)).toThrow();
  });
  it("expires unused tokens and frees the reserved slots", async () => {
    vi.useFakeTimers(); const { service } = store();
    const tokens = await Promise.all(Array.from({ length: 4 }, () => service.create(scope)));
    await expect(service.create(scope)).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(() => service.consume(tokens[0]!.id, tokens[0]!.token, scope)).toThrow();
    await expect(service.create(scope)).resolves.toHaveProperty("token");
  });
  it("enforces idle timeout and absolute max duration without an idle scanner", async () => {
    vi.useFakeTimers(); const { service } = store({ idleMs: 100, maxMs: 500 });
    const closed = vi.fn(); const minted = await service.create(scope);
    service.consume(minted.id, minted.token, scope);
    // No real subprocess is needed to prove the expiry obligation.
    await service.open(minted.id, { output: () => {}, closed });
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toHaveBeenCalledWith("idle_timeout", null);
    vi.useRealTimers(); await service.close(minted.id, "test_cleanup");
  });
  it("enforces the absolute deadline even when a terminal is not idle", async () => {
    vi.useFakeTimers(); const { service } = store({ idleMs: 1000, maxMs: 100 });
    const closed = vi.fn(); const minted = await service.create(scope);
    service.consume(minted.id, minted.token, scope);
    await service.open(minted.id, { output: () => {}, closed });
    await vi.advanceTimersByTimeAsync(50);
    service.write(minted.id, { type: "input", data: "echo active\n" });
    await vi.advanceTimersByTimeAsync(50);
    expect(closed).toHaveBeenCalledWith("max_duration", null);
    vi.useRealTimers(); await service.close(minted.id, "test_cleanup");
  });
  it("rechecks registry opt-in between token mint and connection", async () => {
    const { service, audit } = store(); const minted = await service.create(scope);
    service.consume(minted.id, minted.token, scope);
    await save([{ ...local, terminal: { enabled: false } }]);
    const closed = vi.fn(); await service.open(minted.id, { output: () => {}, closed });
    expect(closed).toHaveBeenCalledWith("startup_failed", null);
    expect(audit).not.toHaveBeenCalled();
  });
  it("does not start a process after a disconnect racing the start audit", async () => {
    let resolveAudit!: () => void;
    const auditGate = new Promise<void>(resolve => { resolveAudit = resolve; });
    const audit = vi.fn((_event: TerminalAudit) => auditGate), launch = vi.fn(launchHostTerminal);
    const service = new HostTerminalSessions(audit, { launch, onError: vi.fn() }); stores.push(service);
    const minted = await service.create(scope); service.consume(minted.id, minted.token, scope);
    const opening = service.open(minted.id, { output: () => {}, closed: () => {} });
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(1));
    const closing = service.close(minted.id, "client_closed"); resolveAudit();
    await opening; await closing;
    expect(launch).not.toHaveBeenCalled();
    expect(audit.mock.calls.map(([event]) => event.event)).toEqual(["started", "ended"]);
  });
});

it("real local PTY: echo, UTF-8, clean environment, resize and process-group teardown", async () => {
  vi.stubEnv("PAPERCLIP_TERMINAL_TEST_SECRET", "fake-sensitive-server-value");
  vi.stubEnv("DATABASE_URL", "fake-database-url");
  expect(Object.keys(cleanTerminalEnvironment()).sort()).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]);
  await save([{ ...local, terminal: { enabled: true, cwd: root } }]);
  const { service, audit, errors } = store();
  const minted = await service.create(scope); service.consume(minted.id, minted.token, scope);
  let output = "";
  await service.open(minted.id, { output: data => { output += data; }, closed: () => {} });
  service.write(minted.id, { type: "resize", cols: 111, rows: 37 });
  service.write(minted.id, { type: "input", data: "echo hi\nprintf 'UTF:終端\\n'\nprintf 'SAFE:%s:%s\\n' \"${PAPERCLIP_TERMINAL_TEST_SECRET-unset}\" \"${DATABASE_URL-unset}\"\nstty size\nsleep 3600 & printf 'PIDS:%s:%s\\n' \"$$\" \"$!\"\n" });
  await vi.waitFor(() => {
    expect(output).toContain("hi\r\n"); expect(output).toContain("UTF:終端\r\n");
    expect(output).toContain("SAFE:unset:unset"); expect(output).toContain("37 111");
    expect(output).toMatch(/PIDS:\d+:\d+/);
  });
  const [, shellPid, jobPid] = /PIDS:(\d+):(\d+)/.exec(output)!;
  await service.close(minted.id, "client_closed");
  for (const pid of [shellPid, jobPid]) {
    await vi.waitFor(() => expect(() => process.kill(Number(pid), 0)).toThrow());
  }
  expect(errors).not.toHaveBeenCalled();
  expect(audit.mock.calls.map(([event]) => event.event)).toEqual(["started", "ended"]);
  expect(JSON.stringify(audit.mock.calls)).not.toContain("hi");
  expect(JSON.stringify(audit.mock.calls)).not.toContain("fake-sensitive");
});

it("ends and reaps background jobs when the login shell exits before its PTY closes", async () => {
  const { service } = store(); const minted = await service.create(scope);
  service.consume(minted.id, minted.token, scope);
  let output = ""; const closed = vi.fn();
  await service.open(minted.id, { output: data => { output += data; }, closed });
  service.write(minted.id, { type: "input", data: "sleep 3600 & printf 'BACKGROUND:%s\\n' \"$!\"; exit 7\n" });
  await vi.waitFor(() => expect(closed).toHaveBeenCalledWith("shell_exit", 7));
  const pid = /BACKGROUND:(\d+)/.exec(output)![1]!;
  await vi.waitFor(() => expect(() => process.kill(Number(pid), 0)).toThrow());
});

it("stops every session before surfacing a failed shutdown audit", async () => {
  const { service, audit } = store();
  audit.mockImplementation(async event => { if (event.event === "ended") throw new Error("audit unavailable"); });
  const closed = vi.fn();
  for (let index = 0; index < 2; index++) {
    const minted = await service.create(scope); service.consume(minted.id, minted.token, scope);
    await service.open(minted.id, { output: () => {}, closed });
  }
  await expect(service.shutdown()).rejects.toThrow("Host terminal shutdown audit failed");
  expect(closed).toHaveBeenCalledTimes(2);
  expect(audit.mock.calls.filter(([event]) => event.event === "ended")).toHaveLength(2);
  stores.splice(stores.indexOf(service), 1); // Its completed shutdown intentionally retains the rejection.
});
