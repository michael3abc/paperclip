import { describe, expect, it } from "vitest";
import {
  agentSidebarStatusAnnouncement,
  agentSidebarStatusLabel,
  agentSidebarStatusStyle,
  deriveProjectPmSidebarStatus,
  isOwnerInputRequest,
  isWorkingLiveRun,
} from "./agent-sidebar-status";
import { patchRunStatusInList } from "./live-runs-cache";

const NOW = Date.parse("2026-11-08T00:00:00Z");

type RunInput = Parameters<typeof deriveProjectPmSidebarStatus>[0]["liveRuns"];
type PmInput = Parameters<typeof deriveProjectPmSidebarStatus>[0]["pmWorkspaces"];
type ItemInput = Parameters<typeof deriveProjectPmSidebarStatus>[0]["attentionItems"];

function run(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "worker-1",
    status: "running",
    projectId: "project-a",
    ...overrides,
  } as NonNullable<RunInput>[number];
}

function pm(agentId: string, projectId: string, status = "active") {
  return { agentId, projectId, status } as NonNullable<PmInput>[number];
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    sourceKind: "issue_thread_interaction",
    project: { id: "project-a" },
    shelf: false,
    archivedAt: null,
    dismissal: null,
    snoozedUntil: null,
    ...overrides,
  } as NonNullable<ItemInput>[number];
}

const PMS: PmInput = [pm("pm-a", "project-a"), pm("pm-b", "project-b")];

describe("isWorkingLiveRun", () => {
  it.each(["working", "waiting_for_provider", "reconnecting", "finishing"])(
    "counts a running run in the %s phase as working",
    (phase) => {
      expect(isWorkingLiveRun({ status: "running", execution: { phase } as never })).toBe(true);
    },
  );

  it.each(["retry_scheduled", "recovery_needed", "waiting_for_access", "waiting_for_answer"])(
    "does not count the %s phase as working",
    (phase) => {
      expect(isWorkingLiveRun({ status: "running", execution: { phase } as never })).toBe(false);
    },
  );

  it("counts a just-started run whose cached projection still says queued", () => {
    // `heartbeat.run.status` only patches `status`; the "queued" projection fetched earlier is stale.
    expect(isWorkingLiveRun({ status: "running", execution: { phase: "queued" } as never })).toBe(true);
  });

  it("does not count a queued run, whatever its projection says", () => {
    expect(isWorkingLiveRun({ status: "queued", execution: { phase: "working" } as never })).toBe(false);
    expect(isWorkingLiveRun({ status: "queued" })).toBe(false);
  });

  it("treats a running run without an execution projection as working", () => {
    expect(isWorkingLiveRun({ status: "running" })).toBe(true);
  });
});

describe("isOwnerInputRequest", () => {
  it.each(["issue_thread_interaction", "approval", "decision"])("accepts %s items", (sourceKind) => {
    expect(isOwnerInputRequest(item({ sourceKind }), NOW)).toBe(true);
  });

  it.each([
    "review",
    "failed_run",
    "blocker_attention",
    "budget_alert",
    "agent_error_alert",
    "join_request",
    "recovery_action",
    "productivity_review",
  ])("rejects %s items, which need attention rather than an answer", (sourceKind) => {
    expect(isOwnerInputRequest(item({ sourceKind }), NOW)).toBe(false);
  });

  it("rejects archived, shelved and actively dismissed items", () => {
    expect(isOwnerInputRequest(item({ archivedAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isOwnerInputRequest(item({ shelf: true }), NOW)).toBe(false);
    expect(isOwnerInputRequest(item({ dismissal: { isActive: true } }), NOW)).toBe(false);
  });

  it("keeps items whose dismissal is no longer active", () => {
    expect(isOwnerInputRequest(item({ dismissal: { isActive: false } }), NOW)).toBe(true);
  });

  it("rejects items snoozed into the future and keeps expired snoozes", () => {
    expect(isOwnerInputRequest(item({ snoozedUntil: "2026-11-09T00:00:00Z" }), NOW)).toBe(false);
    expect(isOwnerInputRequest(item({ snoozedUntil: "2026-11-07T00:00:00Z" }), NOW)).toBe(true);
  });

  it("ignores an unparseable snooze instead of hiding the request", () => {
    expect(isOwnerInputRequest(item({ snoozedUntil: "not-a-date" }), NOW)).toBe(true);
  });
});

describe("deriveProjectPmSidebarStatus", () => {
  it("marks every PM of the run's project as working, even when the worker is another agent", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [run({ agentId: "shared-claude", projectId: "project-a" })],
      pmWorkspaces: PMS,
      attentionItems: [],
      now: NOW,
    });

    expect(result.get("pm-a")).toBe("working");
    expect(result.has("pm-b")).toBe(false);
    expect(result.has("shared-claude")).toBe(false);
  });

  it("attributes subtask runs through the project of their own task", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [
        run({ agentId: "shared-codex", projectId: "project-b", issueId: "subtask-of-a-task-in-project-a" }),
      ],
      pmWorkspaces: PMS,
      attentionItems: [],
      now: NOW,
    });

    expect(result.get("pm-b")).toBe("working");
    expect(result.has("pm-a")).toBe(false);
  });

  it("marks a PM working for its own running run even without a project", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [run({ agentId: "pm-b", projectId: null })],
      pmWorkspaces: PMS,
      attentionItems: [],
      now: NOW,
    });

    expect(result.get("pm-b")).toBe("working");
  });

  it("does not attribute a run it cannot place in a project", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [run({ projectId: undefined }), run({ projectId: null })],
      pmWorkspaces: PMS,
      attentionItems: [],
      now: NOW,
    });

    expect(result.size).toBe(0);
  });

  it("does not mark queued runs or non-working phases", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [
        run({ status: "queued" }),
        run({ execution: { phase: "retry_scheduled" } }),
        run({ execution: { phase: "waiting_for_answer" } }),
      ],
      pmWorkspaces: PMS,
      attentionItems: [],
      now: NOW,
    });

    expect(result.size).toBe(0);
  });

  it("turns the PM working when a queued run starts through the live-event cache patch", () => {
    // Real flow: the run is fetched as queued (server projection phase "queued"), then the
    // `heartbeat.run.status` event patches only its status to "running".
    const queued = [run({ id: "run-1", status: "queued", execution: { phase: "queued" } })] as never;
    const before = deriveProjectPmSidebarStatus({ liveRuns: queued, pmWorkspaces: PMS, attentionItems: [], now: NOW });
    expect(before.size).toBe(0);

    const { next, present } = patchRunStatusInList(queued, "run-1", "running");
    expect(present).toBe(true);
    const after = deriveProjectPmSidebarStatus({ liveRuns: next, pmWorkspaces: PMS, attentionItems: [], now: NOW });
    expect(after.get("pm-a")).toBe("working");
  });

  it("marks a PM as needing input for an owner-input request of its project", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [],
      pmWorkspaces: PMS,
      attentionItems: [item({ sourceKind: "approval", project: { id: "project-b" } })],
      now: NOW,
    });

    expect(result.get("pm-b")).toBe("needs_input");
    expect(result.has("pm-a")).toBe(false);
  });

  it("lets needs_input override working regardless of input order", () => {
    const input = {
      pmWorkspaces: PMS,
      now: NOW,
    };
    const liveRuns = [run({ projectId: "project-a" })];
    const attentionItems = [item({ project: { id: "project-a" } })];

    expect(
      deriveProjectPmSidebarStatus({ ...input, liveRuns, attentionItems }).get("pm-a"),
    ).toBe("needs_input");
    expect(
      deriveProjectPmSidebarStatus({ ...input, liveRuns: [...liveRuns].reverse(), attentionItems }).get("pm-a"),
    ).toBe("needs_input");
  });

  it("ignores attention items that are not input requests or are hidden", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [],
      pmWorkspaces: PMS,
      attentionItems: [
        item({ sourceKind: "review" }),
        item({ sourceKind: "failed_run" }),
        item({ shelf: true }),
        item({ archivedAt: "2026-11-01T00:00:00Z" }),
        item({ dismissal: { isActive: true } }),
        item({ snoozedUntil: "2026-11-09T00:00:00Z" }),
      ],
      now: NOW,
    });

    expect(result.size).toBe(0);
  });

  it("ignores attention items without a project", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [],
      pmWorkspaces: PMS,
      attentionItems: [item({ project: null })],
      now: NOW,
    });

    expect(result.size).toBe(0);
  });

  it("never reports agents that are not a project PM", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [run({ agentId: "momo", projectId: "project-a" })],
      pmWorkspaces: PMS,
      attentionItems: [item({ project: { id: "project-a" } })],
      now: NOW,
    });

    expect([...result.keys()]).toEqual(["pm-a"]);
  });

  it("skips terminated PMs", () => {
    const result = deriveProjectPmSidebarStatus({
      liveRuns: [run({ projectId: "project-a" })],
      pmWorkspaces: [pm("pm-old", "project-a", "terminated"), pm("pm-a", "project-a")],
      attentionItems: [item({ project: { id: "project-a" } })],
      now: NOW,
    });

    expect(result.has("pm-old")).toBe(false);
    expect(result.get("pm-a")).toBe("needs_input");
  });

  it("returns nothing without PM workspaces", () => {
    expect(
      deriveProjectPmSidebarStatus({
        liveRuns: [run()],
        pmWorkspaces: undefined,
        attentionItems: [item()],
        now: NOW,
      }).size,
    ).toBe(0);
    expect(
      deriveProjectPmSidebarStatus({
        liveRuns: [run()],
        pmWorkspaces: [],
        attentionItems: [item()],
        now: NOW,
      }).size,
    ).toBe(0);
  });

  it("tolerates missing live runs and attention items", () => {
    expect(
      deriveProjectPmSidebarStatus({
        liveRuns: undefined,
        pmWorkspaces: PMS,
        attentionItems: undefined,
        now: NOW,
      }).size,
    ).toBe(0);
  });
});

describe("agent sidebar status presentation", () => {
  it("labels working in English and the input request in Chinese", () => {
    expect(agentSidebarStatusLabel("working")).toBe("working");
    expect(agentSidebarStatusLabel("needs_input")).toBe("需要你輸入");
    expect(agentSidebarStatusAnnouncement("working")).toBe("working");
    expect(agentSidebarStatusAnnouncement("needs_input")).toBe("needs your input");
  });

  it("keeps blue for working and orange for needs_input across frame, text and dot", () => {
    const working = agentSidebarStatusStyle("working");
    const needsInput = agentSidebarStatusStyle("needs_input");

    for (const value of [working.frame, working.text, working.dot]) {
      expect(value).toContain("blue-");
      expect(value).not.toContain("orange-");
    }
    for (const value of [needsInput.frame, needsInput.text, needsInput.dot]) {
      expect(value).toContain("orange-");
      expect(value).not.toContain("blue-");
    }
  });

  it("pulses only the working dot", () => {
    expect(agentSidebarStatusStyle("working").pulse).toContain("animate-pulse");
    expect(agentSidebarStatusStyle("needs_input").pulse).toBeUndefined();
  });
});
