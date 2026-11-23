import { afterEach, describe, expect, it, vi } from "vitest";
import { agentIssueMonitorsDisabled, assertCanManageIssueMonitor } from "./issue-monitors.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const allow = { decide: vi.fn(async () => ({ allowed: true, reason: "allow", explanation: "ok" })) };
const agentReq = { actor: { type: "agent", agentId, companyId } } as never;
const boardReq = { actor: { type: "board", userId: "owner" } } as never;

describe("agent issue monitor host flag", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_AGENT_ISSUE_MONITORS;
  });

  it("is off unless the host sets disabled", () => {
    expect(agentIssueMonitorsDisabled({})).toBe(false);
    expect(agentIssueMonitorsDisabled({ PAPERCLIP_AGENT_ISSUE_MONITORS: "disabled" })).toBe(true);
  });

  it("keeps the assignee agent's scheduling when the flag is unset", async () => {
    await expect(assertCanManageIssueMonitor(allow as never, agentReq, companyId, agentId, true)).resolves.toBeUndefined();
  });

  it("rejects an agent schedule or trigger when disabled, before the access decision", async () => {
    process.env.PAPERCLIP_AGENT_ISSUE_MONITORS = "disabled";
    const decide = vi.fn(allow.decide);
    await expect(assertCanManageIssueMonitor({ decide } as never, agentReq, companyId, agentId, true))
      .rejects.toMatchObject({ status: 403, details: { reason: "agent_issue_monitors_disabled" } });
    expect(decide).not.toHaveBeenCalled();
  });

  it("still lets the assignee agent clear its monitor when disabled", async () => {
    process.env.PAPERCLIP_AGENT_ISSUE_MONITORS = "disabled";
    await expect(assertCanManageIssueMonitor(allow as never, agentReq, companyId, agentId, true, undefined, true))
      .resolves.toBeUndefined();
  });

  it("leaves board users and unchanged monitors alone when disabled", async () => {
    process.env.PAPERCLIP_AGENT_ISSUE_MONITORS = "disabled";
    await expect(assertCanManageIssueMonitor(allow as never, boardReq, companyId, agentId, true)).resolves.toBeUndefined();
    await expect(assertCanManageIssueMonitor(allow as never, agentReq, companyId, agentId, false)).resolves.toBeUndefined();
  });
});
