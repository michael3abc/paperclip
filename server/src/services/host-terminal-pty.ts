import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { TerminalHost } from "./host-terminal-registry.js";

// JSON-lines on stdin distinguish input from window changes. Raw stdout is
// terminal data and is never retained. Python and SSH also get the clean env.
export const HOST_TERMINAL_PTY = String.raw`
import os, sys, json, pty, select, signal, fcntl, termios, struct, ctypes
# Adopt and reap shell jobs after the login shell exits (Linux PR_SET_CHILD_SUBREAPER).
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0: sys.exit(1)
cfg = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
wake_read, wake_write = os.pipe2(os.O_NONBLOCK)
signal.signal(signal.SIGCHLD, lambda *_: None)
signal.set_wakeup_fd(wake_write)
signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGCHLD})
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGCHLD})
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2): os.dup2(slave, fd)
    if slave > 2: os.close(slave)
    if cfg.get('cwd'): os.chdir(cfg['cwd'])
    os.execvpe(cfg['argv'][0], cfg['argv'], dict(os.environ))
os.close(slave)
def stop(*_):
    # Job control can create additional groups in this PTY's session. Kill
    # these as well as the login shell, including background jobs (Linux).
    groups = {pid}
    victims = {pid}
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            with open('/proc/' + name + '/stat') as file: fields = file.read().rsplit(')', 1)[1].split()
            if int(fields[3]) == pid:
                groups.add(int(fields[2]))
                victims.add(int(name))
        except (OSError, ValueError, IndexError): pass
    for group in groups:
        try: os.killpg(group, signal.SIGKILL)
        except ProcessLookupError: pass
    return [pid] + sorted(victims - {pid})
signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
buffer = b''
status = None
try:
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM, signal.SIGCHLD})
    while True:
        ready, _, _ = select.select([master, 0, wake_read], [], [])
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                stop()
                break
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                frame = json.loads(line)
                if frame['type'] == 'input':
                    payload = frame['data'].encode('utf-8')
                    while payload:
                        written = os.write(master, payload)
                        payload = payload[written:]
                elif frame['type'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', frame['rows'], frame['cols'], 0, 0))
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            os.write(1, data)
        if wake_read in ready:
            os.read(wake_read, 4096)
            exited, child_status = os.waitpid(pid, os.WNOHANG)
            if exited:
                status = child_status
                stop()
                # Preserve final bytes already written before the child exit.
                while select.select([master], [], [], 0)[0]:
                    try: data = os.read(master, 65536)
                    except OSError: break
                    if not data: break
                    os.write(1, data)
                break
    if status is None: _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    for victim in stop():
        try: os.waitpid(victim, 0)
        except ChildProcessError: pass
    os.close(master)
    os.close(wake_read)
    os.close(wake_write)
`;

export function cleanTerminalEnvironment(identity = userInfo()) {
  return {
    HOME: identity.homedir, USER: identity.username, LOGNAME: identity.username,
    SHELL: identity.shell || "/bin/sh", PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8", TERM: "xterm-256color",
  };
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function terminalCommand(host: TerminalHost, shell: string) {
  if (!host.sshAlias) return { argv: [shell, "-l"], cwd: host.terminal?.cwd };
  const remote = `${host.terminal?.cwd ? `cd -- ${quote(host.terminal.cwd)} && ` : ""}exec "\${SHELL:-/bin/sh}" -l`;
  return { argv: ["/usr/bin/ssh", "-tt", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30", host.sshAlias, remote] };
}
export function launchHostTerminal(host: TerminalHost, identity = userInfo()) {
  const env = cleanTerminalEnvironment(identity);
  const child = spawn("/usr/bin/python3", ["-u", "-c", HOST_TERMINAL_PTY, JSON.stringify(terminalCommand(host, env.SHELL))], {
    env, stdio: "pipe",
  });
  child.stderr.resume(); // Discard diagnostics; never log provider or PTY content.
  child.stdout.setEncoding("utf8");
  return child;
}
