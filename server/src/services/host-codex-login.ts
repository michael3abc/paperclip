import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDeviceLoginPrompt } from "@paperclipai/adapter-codex-local/server";
import { badRequest, HttpError, notFound } from "../errors.js";
const conflict = (message: string) => new HttpError(409, message);

// Dashboard sign-in for a host's native Codex CLI (ChatGPT device authorization).
// The registry's explicit `codexLogin` selects the CLI and optional CODEX_HOME;
// the client never supplies a command, path or SSH target. Credentials are written
// by Codex itself on that host. The view carries only the device page URL and the
// one-time code while waiting; nothing is logged or persisted.
type CodexLoginConfig = { command: string; codexHome?: string };
type Host = { id: string; label: string; sshAlias?: string; companyIds: string[]; codexLogin?: CodexLoginConfig };
export type HostCodexLogin = {
  id: string; hostId: string;
  status: "starting" | "waiting" | "verifying" | "authenticated" | "failed" | "cancelled";
  verificationUrl?: string; userCode?: string; expiresAt: string;
};
type Session = { companyId: string; userId: string; host: Host; view: HostCodexLogin; child?: ChildProcessWithoutNullStreams; timer?: NodeJS.Timeout };
const sessions = new Map<string, Session>();
export const HOST_CODEX_LOGIN_TTL_MS = 600_000;

// A finite terminal on the selected host. Its CLI owns credential storage. The
// remote deadline also kills the CLI if the SSH client disappears (stdin EOF).
export const HOST_CODEX_TERMINAL = String.raw`
import os, sys, json, subprocess, pty, select, signal, time, fcntl, termios, struct
cfg = json.loads(sys.argv[1])
env = dict(os.environ)
for key in list(env):
    if key.startswith(('OPENAI_', 'CODEX_')):
        env.pop(key, None)
env['BROWSER'] = 'true'
env['NO_COLOR'] = '1'
if cfg.get('codexHome'): env['CODEX_HOME'] = cfg['codexHome']
command = os.path.expanduser(cfg['command'])
if sys.argv[2] == 'status':
    try:
        result = subprocess.run([command, 'login', 'status'], env=env, capture_output=True, timeout=20, stdin=subprocess.DEVNULL)
        text = (result.stdout + result.stderr).decode('utf-8', 'replace')
        if result.returncode == 0 and 'Logged in using ChatGPT' in text: print(json.dumps({'loggedIn': True}))
        elif 'Not logged in' in text or 'Logged in using an API key' in text: print(json.dumps({'loggedIn': False}))
        else: sys.exit(1)
    except Exception: sys.exit(1)
    sys.exit(0)
pid, master = pty.fork()
if pid == 0:
    os.execvpe(command, [command, 'login', '--device-auth'], env)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 4096, 0, 0))
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(1)))
deadline = time.monotonic() + ${HOST_CODEX_LOGIN_TTL_MS / 1000}
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master, 0], [], [], min(1, max(0, deadline-time.monotonic())))
        if 0 in ready:
            if not os.read(0, 4096): sys.exit(1)
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
      || (h.codexLogin && (!/^\/[a-zA-Z0-9/_.@+-]+$/.test(h.codexLogin.command)
        || (h.codexLogin.codexHome && !/^\/[a-zA-Z0-9/_.-]+$/.test(h.codexLogin.codexHome))))) throw badRequest("Invalid host login configuration");
    return h;
  });
}

function launch(host: Host, mode: "status" | "login") {
  if (!host.codexLogin) throw badRequest("Codex login is not configured on this host");
  const config = { command: host.codexLogin.command, codexHome: host.codexLogin.codexHome };
  const args = ["-u", "-c", HOST_CODEX_TERMINAL, JSON.stringify(config), mode];
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

export async function listHostCodexLogins(companyId: string) {
  return (await hosts(companyId)).map(h => ({ id: h.id, label: h.label, available: !!h.codexLogin }));
}
export async function checkHostCodexLogin(companyId: string, hostId: string) {
  const host = (await hosts(companyId)).find(h => h.id === hostId);
  if (!host) throw notFound("Host not found");
  return { loggedIn: await status(host) };
}

function finish(session: Session, state: HostCodexLogin["status"]) {
  clearTimeout(session.timer);
  session.view.status = state;
  delete session.view.verificationUrl;
  delete session.view.userCode;
  session.child?.stdin.end();
  session.child?.kill("SIGTERM");
  session.child = undefined;
  session.timer = setTimeout(() => sessions.delete(session.view.id), 60_000);
  session.timer.unref();
}
export async function startHostCodexLogin(companyId: string, userId: string, hostId: string) {
  const host = (await hosts(companyId)).find(h => h.id === hostId);
  if (!host) throw notFound("Host not found");
  if ([...sessions.values()].some(s => s.host.id === hostId && ["starting", "waiting", "verifying"].includes(s.view.status))) throw conflict("A sign-in is already active on this host");
  const child = launch(host, "login");
  const session: Session = { companyId, userId, host, child, view: { id: randomUUID(), hostId, status: "starting", expiresAt: new Date(Date.now() + HOST_CODEX_LOGIN_TTL_MS).toISOString() } };
  sessions.set(session.view.id, session);
  session.timer = setTimeout(() => finish(session, "failed"), HOST_CODEX_LOGIN_TTL_MS);
  session.timer.unref();
  let output = "";
  child.stdout.on("data", bytes => {
    if (session.view.status !== "starting") return;
    output = (output + bytes.toString()).replaceAll("\r\n", "\n").slice(-32_768);
    const prompt = parseDeviceLoginPrompt(output);
    if (prompt && !prompt.code.includes("?")) {
      session.view.verificationUrl = prompt.url; session.view.userCode = prompt.code; session.view.status = "waiting"; output = "";
    }
  });
  child.once("error", () => finish(session, "failed"));
  child.once("close", async code => {
    if (!["starting", "waiting", "verifying"].includes(session.view.status)) return;
    session.child = undefined;
    if (code !== 0) { finish(session, "failed"); return; }
    session.view.status = "verifying";
    delete session.view.verificationUrl;
    delete session.view.userCode;
    const loggedIn = await status(host);
    if (session.view.status === "verifying") finish(session, loggedIn === true ? "authenticated" : "failed");
  });
  return { ...session.view };
}
export function hostCodexSession(companyId: string, userId: string, id: string, action?: "cancel") {
  const session = sessions.get(id);
  if (!session || session.companyId !== companyId || session.userId !== userId) throw notFound("Sign-in expired or unavailable; start again");
  if (["starting", "waiting", "verifying"].includes(session.view.status) && Date.now() >= Date.parse(session.view.expiresAt)) finish(session, "failed");
  if (action === "cancel") finish(session, "cancelled");
  return { ...session.view };
}
