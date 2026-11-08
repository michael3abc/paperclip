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
      steps: [], currentStep: null, lastToolName: null, lastAssistantText: null, subagents: [], context: null,
    });
  });

  it("keeps the latest context fill and a running subagent's activity", () => {
    const usage = (ts: string, currentTokens: unknown): TranscriptEntry => ({ kind: "provider_activity", ts, family: "context", eventType: "context.usage",
      status: "completed", title: "Context", summary: "", payload: { usageId: "context-usage", currentTokens, modelContextWindow: 1_000_000 } });
    const work = deriveMainAgentWork([
      usage("1", 42_000),
      delegation("2", "running", { delegationId: "a", description: "Audit API", activity: "Reading routes" }),
      usage("3", 251_000),
      usage("4", "bad"),
      delegation("5", "running", { delegationId: "b", description: "Check UI", activity: "Scanning" }),
      delegation("6", "completed", { delegationId: "b", description: "Check UI", activity: "Scanning" }, "Done"),
    ]);
    expect(work.context).toEqual({ used: 251_000, window: 1_000_000, percent: 25 });
    expect(work.subagents.map((s) => [s.id, s.activity])).toEqual([["a", "Reading routes"], ["b", null]]);
  });

  it("rebuilds Claude task-list steps from tool calls even when a cached plan activity is partial", () => {
    const call = (ts: string, name: string, input: unknown, toolUseId?: string): TranscriptEntry => ({ kind: "tool_call", ts, name, input, toolUseId });
    const result = (ts: string, toolUseId: string, content: string, isError = false): TranscriptEntry => ({ kind: "tool_result", ts, toolUseId, content, isError });
    const work = deriveMainAgentWork([
      call("1", "TaskCreate", { subject: "Frontend survey" }, "u1"),
      result("2", "u1", "Task #5 created successfully: Frontend survey"),
      call("3", "TaskCreate", { subject: "Backend survey", activeForm: "Surveying backend" }, "u2"),
      result("4", "u2", "Task #6 created successfully: Backend survey"),
      call("5", "TaskCreate", { subject: "Broken" }, "u3"),
      result("6", "u3", "Error", true),
      call("7", "TaskCreate", { subject: "Summarize" }, "u4"),
      result("8", "u4", "Task #7 created successfully: Summarize"),
      call("9", "TaskUpdate", { taskId: "5", status: "completed" }),
      call("10", "TaskUpdate", { taskId: 6, status: "in_progress" }),
      // A plan activity first parsed for a tail-only window only knows tasks 6 and 7.
      { kind: "provider_activity", ts: "11", family: "plan", eventType: "plan.updated", status: "running", title: "Todo", summary: "",
        payload: { planId: "todo", steps: [{ stepId: "task:6", body: "Task #6", status: "in_progress" }, { stepId: "task:7", body: "Task #7", status: "pending" }] } },
    ]);
    expect(work.steps.map((step) => [step.id, step.body, step.status])).toEqual([
      ["task:5", "Frontend survey", "completed"], ["task:6", "Surveying backend", "in_progress"], ["task:7", "Summarize", "pending"],
    ]);
    expect(work.currentStep).toBe("Surveying backend");
  });

  it("uses the latest TodoWrite list and keeps a subagent named by its start event", () => {
    const work = deriveMainAgentWork([
      { kind: "tool_call", ts: "1", name: "TodoWrite", input: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", activeForm: "Fixing", status: "in_progress" }] } },
      delegation("2", "running", { delegationId: "a", action: "started", description: "Survey routes", subagentType: "Explore" }),
      delegation("3", "running", { delegationId: "a", action: "progress", description: "Running cd /repo…", activity: "Running cd /repo…" }),
      delegation("4", "running", { delegationId: "b", action: "progress", subagentType: "Explore", activity: "Reading a.ts" }),
    ]);
    expect(work.steps.map((step) => [step.body, step.status])).toEqual([["Read", "completed"], ["Fixing", "in_progress"]]);
    expect(work.subagents.map((s) => [s.id, s.title])).toEqual([["a", "Survey routes"], ["b", "Explore"]]);
  });
});
