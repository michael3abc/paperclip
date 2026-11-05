import { describe, expect, it } from "vitest";
import { agentIdsWithRunningWork, type AgentActivityIssue } from "./agent-activity";

const issue = (id: string, status: string, assigneeAgentId: string | null, parentId: string | null = null) =>
  ({ id, status, assigneeAgentId, parentId }) as AgentActivityIssue;
const none = new Set<string>();

describe("agentIdsWithRunningWork", () => {
  it("counts the assignee of an in-progress issue", () => {
    expect([...agentIdsWithRunningWork([issue("a", "in_progress", "pm")], none)]).toEqual(["pm"]);
  });

  it("ignores issues that are not in progress", () => {
    const issues = [issue("a", "todo", "x"), issue("b", "blocked", "y"), issue("c", "in_review", "z")];
    expect(agentIdsWithRunningWork(issues, none).size).toBe(0);
  });

  it("credits every ancestor's assignee for a running sub-task", () => {
    const issues = [
      issue("root", "blocked", "ceo"),
      issue("mid", "blocked", "pm", "root"),
      issue("leaf", "in_progress", "worker", "mid"),
    ];
    expect([...agentIdsWithRunningWork(issues, none)].sort()).toEqual(["ceo", "pm", "worker"]);
  });

  it("credits the parent's agent even when the running child is unassigned", () => {
    const issues = [issue("parent", "blocked", "pm"), issue("child", "in_progress", null, "parent")];
    expect([...agentIdsWithRunningWork(issues, none)]).toEqual(["pm"]);
  });

  it("does not credit siblings or descendants of a running issue", () => {
    const issues = [
      issue("parent", "blocked", "pm"),
      issue("running", "in_progress", "a", "parent"),
      issue("sibling", "todo", "b", "parent"),
      issue("below", "todo", "c", "running"),
    ];
    expect([...agentIdsWithRunningWork(issues, none)].sort()).toEqual(["a", "pm"]);
  });

  it("skips ignored issues as starting points", () => {
    const issues = [issue("chat", "in_progress", "amy"), issue("task", "in_progress", "zed")];
    expect([...agentIdsWithRunningWork(issues, new Set(["chat"]))]).toEqual(["zed"]);
  });

  it("stops on a cyclic parent chain", () => {
    const issues = [issue("a", "in_progress", "x", "b"), issue("b", "blocked", "y", "a")];
    expect([...agentIdsWithRunningWork(issues, none)].sort()).toEqual(["x", "y"]);
  });

  it("tolerates a parent that was not fetched", () => {
    expect([...agentIdsWithRunningWork([issue("a", "in_progress", "x", "missing")], none)]).toEqual(["x"]);
  });
});
