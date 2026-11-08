import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import { deriveMainAgentWork } from "./main-agent-work";

const delegation = (ts: string, status: "running" | "completed" | "failed", payload: Record<string, unknown>, summary = ""): TranscriptEntry => ({
  kind: "provider_activity", ts, family: "delegation", eventType: "delegation.updated", status, title: "Subagent", summary, payload,
});

describe("deriveMainAgentWork", () => {
  it("returns the in-progress checklist step, last tool and assistant text", () => {
    const work = deriveMainAgentWork([
      { kind: "assistant", ts: "1", text: "Looking at the repo" },
      { kind: "tool_call", ts: "2", name: "TodoWrite", input: {} },
      { kind: "provider_activity", ts: "2", family: "plan", eventType: "plan.updated", status: "running", title: "Todo", summary: "",
        payload: { planId: "todo", steps: [
          { stepId: "todo:0", body: "Read code", status: "completed" },
          { stepId: "todo:1", body: "Writing tests", status: "in_progress" },
          { stepId: "todo:2", body: "", status: "pending" },
          { stepId: "todo:3", body: "Ship", status: "weird" },
        ] } },
      { kind: "tool_call", ts: "3", name: "Bash", input: {} },
      { kind: "assistant", ts: "4", text: "partial", delta: true },
    ]);
    expect(work.currentStep).toBe("Writing tests");
    expect(work.steps.map((step) => [step.body, step.status])).toEqual([["Read code", "completed"], ["Writing tests", "in_progress"], ["Ship", "pending"]]);
    expect(work.lastToolName).toBe("Bash");
    expect(work.lastAssistantText).toBe("Looking at the repo");
  });

  it("merges delegation updates per subagent in first-seen order", () => {
    const work = deriveMainAgentWork([
      delegation("t1", "running", { delegationId: "a", description: "Audit API", subagentType: "Explore" }),
      delegation("t2", "running", { delegationId: "b", description: "Check UI" }),
      delegation("t3", "running", { delegationId: "a", description: "Audit API", subagentType: "Explore", lastToolName: "Grep" }),
      delegation("t4", "completed", { delegationId: "a", description: "Audit API", subagentType: "Explore", lastToolName: "Read",
        usage: { totalTokens: 1200, toolUses: 4 } }, "Found 2 issues"),
      delegation("t5", "failed", { delegationId: "b", description: "Check UI" }, "Timed out"),
      delegation("t6", "running", { description: "no id" }),
    ]);
    expect(work.subagents.map((s) => [s.id, s.status, s.summary])).toEqual([["a", "completed", "Found 2 issues"], ["b", "failed", "Timed out"]]);
    expect(work.subagents[0]).toMatchObject({ title: "Audit API", subagentType: "Explore", lastToolName: "Read", totalTokens: 1200, toolUses: 4, startedAt: "t1", updatedAt: "t4" });
  });

  it("is empty for transcripts without plan or delegation activity", () => {
    expect(deriveMainAgentWork([{ kind: "stdout", ts: "1", text: "hello" }])).toEqual({
      steps: [], currentStep: null, lastToolName: null, lastAssistantText: null, subagents: [],
    });
  });
});
