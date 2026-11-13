export type EmbeddedPostgresExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export interface SupervisedEmbeddedPostgres {
  start(): Promise<void>;
  stop(): Promise<void>;
  process?: { once(event: "exit", listener: EmbeddedPostgresExitListener): unknown };
}

export interface EmbeddedPostgresSupervisor {
  current(): SupervisedEmbeddedPostgres;
  /**
   * Marks the server as shutting down without stopping PostgreSQL yet. Call it
   * first in the process signal handlers: the service manager can deliver the
   * same signal to the PostgreSQL child before server shutdown reaches
   * `shutdown()`, and that exit must not start a replacement instance.
   */
  markShuttingDown(): void;
  shutdown(): Promise<void>;
  waitForRecovery(): Promise<void>;
}

type Options = {
  initialInstance: SupervisedEmbeddedPostgres;
  createInstance: () => SupervisedEmbeddedPostgres;
  beforeRestart?: (attempt: number) => Promise<void> | void;
  restartDelaysMs?: number[];
  delay?: (milliseconds: number) => Promise<void>;
  onUnexpectedExit?: EmbeddedPostgresExitListener;
  /** A SIGTERM or exit code 0 is a shutdown; no replacement is started. */
  onOrderlyExit?: EmbeddedPostgresExitListener;
  onRestartAttemptFailed?: (error: unknown, attempt: number) => void;
  onRestarted?: (attempt: number) => void;
  onRecoveryExhausted?: (error: unknown) => void;
};

const defaultDelay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** A child stopped by SIGTERM or exiting cleanly was shut down, not lost. */
export function isOrderlyEmbeddedPostgresExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return signal === "SIGTERM" || code === 0;
}

export function createEmbeddedPostgresSupervisor(options: Options): EmbeddedPostgresSupervisor {
  const restartDelaysMs = options.restartDelaysMs ?? [0, 250, 1_000];
  const wait = options.delay ?? defaultDelay;
  let activeInstance = options.initialInstance;
  let activeInstanceExited = false;
  let shuttingDown = false;
  let recoveryPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const recover = async () => {
    let lastError: unknown = new Error("Embedded PostgreSQL exited unexpectedly");
    for (let index = 0; index < restartDelaysMs.length; index += 1) {
      if (shuttingDown) return;
      const attempt = index + 1;
      const delayMs = restartDelaysMs[index] ?? 0;
      if (delayMs > 0) await wait(delayMs);
      if (shuttingDown) return;
      try {
        await options.beforeRestart?.(attempt);
        const replacement = options.createInstance();
        await replacement.start();
        if (shuttingDown) {
          await replacement.stop();
          return;
        }
        activeInstance = replacement;
        activeInstanceExited = false;
        monitor(replacement);
        options.onRestarted?.(attempt);
        return;
      } catch (error) {
        lastError = error;
        options.onRestartAttemptFailed?.(error, attempt);
      }
    }
    if (!shuttingDown) options.onRecoveryExhausted?.(lastError);
  };

  const monitor = (instance: SupervisedEmbeddedPostgres) => {
    const child = instance.process;
    if (!child) {
      options.onRecoveryExhausted?.(new Error("Embedded PostgreSQL started without a child process to monitor"));
      return;
    }
    child.once("exit", (code, signal) => {
      if (activeInstance !== instance) return;
      activeInstanceExited = true;
      if (shuttingDown) return;
      if (isOrderlyEmbeddedPostgresExit(code, signal)) {
        shuttingDown = true;
        options.onOrderlyExit?.(code, signal);
        return;
      }
      options.onUnexpectedExit?.(code, signal);
      recoveryPromise = recover().finally(() => { recoveryPromise = null; });
    });
  };

  monitor(activeInstance);
  return {
    current: () => activeInstance,
    waitForRecovery: async () => { await recoveryPromise; },
    markShuttingDown: () => { shuttingDown = true; },
    shutdown: () => {
      shuttingDown = true;
      stopPromise ??= (async () => {
        await recoveryPromise;
        if (!activeInstanceExited) await activeInstance.stop();
      })();
      return stopPromise;
    },
  };
}
