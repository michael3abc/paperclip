import { describe, expect, it } from "vitest";
import { assertPmTool, assertPmWorkerSelection, pmCoordinationScope } from "./pm-coordination-policy.js";
import { agentChatDirective, AGENT_CHAT_DIRECTIVE } from "./agent-conversations.js";

const pmId = "00000000-0000-4000-8000-000000000001";
const workerId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const agent = (slots = 0) => ({ id: pmId, companyId: "company", runtimeConfig: {
  workspaceBinding: { mode: "project_pm", projectId, workerRoot: "/project", workerSlots: slots, workerIsolation: "shared" },
  pmDelegation: { version: 1, workers: [{ agentId: workerId, selections: [{ model: "exact-model", effort: "high" }] }] },
} });

describe("PM coordination capability boundary", () => {
  it("derives the role from the saved binding, not its label or a tool request", () => {
    expect(pmCoordinationScope(agent())?.projectId).toBe(projectId);
    expect(pmCoordinationScope(agent(1))).toBeNull();
    expect(pmCoordinationScope({ id: workerId, companyId: "company", runtimeConfig: {} })).toBeNull();
    expect(() => pmCoordinationScope({ ...agent(), runtimeConfig: { workspaceBinding: { mode: "project_pm" } } })).toThrow();
  });
  it.each(["Bash", "Write", "Edit", "Agent", "workspace_run", "workspace_write", "update_agent_instructions", "restore_agent_instructions", "hire_agent", "decide_approval", "paperclip_connections", "app_fake_read_only"])("rejects %s regardless of provider approval", tool => {
    expect(() => assertPmTool(pmCoordinationScope(agent())!, tool)).toThrow();
  });
  it.each(["create_task", "resolve_review", "write_bundle_file", "read_bundle_file", "get_task", "request_human_input"])("retains bounded coordination: %s", tool => {
    expect(() => assertPmTool(pmCoordinationScope(agent())!, tool)).not.toThrow();
  });
  it("requires an explicit authorized worker and the exact model/effort selection", () => {
    const scope = pmCoordinationScope(agent())!;
    expect(assertPmWorkerSelection(scope, workerId, { adapterConfig: { model: "exact-model", effort: "high" } })).toEqual({ adapterConfig: { model: "exact-model", effort: "high" } });
    for (const [id, override] of [[undefined, {}], [pmId, {}], [workerId, {}],
      [workerId, { adapterConfig: { model: "different", effort: "high" } }],
      [workerId, { adapterConfig: { model: "exact-model", effort: "low" } }],
      [workerId, { adapterConfig: { model: "exact-model", effort: "high", env: { ANY: "value" } } }]]) {
      expect(() => assertPmWorkerSelection(scope, id, override)).toThrow();
    }
  });
  it("removes self-dispatch only for PM chat", () => {
    expect(agentChatDirective(false)).toBe(AGENT_CHAT_DIRECTIVE);
    expect(agentChatDirective(true)).not.toContain("Default the assignee to the agent in this conversation");
    expect(agentChatDirective(true)).toContain("Assign execution directly to an authorized shared worker");
    expect(agentChatDirective(true)).toContain("never subtasks of this conversation");
  });
});
