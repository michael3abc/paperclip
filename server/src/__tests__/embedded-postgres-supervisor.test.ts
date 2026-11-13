import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedPostgresSupervisor, type SupervisedEmbeddedPostgres } from "../embedded-postgres-supervisor.js";

function createInstance(startError?: Error) {
  const process = new EventEmitter();
  const instance: SupervisedEmbeddedPostgres = {
    process,
    start: vi.fn(async () => { if (startError) throw startError; }),
    stop: vi.fn(async () => undefined),
  };
  return { instance, process };
}

describe("embedded PostgreSQL supervisor", () => {
  it("restarts PostgreSQL after its managed child exits unexpectedly", async () => {
    const initial = createInstance();
    const replacement = createInstance();
    const onRestarted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => replacement.instance,
      restartDelaysMs: [0],
      onRestarted,
    });
    initial.process.emit("exit", 137, "SIGKILL");
    await supervisor.waitForRecovery();
    expect(replacement.instance.start).toHaveBeenCalledOnce();
    expect(supervisor.current()).toBe(replacement.instance);
    expect(onRestarted).toHaveBeenCalledWith(1);
  });

  it("does not restart PostgreSQL during orderly shutdown", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
    });
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
    expect(createReplacement).not.toHaveBeenCalled();
  });

  it("does not restart PostgreSQL after markShuttingDown and still stops it on shutdown", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const onUnexpectedExit = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
      onUnexpectedExit,
    });
    supervisor.markShuttingDown();
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
    initial.process.emit("exit", 137, "SIGKILL");
    await supervisor.waitForRecovery();
    expect(createReplacement).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it("ignores a child exit once markShuttingDown was called", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
    });
    supervisor.markShuttingDown();
    initial.process.emit("exit", 1, null);
    await supervisor.waitForRecovery();
    expect(createReplacement).not.toHaveBeenCalled();
    expect(supervisor.current()).toBe(initial.instance);
    await supervisor.shutdown();
    expect(initial.instance.stop).not.toHaveBeenCalled();
  });

  it("abandons an in-flight recovery once markShuttingDown is called", async () => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    let releaseDelay!: () => void;
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [1_000],
      delay: () => new Promise<void>((resolve) => { releaseDelay = resolve; }),
    });
    initial.process.emit("exit", 1, null);
    supervisor.markShuttingDown();
    releaseDelay();
    await supervisor.waitForRecovery();
    expect(createReplacement).not.toHaveBeenCalled();
    await Promise.all([supervisor.shutdown(), supervisor.shutdown()]);
    expect(initial.instance.stop).not.toHaveBeenCalled();
  });

  it("stops PostgreSQL only once when shutdown is requested repeatedly", async () => {
    const initial = createInstance();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => createInstance().instance,
      restartDelaysMs: [0],
    });
    supervisor.markShuttingDown();
    await Promise.all([supervisor.shutdown(), supervisor.shutdown()]);
    await supervisor.shutdown();
    expect(initial.instance.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["SIGTERM", null, "SIGTERM"],
    ["exit code 0", 0, null],
  ] as const)("treats a child exit by %s as shutdown, not a crash", async (_label, code, signal) => {
    const initial = createInstance();
    const createReplacement = vi.fn(() => createInstance().instance);
    const onUnexpectedExit = vi.fn();
    const onOrderlyExit = vi.fn();
    const onRecoveryExhausted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: createReplacement,
      restartDelaysMs: [0],
      onUnexpectedExit,
      onOrderlyExit,
      onRecoveryExhausted,
    });
    initial.process.emit("exit", code, signal);
    await supervisor.waitForRecovery();
    expect(createReplacement).not.toHaveBeenCalled();
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(onRecoveryExhausted).not.toHaveBeenCalled();
    expect(onOrderlyExit).toHaveBeenCalledWith(code, signal);
    await supervisor.shutdown();
    expect(initial.instance.stop).not.toHaveBeenCalled();
  });

  it("bounds recovery attempts and reports the final failure", async () => {
    const initial = createInstance();
    const failures = [new Error("first"), new Error("second"), new Error("third")];
    const onRecoveryExhausted = vi.fn();
    const supervisor = createEmbeddedPostgresSupervisor({
      initialInstance: initial.instance,
      createInstance: () => createInstance(failures.shift()).instance,
      restartDelaysMs: [0, 0, 0],
      onRecoveryExhausted,
    });
    initial.process.emit("exit", 1, null);
    await supervisor.waitForRecovery();
    expect(onRecoveryExhausted).toHaveBeenCalledOnce();
    expect(onRecoveryExhausted).toHaveBeenCalledWith(expect.objectContaining({ message: "third" }));
  });
});
