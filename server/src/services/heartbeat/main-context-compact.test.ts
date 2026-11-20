import { describe, expect, it } from "vitest";
import { mainContextCompactPolicy } from "./main-context-compact.js";
const agent = { id: "main", adapterType: "ccpocket_bridge", adapterConfig: { role: "main" } };
const chat = { id: "chat", conversationAgentId: "main" };
describe("main Chat compaction policy", () => {
  it("defaults to 150K only for the assigned Bridge main Chat", () => {
    expect(mainContextCompactPolicy(agent, chat)).toEqual({ version: 1, issueId: "chat", agentId: "main", thresholdTokens: 150000 });
    expect(mainContextCompactPolicy(agent, { ...chat, conversationAgentId: "other" })).toBeNull();
    expect(mainContextCompactPolicy(agent, { id: "task" })).toBeNull();
    expect(mainContextCompactPolicy({ ...agent, adapterType: "codex_local" }, chat)).toBeNull();
    expect(mainContextCompactPolicy({ ...agent, adapterConfig: {} }, chat)).toBeNull();
  });
  it("retains an explicit zero and a configured threshold", () => {
    for (const value of [0, 250000]) expect(mainContextCompactPolicy({ ...agent,
      adapterConfig: { role: "main", mainContextCompactThresholdTokens: value } }, chat)?.thresholdTokens).toBe(value);
  });
  it("disables compaction for malformed settings without failing the run", () => {
    for (const value of [-1, 1.5, "150000", Infinity]) expect(mainContextCompactPolicy({ ...agent,
      adapterConfig: { role: "main", mainContextCompactThresholdTokens: value } }, chat)).toBeNull();
  });
});

