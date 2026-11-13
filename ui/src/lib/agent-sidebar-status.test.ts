import { describe, expect, it } from "vitest";
import {
  agentSidebarStatusAnnouncement,
  agentSidebarStatusLabel,
  agentSidebarStatusStyle,
  deriveChatWaitingForTaskAgentIds,
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

  describe("viewer-excluded PMs", () => {
    // A PM-bound agent the viewer excluded (stored preference) still has a
    // workspace binding, so it must be skipped by the derivation itself.
    const BOUND = [pm("pm-a", "project-a"), pm("pm-excluded", "project-a"), pm("pm-b", "project-b")];

    it("gives an excluded PM-bound agent no working status while its project's PMs keep theirs", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ projectId: "project-a" })],
        pmWorkspaces: BOUND,
        attentionItems: [],
        excludedAgentIds: ["pm-excluded"],
        now: NOW,
      });

      expect(result.get("pm-a")).toBe("working");
      expect(result.has("pm-excluded")).toBe(false);
      expect(result.has("pm-b")).toBe(false);
    });

    it("gives an excluded agent no needs_input status and no working status from its own run", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ agentId: "pm-excluded", projectId: null })],
        pmWorkspaces: BOUND,
        attentionItems: [item({ sourceKind: "approval", project: { id: "project-a" } })],
        excludedAgentIds: ["pm-excluded"],
        now: NOW,
      });

      expect(result.get("pm-a")).toBe("needs_input");
      expect(result.has("pm-excluded")).toBe(false);
    });

    it("shows every PM when the list is empty, null or absent", () => {
      const base = {
        liveRuns: [run({ projectId: "project-a" })],
        pmWorkspaces: BOUND,
        attentionItems: [],
        now: NOW,
      };

      for (const excludedAgentIds of [[], null, undefined]) {
        const result = deriveProjectPmSidebarStatus({ ...base, excludedAgentIds });
        expect(result.get("pm-a")).toBe("working");
        expect(result.get("pm-excluded")).toBe("working");
      }
    });

    it("skips an excluded agent in every project it is bound to and ignores unknown excluded ids", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ projectId: "project-a" }), run({ projectId: "project-b" })],
        pmWorkspaces: [pm("pm-multi", "project-a"), pm("pm-multi", "project-b"), pm("pm-b", "project-b")],
        attentionItems: [],
        excludedAgentIds: ["pm-multi", "agent-not-in-this-company"],
        now: NOW,
      });

      expect([...result.entries()]).toEqual([["pm-b", "working"]]);
    });
  });

  describe("own-run status for listed non-PM agents (selfRunAgentIds)", () => {
    it("marks a listed main agent working for its own running run, without any PM workspaces", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ agentId: "main-a", projectId: "project-a" }), run({ agentId: "worker-1", projectId: "project-a" })],
        pmWorkspaces: [],
        attentionItems: [item({ project: { id: "project-a" } })],
        selfRunAgentIds: ["main-a", "main-b"],
        now: NOW,
      });

      // Only its own run counts: no project attribution and no needs_input.
      expect([...result.entries()]).toEqual([["main-a", "working"]]);
    });

    it("clears when the run is queued, waiting for an answer or no longer live", () => {
      for (const liveRuns of [
        [run({ agentId: "main-a", status: "queued" })],
        [run({ agentId: "main-a", execution: { phase: "waiting_for_answer" } })],
        [run({ agentId: "main-a", status: "succeeded" })],
        [run({ agentId: "main-a", status: "failed" })],
        [],
      ]) {
        const result = deriveProjectPmSidebarStatus({ liveRuns, pmWorkspaces: [], attentionItems: [], selfRunAgentIds: ["main-a"], now: NOW });
        expect(result.size).toBe(0);
      }
    });

    it("counts a just-started run patched from queued to running", () => {
      const queued = [run({ id: "run-m", agentId: "main-a", status: "queued", execution: { phase: "queued" } })] as never;
      const { next } = patchRunStatusInList(queued, "run-m", "running");
      const result = deriveProjectPmSidebarStatus({ liveRuns: next, pmWorkspaces: [], attentionItems: [], selfRunAgentIds: ["main-a"], now: NOW });
      expect(result.get("main-a")).toBe("working");
    });

    it("honors the viewer's exclusions and ignores agents that are not listed", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ agentId: "momo" }), run({ agentId: "main-a" }), run({ agentId: "unlisted" })],
        pmWorkspaces: [],
        attentionItems: [],
        excludedAgentIds: ["momo"],
        selfRunAgentIds: ["momo", "main-a"],
        now: NOW,
      });

      expect([...result.entries()]).toEqual([["main-a", "working"]]);
    });

    it("leaves PM-bound agents on the project rules, including terminated and excluded bindings", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [run({ agentId: "pm-old", projectId: null }), run({ agentId: "pm-excluded", projectId: null })],
        pmWorkspaces: [pm("pm-old", "project-a", "terminated"), pm("pm-excluded", "project-b"), pm("pm-a", "project-a")],
        attentionItems: [item({ project: { id: "project-a" } })],
        excludedAgentIds: ["pm-excluded"],
        selfRunAgentIds: ["pm-old", "pm-excluded", "pm-a"],
        now: NOW,
      });

      expect([...result.entries()]).toEqual([["pm-a", "needs_input"]]);
    });
  });

  describe("approval items as the attention feed returns them", () => {
    // Shape of an approval row from the real GET /attention response after the
    // server carries the linked task's project: the nested project object
    // `issueContext` produces, not a hand-made { id } stub.
    it("reads the project of a pending approval from the nested project object", () => {
      const approval = item({
        sourceKind: "approval",
        project: { id: "project-b", name: "Beta", urlKey: "beta", color: null, icon: null },
        relatedIssue: { id: "issue-1", identifier: "BET-1", title: "Pick a vendor" },
      });

      const result = deriveProjectPmSidebarStatus({
        liveRuns: [],
        pmWorkspaces: PMS,
        attentionItems: [approval],
        now: NOW,
      });

      expect(result.get("pm-b")).toBe("needs_input");
    });

    it("cannot place an approval whose project the server left null", () => {
      const result = deriveProjectPmSidebarStatus({
        liveRuns: [],
        pmWorkspaces: PMS,
        attentionItems: [item({ sourceKind: "approval", project: null, relatedIssue: null })],
        now: NOW,
      });

      expect(result.size).toBe(0);
    });
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
    expect(agentSidebarStatusLabel("needs_input")).toBe("needs input");
    expect(agentSidebarStatusAnnouncement("working")).toBe("working");
    expect(agentSidebarStatusAnnouncement("needs_input")).toBe("needs input");
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
    expect(agentSidebarStatusStyle("waiting_for_task").pulse).toBeUndefined();
  });

  it("frames and tints waiting for task with the violet sidebar tokens only", () => {
    expect(agentSidebarStatusLabel("waiting_for_task")).toBe("waiting for task");
    expect(agentSidebarStatusAnnouncement("waiting_for_task")).toBe("waiting for task");
    const waiting = agentSidebarStatusStyle("waiting_for_task");
    expect(waiting.frame).toBe("ring-1 ring-inset ring-(--sidebar-waiting-frame) bg-(--sidebar-waiting-background)");
    expect(waiting.text).toBe("text-(--sidebar-waiting-accent)");
    expect(waiting.dot).toBe("bg-(--sidebar-waiting-accent)");
    for (const value of [waiting.frame, waiting.text, waiting.dot]) {
      expect(value).not.toMatch(/blue-|orange-|\[/);
    }
  });
});

describe("deriveChatWaitingForTaskAgentIds", () => {
  const chat = (conversationAgentId: string | null, hasLiveChildTasks?: boolean) => ({ conversationAgentId, hasLiveChildTasks });

  it("marks agents whose chat has live tasks", () => {
    expect([...deriveChatWaitingForTaskAgentIds({
      chats: [chat("main-a", true), chat("main-b", false), chat("main-c"), chat(null, true)],
      liveRuns: [],
    })]).toEqual(["main-a"]);
  });

  it("keeps the working indicator while the agent itself works", () => {
    const chats = [chat("main-a", true)];
    expect(deriveChatWaitingForTaskAgentIds({ chats, liveRuns: [run({ agentId: "main-a" })] }).size).toBe(0);
    // A queued own run, or one waiting for an answer, is not work: the chat still waits for its task.
    for (const own of [run({ agentId: "main-a", status: "queued" }), run({ agentId: "main-a", execution: { phase: "waiting_for_answer" } })]) {
      expect([...deriveChatWaitingForTaskAgentIds({ chats, liveRuns: [own] })]).toEqual(["main-a"]);
    }
    // Workers running the chat's tasks never suppress it.
    expect([...deriveChatWaitingForTaskAgentIds({ chats, liveRuns: [run({ agentId: "worker-1" })] })]).toEqual(["main-a"]);
  });

  it("tolerates missing chats and live runs", () => {
    expect(deriveChatWaitingForTaskAgentIds({ chats: undefined, liveRuns: undefined }).size).toBe(0);
    expect([...deriveChatWaitingForTaskAgentIds({ chats: [chat("main-a", true)], liveRuns: null })]).toEqual(["main-a"]);
  });
});
