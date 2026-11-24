import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import { getTerminalHost } from "./host-terminal-registry.js";
import { launchHostTerminal } from "./host-terminal-pty.js";
import { createWorkScheduler } from "./work-scheduler.js";

export type TerminalScope = { companyId: string; userId: string; hostId: string };
export type TerminalAudit = TerminalScope & { sessionId: string; event: "started" | "ended"; at: string; reason?: string; exitCode?: number | null };
type Handlers = { output: (data: string) => void; closed: (reason: string, exitCode: number | null) => void };
type Session = TerminalScope & {
  id: string; hash: string | null; expiresAt: number; connected: boolean;
  child?: ReturnType<typeof launchHostTerminal>; handlers?: Handlers;
  reason?: string; started?: boolean; opening?: Promise<void>; closing?: Promise<void>;
};
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class HostTerminalSessions {
  private sessions = new Map<string, Session>();
  private scheduler = createWorkScheduler();
  private stopped = false;
  private shutdownPromise?: Promise<void>;
  constructor(private audit: (event: TerminalAudit) => Promise<void>, private options: {
    idleMs?: number; maxMs?: number; tokenMs?: number;
    launch?: typeof launchHostTerminal;
    onError: (sessionId: string) => void;
  }) {}

  async create(scope: TerminalScope) {
    await getTerminalHost(scope.companyId, scope.hostId);
    if (this.stopped) throw new HttpError(503, "Host terminals are shutting down");
    if ([...this.sessions.values()].filter(s => s.userId === scope.userId).length >= 4) {
      throw new HttpError(409, "At most four host terminals may be open per user");
    }
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + (this.options.tokenMs ?? 60_000);
    this.sessions.set(id, { ...scope, id, hash: hash(token), expiresAt, connected: false });
    this.scheduler.schedule(`${id}:token`, expiresAt, () => { this.sessions.delete(id); });
    return { id, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  consume(id: string, token: string, scope: TerminalScope) {
    const session = this.sessions.get(id);
    if (!session || session.hash !== hash(token) || session.expiresAt <= Date.now()
      || session.companyId !== scope.companyId || session.userId !== scope.userId || session.hostId !== scope.hostId) {
      throw new HttpError(403, "Terminal token is invalid, used or expired");
    }
    session.hash = null; session.connected = true;
    this.scheduler.cancel(`${id}:token`);
    this.scheduler.schedule(`${id}:max`, Date.now() + (this.options.maxMs ?? 43_200_000), () => this.end(id, "max_duration"));
    this.touch(id);
  }

  open(id: string, handlers: Handlers): Promise<void> {
    const session = this.sessions.get(id);
    if (!session?.connected || session.reason || session.opening) return Promise.resolve();
    session.handlers = handlers;
    session.opening = this.start(session);
    return session.opening;
  }

  private async start(session: Session) {
    const { id, handlers } = session;
    if (!handlers) return;
    try {
      // Re-read operator policy at connection time; tokens cannot retain revoked access.
      const host = await getTerminalHost(session.companyId, session.hostId);
      if (session.reason) return;
      await this.audit(this.event(session, "started"));
      session.started = true;
      if (session.reason) return;
      const child = (this.options.launch ?? launchHostTerminal)(host);
      session.child = child;
      child.stdin.on("error", () => this.end(id, "process_error"));
      child.stdout.on("data", (data: string) => { if (!session.reason) { this.touch(id); handlers.output(data); } });
      child.once("error", () => this.end(id, "process_error"));
      child.once("close", code => this.end(id, "shell_exit", code));
    } catch {
      this.end(id, "startup_failed");
    }
  }

  write(id: string, frame: { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }) {
    const session = this.sessions.get(id);
    if (!session?.child || session.reason) return;
    if (frame.type === "input") this.touch(id); // Resize alone is not operator activity.
    if (session.child.stdin.writableLength > 256 * 1024) { this.end(id, "input_overflow"); return; }
    session.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private touch(id: string) {
    this.scheduler.schedule(`${id}:idle`, Date.now() + (this.options.idleMs ?? 1_800_000), () => this.end(id, "idle_timeout"));
  }
  private event(session: Session, event: TerminalAudit["event"], reason?: string, exitCode?: number | null): TerminalAudit {
    return { companyId: session.companyId, userId: session.userId, hostId: session.hostId, sessionId: session.id,
      event, at: new Date().toISOString(), ...(event === "ended" ? { reason, exitCode: exitCode ?? null } : {}) };
  }
  end(id: string, reason: string, exitCode: number | null = null): void {
    void this.close(id, reason, exitCode).catch(() => this.options.onError(id));
  }
  close(id: string, reason: string, exitCode: number | null = null): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.resolve();
    if (session.closing) return session.closing;
    if (session.reason) return Promise.resolve();
    session.reason = reason;
    for (const key of ["token", "idle", "max"]) this.scheduler.cancel(`${id}:${key}`);
    session.handlers?.closed(reason, exitCode);
    session.closing = (async () => {
      await session.opening;
      const child = session.child;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          child.once("close", () => resolve());
          // Python handles TERM by killing all job-control groups in the PTY.
          child.kill("SIGTERM");
        });
      }
      if (session.started) await this.audit(this.event(session, "ended", reason, child?.exitCode ?? exitCode));
    })().finally(() => { this.sessions.delete(id); });
    return session.closing;
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    this.shutdownPromise = (async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id, "server_shutdown")));
      this.scheduler.stop();
      if (results.some(result => result.status === "rejected")) throw new Error("Host terminal shutdown audit failed");
    })();
    return this.shutdownPromise;
  }
}
