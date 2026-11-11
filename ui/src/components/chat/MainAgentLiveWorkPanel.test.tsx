// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@/adapters";
import { MainAgentLiveWorkPanel, pickMainAgentRun } from "./MainAgentLiveWorkPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({
  runs: [] as unknown[],
  transcript: new Map<string, unknown[]>(),
  transcriptRuns: [] as Array<{ id: string; adapterType: string }>,
}));

vi.mock("@/api/agents", () => ({ agentsApi: { get: async () => ({ id: "agent-1", adapterType: "ccpocket_bridge" }) } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { list: async () => fixture.runs } }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: async () => ({ id: "issue-1", identifier: "ALL-7", title: "Add hello endpoint" }) } }));
vi.mock("@/lib/polling", () => ({ useVisibilityRefetchInterval: () => false }));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: ({ runs }: { runs: Array<{ id: string; adapterType: string }> }) => {
    fixture.transcriptRuns = runs;
    return { transcriptByRun: fixture.transcript };
  },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => <a href={to} className={className}>{children}</a>,
}));

function run(overrides: Partial<Record<keyof HeartbeatRun, unknown>>): HeartbeatRun {
  return {
    id: "run-old", status: "succeeded", issueId: "issue-1", createdAt: "2026-11-08T00:00:00.000Z",
    startedAt: "2026-11-08T00:00:00.000Z", finishedAt: "2026-11-08T00:05:00.000Z", logBytes: 10, lastOutputBytes: 10, logRef: null,
    ...overrides,
  } as HeartbeatRun;
}

const activeTranscript: TranscriptEntry[] = [
  { kind: "tool_call", ts: "1", name: "Read", input: {} },
  { kind: "provider_activity", ts: "2", family: "plan", eventType: "plan.updated", status: "running", title: "Todo", summary: "",
    payload: { planId: "todo", steps: [{ stepId: "todo:0", body: "Read code", status: "completed" }, { stepId: "todo:1", body: "Running the API tests", status: "in_progress" }] } },
  { kind: "provider_activity", ts: "3", family: "delegation", eventType: "delegation.updated", status: "running", title: "Audit", summary: "",
    payload: { delegationId: "tu-1", description: "Audit auth routes", activity: "Reading middleware", subagentType: "Explore", lastToolName: "Grep" } },
  { kind: "provider_activity", ts: "3", family: "context", eventType: "context.usage", status: "completed", title: "Context", summary: "",
    payload: { usageId: "context-usage", currentTokens: 51000, modelContextWindow: 1000000 } },
  { kind: "provider_activity", ts: "4", family: "delegation", eventType: "delegation.completed", status: "completed", title: "UI", summary: "No regressions",
    payload: { delegationId: "tu-2", description: "Check UI copy", usage: { totalTokens: 2500, toolUses: 3 } } },
];

describe("MainAgentLiveWorkPanel", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fixture.transcript = new Map();
    fixture.transcriptRuns = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><MainAgentLiveWorkPanel companyId="company-1" agentId="agent-1" /></QueryClientProvider>);
    });
    for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  it("prefers the active run over newer finished runs", () => {
    const active = run({ id: "run-active", status: "running", createdAt: "2026-11-08T01:00:00.000Z" });
    const newer = run({ id: "run-new", createdAt: "2026-11-08T02:00:00.000Z" });
    expect(pickMainAgentRun([run({}), newer, active])?.id).toBe("run-active");
    expect(pickMainAgentRun([run({}), newer])?.id).toBe("run-new");
    expect(pickMainAgentRun([])).toBeNull();
  });

  it("shows the main agent's current task on top and one card per subagent", async () => {
    fixture.runs = [run({}), run({ id: "run-active", status: "running", finishedAt: null, createdAt: "2026-11-08T01:00:00.000Z" })];
    fixture.transcript = new Map([["run-active", activeTranscript]]);
    await render();
    expect(fixture.transcriptRuns).toEqual([expect.objectContaining({ id: "run-active", adapterType: "ccpocket_bridge" })]);
    const current = container.querySelector('[data-testid="main-agent-current"]')!;
    expect(current.textContent).toContain("Now");
    expect(current.textContent).toContain("ALL-7");
    expect(current.textContent).toContain("Add hello endpoint");
    expect(current.textContent).toContain("Running the API tests");
    expect(current.textContent).toContain("1/2 steps");
    expect(current.textContent).toContain("1 subagents running");
    const cards = Array.from(container.querySelectorAll('[data-testid="main-agent-subagent"]'));
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining("Audit auth routes"),
      expect.stringContaining("Check UI copy"),
    ]);
    expect(cards[0].textContent).toContain("Grep");
    expect(cards[0].querySelector('[data-testid="main-agent-subagent-activity"]')?.textContent).toBe("Reading middleware");
    expect(current.querySelector('[data-testid="main-agent-context"]')?.textContent).toContain("(5%)");
    expect(cards[1].textContent).toContain("2.5k tokens");
    expect(cards[1].textContent).toContain("No regressions");
  });

  it("shows observed main and child runtimes independently and leaves missing models explicit", async () => {
    fixture.runs = [run({ id: "run-active", status: "running" })];
    fixture.transcript = new Map([["run-active", [
      { kind: "provider_activity", ts: "1", family: "model_identity", eventType: "model.identity", status: "completed", title: "Runtime", summary: "",
        payload: { harness: "codex", model: "compass-6-astra", billingRoute: "compass" } },
      { kind: "provider_activity", ts: "2", family: "delegation", eventType: "delegation.started", status: "running", title: "Audit", summary: "",
        payload: { delegationId: "child", description: "Audit", harness: "codex", model: "gpt-6-luna", billingRoute: "openai_subscription" } },
      { kind: "provider_activity", ts: "3", family: "delegation", eventType: "delegation.started", status: "running", title: "Unknown", summary: "",
        payload: { delegationId: "unknown-child", description: "Unknown", harness: "codex", metadataError: "Child runtime metadata unavailable" } },
    ]]]);
    await render();
    expect(container.querySelector('[data-testid="main-agent-runtime"]')?.textContent).toBe("codex · 6 Astra · compass");
    const children = container.querySelectorAll('[data-testid="subagent-runtime"]');
    expect(children[0].textContent).toBe("codex · 6 Luna · subscription");
    expect(children[1].textContent).toBe("codex · model unknown · source unknown");
    expect(children[1].getAttribute("title")).toBe("Child runtime metadata unavailable");
  });

  it("summarizes the last run when nothing is active", async () => {
    fixture.runs = [run({})];
    fixture.transcript = new Map([["run-old", [{ kind: "assistant", ts: "1", text: "Endpoint added and tested." }]]]);
    await render();
    const current = container.querySelector('[data-testid="main-agent-current"]')!;
    expect(current.textContent).toContain("Last run");
    expect(current.textContent).toContain("Endpoint added and tested.");
    expect(container.querySelector('[data-testid="main-agent-subagent"]')).toBeNull();
  });

  it("renders nothing for an agent without runs", async () => {
    fixture.runs = [];
    await render();
    expect(container.textContent).toBe("");
  });
});
