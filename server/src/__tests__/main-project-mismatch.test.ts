import { describe, expect, it } from "vitest";
import { mainProjectMismatch } from "../services/main-agent-workers.js";

const PROJECT = "9d3d5973-50f4-4341-a725-9203aa440502";
const OTHER = "dc7245ad-9dd7-41cf-9fbc-7690a14ed0c3";
const main = { id: "agent-main", companyId: "c", adapterType: "ccpocket_bridge", adapterConfig: { role: "main", projectId: PROJECT } };

describe("mainProjectMismatch", () => {
  it("returns the main's project when the issue belongs to another project", () => {
    expect(mainProjectMismatch(main, { projectId: OTHER })).toBe(PROJECT);
    expect(mainProjectMismatch(main, { projectId: null })).toBe(PROJECT);
  });

  it("accepts a task of the main's own project", () => {
    expect(mainProjectMismatch(main, { projectId: PROJECT })).toBeNull();
  });

  it("accepts the main's own conversation whatever its project", () => {
    expect(mainProjectMismatch(main, { projectId: null, conversationAgentId: main.id })).toBeNull();
    expect(mainProjectMismatch(main, { projectId: OTHER, conversationAgentId: "someone-else" })).toBe(PROJECT);
  });

  it("ignores agents that are not project mains", () => {
    expect(mainProjectMismatch({ ...main, adapterConfig: { role: "main" } }, { projectId: OTHER })).toBeNull();
    expect(mainProjectMismatch({ ...main, adapterConfig: { projectId: PROJECT } }, { projectId: OTHER })).toBeNull();
    expect(mainProjectMismatch({ ...main, adapterType: "claude_local" }, { projectId: OTHER })).toBeNull();
  });
});
