import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunnerdDotDriver, externalRunnerExitMessage, type RunnerdDotDriverOptions } from "./runnerd-dot-driver.js";
import { describeRunnerdNativeSessionBackend } from "../../backends/codex-native-backend.js";
import { createNativeSessionBackend } from "../../backends/native-backend-factory.js";
import * as controlPlane from "../../control-plane/durable-prp-control-plane.js";
import { externalOperationDigest, type ExternalProviderOperation } from "../../contracts/external-provider.js";
import { buildNativeModelEnvelope, parseNativeExecutionInput, type NativeExecutionInputV6 } from "../../contracts/native-execution.js";
import { NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION,
  nativeRuntimePromptDigest, canonicalNativeRuntimeContextDigest } from "../../contracts/runtime-context.js";

function execution(root: string, provider: "openai_dot" | "grok_bot" = "openai_dot"): NativeExecutionInputV6 {
  const companyId = randomUUID(), agentId = randomUUID();
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 4 } },
    skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
  };
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v6",
    binding: { companyId, agentId, runId: randomUUID(), issueId: randomUUID(), executionWorkspaceId: randomUUID() },
    task: { identifier: "DOT-1", title: "Synthetic bridge recovery", description: null, prompt: "Read the synthetic counter.", workMode: "standard" },
    provider: { kind: provider, model: null, binding: { companyId, agentId, bindingId: randomUUID(), bindingGeneration: 1,
      acceptByUnixMs: Date.now() + 600_000, expiresAtUnixMs: Date.now() + 7_200_000 } },
    workspace: { access: "none", cwd: null, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: randomUUID(), driverKind: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    executionMode: "default", planningContext: null,
    completionContract: { id: randomUUID(), sha256: "sha256:" + digest, schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Read the counter", criteria: [{ id: "objective", requirement: "Read the counter" }] } },
    runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) }, interactionResponses: [], credentialBindings: [],
  }) as NativeExecutionInputV6;
}

it.each(["openai_dot", "grok_bot"] as const)("v6 closes %s identity, workspace, model and credential fields", provider => {
  const input = execution("/synthetic/pinned-instructions", provider);
  expect(parseNativeExecutionInput(input)).toEqual(input);
  expect(buildNativeModelEnvelope(input).workspace).toBeNull();
  expect(JSON.stringify(buildNativeModelEnvelope(input))).not.toContain("/synthetic");
  for (const changed of [
    { ...input, workspace: { ...input.workspace, cwd: "/private/project" } },
    { ...input, provider: { ...input.provider, model: "a-model" } },
    { ...input, provider: { ...input.provider, apiKey: "secret" } },
    { ...input, provider: { ...input.provider, binding: { ...input.provider.binding, agentId: randomUUID() } } },
    { ...input, credentialBindings: [{ bindingId: "secret-binding", service: "openai", destination: "api.openai.com", expiresAt: null, displayName: "API" }] },
    { ...input, session: { ...input.session, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 } } },
  ]) expect(() => parseNativeExecutionInput(changed)).toThrow();
});

it.each(["openai_dot", "grok_bot"] as const)("admits the %s descriptor without a broker or process startup", async provider => {
  const input = execution("/synthetic/pinned-instructions", provider);
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner");
  try {
    const descriptor = await describeRunnerdNativeSessionBackend(input);
    const backend = createNativeSessionBackend(input, {
      dotRunnerOptions: {
        stateDirectory: "/must-not-be-created",
        identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
          normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn", itemId: "item" },
        port: {
          dispatch: async () => { throw new Error("Descriptor must not dispatch work"); },
          settle: async () => { throw new Error("Descriptor must not settle work"); },
          attach: async () => { throw new Error("Descriptor must not attach a broker"); },
        },
      },
    });
    expect(descriptor).toEqual(await backend.descriptor());
    expect(descriptor).toMatchObject({
      kind: "runner", name: provider === "grok_bot" ? "grok_bot_mcp" : "openai_dot_mcp", version: provider === "grok_bot" ? "grok-bot-mcp-v1" : "dot-mcp-v1",
      capabilities: { resume: false, steering: false, interruption: false, usage: false, dynamicTools: true, completionBoundary: "paperclip_work_session", providerTermination: "unavailable", providerTranscriptStreaming: false },
      runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  } finally { spawnSpy.mockRestore(); }
});

it.each([
  { kind: "shutdown", remote: false }, { kind: "unexpected exit", remote: false },
  { kind: "shutdown", remote: true }, { kind: "unexpected exit", remote: true },
])("classifies a real Rust $kind before the next command poll (remote=$remote)", async ({ kind, remote }) => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-exit-"));
  await writeFile(join(root, "AGENTS.md"), "Use only the synthetic counter.");
  const input = execution(root);
  let handle: controlPlane.RunnerProcessHandle | undefined;
  let exited = false;
  const spawn = controlPlane.spawnRunner;
  const spawnSpy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => {
    const process = spawn(options);
    // Managed monitors preserve process identity but have no OS exit status.
    handle = remote ? { ...process, completion: process.completion.then(result => ({ ...result, code: null })) } : process;
    void handle.completion.then(() => { exited = true; });
    return handle;
  });
  const getCommand = controlPlane.DurablePrpControlPlane.prototype.getCommand;
  const commandSpy = vi.spyOn(controlPlane.DurablePrpControlPlane.prototype, "getCommand").mockImplementation(function (id) {
    const command = getCommand.call(this, id);
    // Hold the SDK poll until the real process has exited. The authenticated
    // shutdown receipt and its ACK remain committed in the transport journal.
    if (id === "dot_shutdown" && command?.status === "completed" && !exited) return { ...command, status: "pending" };
    return command;
  });
  const driver = new RunnerdDotDriver({
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    port: { dispatch: async () => {}, settle: async () => {}, attach: async () => async () => {} },
  });
  let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
  try {
    session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
    if (kind === "shutdown") {
      await expect(session.close({ reason: "Test complete" })).resolves.toBeUndefined();
      expect(exited).toBe(true);
      expect((await handle!.completion).code).toBe(remote ? null : 0);
    } else {
      handle!.child.kill("SIGTERM");
      await handle!.completion;
      await expect(session.read!()).rejects.toThrow(
        /^dot_runner_process_exited_recovery_required: code=\S+ signal=\S+ disconnectedMs=(?:none|\d+)$/);
    }
  } finally {
    commandSpy.mockRestore(); spawnSpy.mockRestore();
    await session?.detachControllerForRestart?.();
    if (!exited) handle?.child.kill("SIGTERM");
    await handle?.completion;
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

it.each(["local", "local pending finish", "custom local directory", "external launcher", "grok external launcher", "external launcher empty controller"])("reattaches the %s Rust bridge without duplicate operations and refuses lost checkpoints", async launch => {
  const root = await mkdtemp(join(tmpdir(), "dot-driver-recovery-"));
  const longPayload = launch === "local";
  const instructions = longPayload ? "Use only the synthetic counter. ".repeat(250) + "INSTRUCTIONS-TAIL" : "Use only the synthetic counter.";
  const message = longPayload ? JSON.stringify({ history: "Old context. ".repeat(500), currentWake: "CURRENT-WAKE-TAIL" }) : "Read the synthetic counter.";
  const answer = longPayload ? "完整測試結果。".repeat(800) + "RESULT-TAIL" : "counter";
  await writeFile(join(root, "AGENTS.md"), instructions);
  const input = execution(root, launch === "grok external launcher" ? "grok_bot" : "openai_dot");
  let send: ((op: ExternalProviderOperation) => Promise<void>) | undefined;
  let spawned: { pid: number; processGroupId: number | null; startedAt: string } | undefined;
  let calls = 0;
  const settlements = new Map<string, unknown>();
  const dispatches: unknown[] = [];
  let controllerPort = 0;
  const emptyController = launch === "external launcher empty controller";
  const pendingFinish = launch === "local pending finish";
  const firstCompletion = vi.fn(() => new Promise<string>(() => {}));
  const recoveredCompletion = vi.fn(async () => "Completion accepted");
  let checkpoint: controlPlane.DurablePrpCheckpoint | undefined;
  const options: RunnerdDotDriverOptions = {
    execution: input, stateDirectory: join(root, "state"),
    identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
    runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
    onSpawn: process => { spawned = process; },
    controlPlaneRegistration: async authority => {
      if (emptyController) {
        authority.setCheckpointPersistence(async saved => { checkpoint = controlPlane.decodeDurablePrpCheckpoint(new Map(saved.records)); });
        await authority.flushCheckpoint();
      }
      await authority.start(controllerPort);
      controllerPort = Number(new URL(authority.connectUrl).port);
      return { connectUrl: authority.connectUrl, release: () => authority.stop() };
    },
    dynamicTools: [{ name: "synthetic_counter", description: "Read a synthetic counter", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    dynamicToolHandler: async () => ({ count: ++calls, answer }),
    ...(pendingFinish ? { completionFeedback: firstCompletion } : {}),
    port: { dispatch: async event => { dispatches.push(event); }, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
      attach: async callback => { send = callback; return async () => { send = undefined; }; } },
  };
  const runnerState = launch === "local" || pendingFinish ? join(root, "state/runner") : join(root, "external-runtime/runner");
  if (launch === "custom local directory") options.runnerStateDirectory = runnerState;
  if (launch.includes("external launcher")) {
    await mkdir(runnerState, { recursive: true });
    options.runnerStateDirectory = runnerState;
    options.readProviderState = async () => {
      try { return JSON.parse(await readFile(join(runnerState, "dot-provider-state.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    options.runnerProcessLauncher = spec => {
      if (emptyController) expect(Object.keys(JSON.parse(checkpoint!.records.get("header")!).state.tickets)).toHaveLength(1);
      expect(spec.environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(spec.args).toContain(runnerState);
      const child = spawn(spec.command, [...spec.args], { cwd: runnerState, env: spec.environment, stdio: "ignore" });
      const startedAt = new Date().toISOString();
      spawned = { pid: child.pid!, processGroupId: null, startedAt };
      return { child, startedAt, completion: new Promise((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
      }) };
    };
  }
  const driver = new RunnerdDotDriver(options);
  let session = await driver.openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
  const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
    requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
    normalizedSessionId: input.session.normalizedSessionId!, turnId: options.identity.turnId, assignmentRevision: 1,
    action, input: args, digest: externalOperationDigest(action, args),
  });
  try {
    await session.startTurn({ message: { role: "user", text: message } });
    await vi.waitFor(() => expect(dispatches[0]).toMatchObject({ payload: { text: message } }), { timeout: 10000 });
    if (longPayload) expect(dispatches[0]).toMatchObject({ payload: { instructions: expect.stringContaining("INSTRUCTIONS-TAIL") } });
    await send!(operation("accept", {}));
    const call = operation("tool", { name: "synthetic_counter", arguments: {} });
    await send!(call);
    await vi.waitFor(() => expect(settlements.get(call.requestId)).toMatchObject({ status: "completed", isError: false, result: { count: 1, answer } }), { timeout: 10000 });
    if (input.provider.kind === "grok_bot") {
      const renewal = operation("renew", { expiresAtUnixMs: Date.now() + 3600000 });
      await send!(renewal);
      await vi.waitFor(() => expect(settlements.get(renewal.requestId)).toMatchObject({ status: "renewed" }), { timeout: 10000 });
    }
    const finish = operation("tool", { name: "paperclip_finish", arguments: {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Read the counter",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    } });
    if (pendingFinish) {
      await send!(finish);
      await vi.waitFor(() => expect(firstCompletion).toHaveBeenCalledOnce(), { timeout: 10000 });
      expect(settlements.has(finish.requestId)).toBe(false);
    }
    const snapshot = await session.snapshot();
    expect(snapshot).toMatchObject({ providerSessionId: null, activeTurnId: options.identity.turnId, providerRecoveryPolicy: "same_session_only" });
    await session.detachControllerForRestart!();
    if (emptyController) {
      await rm(options.stateDirectory, { recursive: true });
      checkpoint!.restoreSessionDirectory(options.stateDirectory);
    }
    const recoveredDriver = new RunnerdDotDriver({ ...options,
      ...(pendingFinish ? { completionFeedback: recoveredCompletion } : {}),
      ...(emptyController ? { runnerBinary: join(root, "unavailable-old-runner"),
        runnerArtifact: { version: checkpoint!.runnerVersion, digest: checkpoint!.runnerDigest } } : {}),
      adoptExistingRunner: { ...spawned!, isAlive: () => true } });
    const recovered = await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    session = recovered.session!;
    if (pendingFinish) {
      expect(options.recoverSemanticToolInput).toBeUndefined();
      await vi.waitFor(() => expect(settlements.get(finish.requestId)).toMatchObject({ status: "completed", isError: false }), { timeout: 10000 });
      expect(recoveredCompletion).toHaveBeenCalledOnce();
      // The accepted completion tells the Dot what ends its turn; a chat reply does not.
      expect(settlements.get(finish.requestId)).toMatchObject({
        result: { accepted: true, feedback: expect.stringContaining("call paperclip_dot_finish") },
      });
      expect(firstCompletion).toHaveBeenCalledOnce();
    }
    await send!(call);
    expect(calls).toBe(1);
    expect(dispatches).toHaveLength(1);
    await session.interrupt!({ reason: "Synthetic test complete" });
    await session.close({ reason: "Synthetic test complete" });
    await rm(join(runnerState, "dot-provider-state.json"));
    expect(await recoveredDriver.recoverSession(snapshot, { signal: new AbortController().signal })).toMatchObject({ recovered: false });
  } finally {
    await session.close({ reason: "Test cleanup", force: true }).catch(() => {});
    if (spawned) { try { process.kill(spawned.pid, "SIGTERM"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 45000);

it.each(["read failure", "pending tool", "uncertain write", "oversized result"] as const)(
  "settles or fences a real Dot bridge after %s without replaying work", async mode => {
    const root = await mkdtemp(join(tmpdir(), "dot-settlement-"));
    await writeFile(join(root, "AGENTS.md"), "Use only synthetic tools.");
    const input = execution(root);
    let send!: (operation: ExternalProviderOperation) => Promise<void>;
    let handle!: controlPlane.RunnerProcessHandle;
    let settleRead!: (result: unknown) => void;
    const pending = new Promise(resolve => { settleRead = resolve; });
    const settlements = new Map<string, any>();
    const handler = vi.fn(async () => {
      if (mode === "uncertain write") throw new Error("private-effect-may-have-committed");
      if (mode === "oversized result") return { privateContent: "x".repeat(600_000) };
      if (mode === "pending tool") return pending;
      return { outcome: "failed", code: "paperclip_runner_tool_not_advertised" };
    });
    const spawn = controlPlane.spawnRunner;
    const spy = vi.spyOn(controlPlane, "spawnRunner").mockImplementation(options => (handle = spawn(options)));
    const options: RunnerdDotDriverOptions = {
      execution: input, stateDirectory: join(root, "state"), runnerBinary: resolve("runner/target/debug/paperclip-runnerd"),
      identity: { runnerInstanceId: randomUUID(), environmentLeaseId: randomUUID(), runId: input.binding.runId,
        normalizedSessionId: input.session.normalizedSessionId!, turnId: "turn-" + input.binding.runId, itemId: "item-" + input.binding.runId },
      dynamicTools: [{ name: "synthetic_tool", description: "Synthetic test only", inputSchema: { type: "object", properties: {} } }],
      dynamicToolHandler: handler,
      port: { dispatch: async () => {}, settle: async event => { settlements.set(String(event.payload.requestId), event.payload.outcome); },
        attach: async fn => { send = fn; return async () => {}; } },
    };
    const operation = (action: ExternalProviderOperation["action"], args: Record<string, unknown>): ExternalProviderOperation => ({
      requestId: randomUUID(), bindingId: input.provider.binding.bindingId, bindingGeneration: 1, runId: input.binding.runId,
      normalizedSessionId: input.session.normalizedSessionId!, turnId: options.identity.turnId, assignmentRevision: 1,
      action, input: args, digest: externalOperationDigest(action, args),
    });
    let session: Awaited<ReturnType<RunnerdDotDriver["openSession"]>> | undefined;
    try {
      session = await new RunnerdDotDriver(options).openSession({ runId: input.binding.runId, normalizedSessionId: input.session.normalizedSessionId! });
      await session.startTurn({ message: { role: "user", text: "Exercise the synthetic tool." } });
      await send(operation("accept", {}));
      const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Handled the tool outcome",
        completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
        evidence: [], verification: [], attentionRequests: [], artifacts: [] };
      const tool = operation("tool", { name: "synthetic_tool", arguments: {} });
      // Consume failures concurrently, before the control-plane callback can fire.
      const terminal = (async () => { try { for await (const _ of session!.events()) {} return null; } catch (error) { return error as Error; } })();
      await send(tool).catch(error => {
        if (!["uncertain write", "oversized result"].includes(mode)) throw error;
        expect(String(error)).toContain("dot_semantic_result_unresolved");
      });
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      if (mode === "uncertain write" || mode === "oversized result") {
        const failure = await terminal;
        expect(failure?.message).toContain("dot_semantic_result_unresolved");
        expect(failure?.message).not.toContain("private");
        expect(settlements.has(tool.requestId)).toBe(false);
        await expect(session.close({ reason: "Failure reconciliation", force: true })).rejects.toThrow("dot_runner_operation_rejected");
        expect((await handle.completion).code).toBe(0);
        const checkpoint = JSON.parse(await readFile(join(root, "state/runner/dot-provider-state.json"), "utf8"));
        expect(checkpoint.lifecycle).toBe("fenced");
        expect(checkpoint.tools.pending[tool.requestId]).toBeDefined();
      } else {
        if (mode === "pending tool") {
          await expect(send(operation("tool", { name: "paperclip_finish", arguments: result })))
            .rejects.toMatchObject({ externalRejectionReason: "Dot completion requires settled tool calls" });
          settleRead({ outcome: "failed" });
        }
        await vi.waitFor(() => expect(settlements.get(tool.requestId)).toMatchObject({ status: "completed", isError: true }));
        const completion = operation("tool", { name: "paperclip_finish", arguments: result });
        await send(completion);
        await vi.waitFor(() => expect(settlements.get(completion.requestId)).toMatchObject({ status: "completed", isError: false }));
        await send(operation("finish", { result }));
        expect(await terminal).toBeNull();
        await session.close({ reason: "Synthetic turn completed" });
        expect((await handle.completion).code).toBe(0);
      }
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      await session?.detachControllerForRestart?.();
      if (handle?.child.exitCode == null) handle?.child.kill("SIGTERM");
      await handle?.completion;
      await rm(root, { recursive: true, force: true });
    }
  }, 45000,
);

it("rejects a mismatched Grok driver before any provider state is attached", async () => {
  const input = execution("/synthetic/pinned-instructions", "grok_bot");
  expect(() => parseNativeExecutionInput({ ...input, session: { ...input.session, driverKind: "openai_dot_mcp" } })).toThrow();
  expect(() => parseNativeExecutionInput({ ...input, provider: { ...input.provider, kind: "unsupported_bot" } })).toThrow();
});

describe("external Runner failure diagnostics", () => {
  it.each([
    ["active connection lease expired; durable state is preserved", "lease_expired_requires_bootstrap"],
    ["runner_remote_process_exited lifecycle=running recoverableFailure=transport_reconnect_grace_exceeded", "transport_reconnect_grace_exceeded"],
    ["transport reconnect deadline elapsed; durable state is preserved", "transport_reconnect_deadline_exceeded"],
  ])("preserves the bounded failure reason from %s", (stderr, reason) => {
    expect(externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr }))
      .toContain(`reason=${reason}`);
  });
  it("does not disclose raw diagnostics or transport credentials", () => {
    const stderr = "Bearer qualification-secret https://private.example/path?ticket=qualification-secret UNKNOWN_REASON";
    expect(externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr }))
      .toBe("dot_runner_process_exited_recovery_required: code=null signal=null");
    const recognized = externalRunnerExitMessage({ code: null, signal: null, stdout: "", stderr: `connection lease expired ${stderr}` });
    expect(recognized).toContain("reason=lease_expired_requires_bootstrap");
    expect(recognized).not.toContain("qualification-secret");
    expect(recognized).not.toContain("private.example");
  });
});
