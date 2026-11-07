import { describe, expect, it } from "vitest";
import { pmWorkerPolicySchema, updatePmWorkerDocument, pmWorkerManagedBlock, renderPmWorkerPolicy, type PmWorkerPolicy } from "@paperclipai/shared";
import { assertPmWorkerSelection } from "./pm-coordination-policy.js";
import { workerModelChoices, workerPermissionChoices, workerSelectionOverrides, validateWorkerChoices } from "./pm-worker-options.js";

const workerId = "00000000-0000-4000-8000-000000000001";
const choiceId = "00000000-0000-4000-8000-000000000002";
const policy: PmWorkerPolicy = { version: 2, defaultSelectionId: choiceId, workers: [{ agentId: workerId, harness: "codex_local",
  selections: [{ id: choiceId, model: "gpt-6.1-sol", thinking: "high", permission: "approve-reads", speed: "fast" }] }] };
const scope = { agentId: "pm", companyId: "company", projectId: "project", workerRoot: "/project", delegation: policy };

describe("PM worker choices", () => {
  it("resolves an omitted choice and an explicit ID to the same pinned task config", () => {
    const defaults = assertPmWorkerSelection(scope, undefined, undefined);
    expect(defaults).toEqual(assertPmWorkerSelection(scope, workerId, { workerSelectionId: choiceId }));
    expect(defaults.adapterConfig).toMatchObject({ model: "gpt-6.1-sol", modelReasoningEffort: "high", fastMode: true,
      permissionMode: "approve-reads", dangerouslyBypassApprovalsAndSandbox: false });
    expect(() => assertPmWorkerSelection(scope, "pm", undefined)).toThrow();
    expect(() => assertPmWorkerSelection(scope, workerId, { workerSelectionId: "00000000-0000-4000-8000-000000000003" })).toThrow();
    expect(() => assertPmWorkerSelection(scope, workerId, { workerSelectionId: choiceId, adapterConfig: { env: { ESCALATE: "1" } } })).toThrow();
  });
  it("requires a real default and explicit permission", () => {
    expect(pmWorkerPolicySchema.safeParse(policy).success).toBe(true);
    expect(pmWorkerPolicySchema.safeParse({ ...policy, defaultSelectionId: workerId }).success).toBe(false);
    const invalid = structuredClone(policy); delete (invalid.workers[0]!.selections[0]! as Partial<typeof invalid.workers[0]["selections"][0]>).permission;
    expect(pmWorkerPolicySchema.safeParse(invalid).success).toBe(false);
  });
  it("uses provider-specific tuning and refuses unavailable catalog entries", () => {
    const models = workerModelChoices("codex_local", [{ id: "gpt-6.1-sol", label: "Sol" }]);
    const catalog = [{ agentId: workerId, name: "Codex", harness: "codex_local" as const, permissions: workerPermissionChoices({ engine: "acp" }), models }];
    expect(() => validateWorkerChoices(policy, catalog)).not.toThrow();
    for (const patch of [{ model: "missing" }, { thinking: "infinite" }, { permission: "default" }]) {
      const invalid = structuredClone(policy); Object.assign(invalid.workers[0]!.selections[0]!, patch);
      expect(() => validateWorkerChoices(invalid, catalog)).toThrow();
    }
    expect(workerPermissionChoices({ engine: "cli" })).toEqual(["default", "full-access"]);
    expect(workerPermissionChoices({ extraArgs: ["--yolo"] })).toEqual([]);
    const claude = workerSelectionOverrides("claude_local", { ...policy.workers[0]!.selections[0]!, permission: "deny-all", speed: "standard", thinking: null });
    expect(claude).toMatchObject({ effort: null, dangerouslySkipPermissions: false, permissionMode: "deny-all" });
    expect(claude).toMatchObject({ modelReasoningEffort: null, reasoningEffort: null, thinkingEffort: null });
  });
  it("replaces only the managed block and retains all surrounding instructions", () => {
    const original = "# WORKERS\nHandwritten isolation/review rules.\n";
    const first = updatePmWorkerDocument(original, policy);
    expect(first).toContain(original);
    const second = structuredClone(policy); second.workers[0]!.selections[0]!.thinking = "low";
    const updated = updatePmWorkerDocument(first + "\nHandwritten tail.\n", second);
    expect(updated).toContain(original); expect(updated).toContain("Handwritten tail.");
    expect(pmWorkerManagedBlock(updated)).toBe(renderPmWorkerPolicy(second));
    expect(() => pmWorkerManagedBlock(first + renderPmWorkerPolicy(policy))).toThrow("malformed");
  });
});
