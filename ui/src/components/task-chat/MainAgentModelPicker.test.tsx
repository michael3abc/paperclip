// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessApi, type CurrentBoardAccess } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ToastProvider, useToastState } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { MainAgentModelPicker } from "./MainAgentModelPicker";
import { MAIN_AGENT_EFFORT_SAVE_DELAY } from "./main-agent-model";

const agent = {
  id: "agent-main", companyId: "company-1", name: "Data-mining", urlKey: "data-mining",
  adapterType: "ccpocket_bridge", defaultEnvironmentId: null,
  adapterConfig: {
    role: "main", hostId: "michael-server", provider: "codex",
    model: "michael-server/codex/gpt-6-sol", effort: "high", cwd: "/srv/data-mining",
  },
} as unknown as Agent;

const catalog = [
  { id: "michael-server/codex/gpt-6-sol", label: "GPT-6.1 Sol", source: "Subscription", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "michael-server/codex/compass-6.1-sol", label: "compass-6.1-sol", source: "Compass", efforts: [] },
  { id: "michael-server/codex/gpt-6-astra", label: "gpt-6-astra", source: "Subscription", efforts: ["low", "medium"] },
];

function boardAccess(role: "owner" | "operator" | "viewer"): CurrentBoardAccess {
  return {
    user: null, userId: "user-1", isInstanceAdmin: false, companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }],
    source: "session", keyId: null,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let serverAgent: Agent = agent;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function ToastList() {
  const toasts = useToastState();
  return <ul data-testid="toasts">{toasts.map((toast) => <li key={toast.id} data-tone={toast.tone}>{toast.title}: {toast.body}</li>)}</ul>;
}

/** The composer reads the agent from the company agents list, as IssueDetail's agentMap does. */
function Harness({ mobile }: { mobile?: boolean }) {
  const { data } = useQuery({ queryKey: queryKeys.agents.list("company-1"), queryFn: async () => [serverAgent] });
  const current = data?.[0];
  return current ? <MainAgentModelPicker agent={current} companyId="company-1" mobile={mobile} /> : null;
}

function storePatch(patch: { adapterConfig?: unknown }) {
  serverAgent = { ...serverAgent, adapterConfig: { ...serverAgent.adapterConfig, ...(patch.adapterConfig as object) } };
  return serverAgent as never;
}

function mockSavedUpdate() {
  return vi.spyOn(agentsApi, "update").mockImplementation(async (_id, patch) => storePatch(patch));
}

async function render(options: { role?: "owner" | "operator" | "viewer"; mobile?: boolean } = {}) {
  vi.spyOn(accessApi, "getCurrentBoardAccess").mockResolvedValue(boardAccess(options.role ?? "owner"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root!.render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Harness mobile={options.mobile} />
        <ToastList />
      </ToastProvider>
    </QueryClientProvider>,
  ));
  await settle();
  return queryClient;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  flushSync(() => (element as HTMLElement).click());
  await settle();
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const pill = () => container!.querySelector<HTMLButtonElement>('[data-testid="main-agent-model-pill"]');
const pillEffort = () => container!.querySelector('[data-testid="main-agent-model-pill-effort"]')?.textContent ?? null;
const pillModel = () => container!.querySelector('[data-testid="main-agent-model-pill-model"]')?.textContent ?? null;
const slider = () => document.querySelector<HTMLInputElement>('input[aria-label="Effort"]');
const resetButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Revert changes"]');
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
const option = (name: string) => options().find((item) => item.textContent === name);

function setRange(range: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(range, value);
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function release(range: HTMLInputElement) {
  flushSync(() => range.dispatchEvent(new Event("pointerup", { bubbles: true })));
  await settle();
}

beforeEach(() => {
  serverAgent = agent;
  vi.spyOn(agentsApi, "adapterModels").mockResolvedValue(catalog);
  vi.spyOn(agentsApi, "getConfiguration").mockImplementation(async () => ({
    ...serverAgent, adapterConfig: { ...serverAgent.adapterConfig, env: { TOKEN: "***REDACTED***" } }, configurationRevision: "rev-1",
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("MainAgentModelPicker", () => {
  it("shows the saved effort and a compact model name without loading the Bridge catalog", async () => {
    await render();
    expect(pillEffort()).toBe("High");
    // Before the catalog loads, the qualified ID is humanized without its host/provider prefix.
    expect(pillModel()).toBe("GPT-6 Sol");
    expect(pill()!.getAttribute("aria-label")).toBe("Effort and model: High, GPT-6 Sol");
    expect(pill()!.querySelector("svg")).not.toBeNull();
    expect(agentsApi.adapterModels).not.toHaveBeenCalled();
  });

  it("opens a compact English panel with a slider, a model link and no Apply button", async () => {
    await render();
    await click(pill());
    expect(agentsApi.adapterModels).toHaveBeenCalledWith("company-1", "ccpocket_bridge",
      { environmentId: null, hostId: "michael-server", provider: "codex" });
    const panel = byTestId("main-agent-model-popover")!;
    expect(byTestId("main-agent-model-effort")!.textContent).toBe("High");
    expect(byTestId("main-agent-model-current")!.textContent).toBe("GPT-6.1 Sol");
    expect(byTestId("main-agent-model-hint")!.textContent).toBe("Applies from the next turn in this session.");
    const range = slider()!;
    expect(range.max).toBe("4");
    expect(range.value).toBe("3");
    expect(range.getAttribute("aria-valuetext")).toBe("High");
    // The header names the current stop; there are no tick labels, Apply button or Chinese copy.
    expect(panel.textContent).not.toMatch(/Low|Medium|Extra high/);
    expect([...panel.querySelectorAll("button")].some((button) => /apply/i.test(button.textContent ?? ""))).toBe(false);
    expect(panel.textContent).not.toMatch(/[㐀-鿿]/);
    expect(resetButton()!.disabled).toBe(true);
    expect(document.activeElement).toBe(range);
  });

  it.each([false, true])("picks a model from the grouped model view and saves it immediately (mobile: %s)", async (mobile) => {
    const update = mockSavedUpdate();
    await render({ mobile });
    await click(pill());
    if (mobile) expect(byTestId("main-agent-model-sheet")).not.toBeNull();
    await click(byTestId("main-agent-model-current"));

    expect(byTestId("main-agent-model-main-view")).toBeNull();
    expect(byTestId("main-agent-model-models-view")!.textContent).toContain("Model");
    expect([...document.querySelectorAll('[data-testid="main-agent-model-route"]')].map((item) => item.textContent))
      .toEqual(["Subscription", "Compass"]);
    // Bridge order within each route; clean names without per-row route labels.
    expect(options().map((item) => item.textContent)).toEqual(["GPT-6.1 Sol", "GPT-6 Astra", "6.1 Sol"]);
    expect(option("GPT-6.1 Sol")!.getAttribute("aria-selected")).toBe("true");
    expect(option("GPT-6.1 Sol")!.querySelector("svg")).not.toBeNull();
    expect(option("GPT-6 Astra")!.querySelector("svg")).toBeNull();
    expect(document.activeElement).toBe(option("GPT-6.1 Sol"));

    await click(option("GPT-6 Astra"));
    expect(update).toHaveBeenCalledTimes(1);
    // The stored ID stays qualified; "high" is not offered by GPT-6 Astra, so effort falls back to the model default.
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-astra", effort: "" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
    expect(byTestId("main-agent-model-main-view")).not.toBeNull();
    expect(byTestId("main-agent-model-current")!.textContent).toBe("GPT-6 Astra");
    expect(byTestId("main-agent-model-effort")!.textContent).toBe("Default");
    expect(document.activeElement).toBe(byTestId("main-agent-model-current"));
    expect(pillModel()).toBe("GPT-6 Astra");
    expect(pillEffort()).toBeNull();
  });

  it("moves through models with arrow keys and returns with Back", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    await click(byTestId("main-agent-model-current"));
    const list = document.querySelector('[role="listbox"]')!;
    flushSync(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(option("GPT-6 Astra"));
    flushSync(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(option("6.1 Sol"));
    expect(options().map((item) => item.tabIndex)).toEqual([0, -1, -1]);

    await click(document.querySelector('button[aria-label="Back"]'));
    expect(byTestId("main-agent-model-main-view")).not.toBeNull();
    expect(document.activeElement).toBe(byTestId("main-agent-model-current"));
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the effort as soon as the slider is released", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    setRange(slider()!, "4");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Extra high");
    expect(byTestId("main-agent-model-effort")!.textContent).toBe("Extra high");
    expect(update).not.toHaveBeenCalled();

    await release(slider()!);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "xhigh" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
    expect(pillEffort()).toBe("Extra high");
    expect(byTestId("main-agent-model-popover")).not.toBeNull();
  });

  it("collapses rapid keyboard changes into one debounced save", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    setRange(slider()!, "2");
    setRange(slider()!, "1");
    await settle();
    expect(update).not.toHaveBeenCalled();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, MAIN_AGENT_EFFORT_SAVE_DELAY + 50)); });
    await settle();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "low" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
  });

  it("saves a pending slider change when Escape closes the picker and returns focus to the pill", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    setRange(slider()!, "2");
    flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(byTestId("main-agent-model-popover")).toBeNull();
    expect(document.activeElement).toBe(pill());
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "medium" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
  });

  it("reverts to the setting from when the picker opened", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    setRange(slider()!, "4");
    await release(slider()!);
    expect(resetButton()!.disabled).toBe(false);

    await click(resetButton());
    expect(update).toHaveBeenLastCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "high" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("High");
    expect(resetButton()!.disabled).toBe(true);
    expect(document.activeElement).toBe(slider());
  });

  it("saves a change made during a running save after it, against the value just stored", async () => {
    const resolvers: Array<() => void> = [];
    const update = vi.spyOn(agentsApi, "update").mockImplementation((_id, patch) => new Promise((resolve) => {
      resolvers.push(() => resolve(storePatch(patch)));
    }));
    await render();
    await click(pill());
    setRange(slider()!, "4");
    await release(slider()!);
    expect(byTestId("main-agent-model-saving")).not.toBeNull();
    expect(pill()!.getAttribute("aria-busy")).toBe("true");
    setRange(slider()!, "2");
    await release(slider()!);
    expect(update).toHaveBeenCalledTimes(1);

    await act(async () => { resolvers.shift()!(); });
    await settle();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "medium" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
    await act(async () => { resolvers.shift()!(); });
    await settle();
    expect(byTestId("main-agent-model-saving")).toBeNull();
    expect(pillEffort()).toBe("Medium");
    expect(container!.querySelector('[data-testid="toasts"] li')).toBeNull();
  });

  it("hides the effort slider when the selected model reports no efforts", async () => {
    mockSavedUpdate();
    await render();
    await click(pill());
    expect(slider()).not.toBeNull();
    await click(byTestId("main-agent-model-current"));
    await click(option("6.1 Sol"));
    expect(slider()).toBeNull();
    expect(byTestId("main-agent-model-effort")!.textContent).toBe("Default");
    expect(pillModel()).toBe("6.1 Sol");
  });

  it("shows the same pill, read-only, to viewers without agent configuration access", async () => {
    await render({ role: "viewer" });
    expect(pill()).toBeNull();
    const readOnly = container!.querySelector('[data-testid="main-agent-model-readonly"]')!;
    expect(readOnly.textContent).toBe("High·GPT-6 Sol");
    expect(readOnly.tagName).toBe("SPAN");
    expect(readOnly.querySelector("button, svg")).toBeNull();
    expect(agentsApi.adapterModels).not.toHaveBeenCalled();
  });

  it("reverts the optimistic selection and reports a failed save", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(agentsApi, "update").mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }) as never);
    await render({ role: "operator" });
    await click(pill());
    await click(byTestId("main-agent-model-current"));
    await click(option("GPT-6 Astra"));
    expect(pillModel()).toBe("GPT-6 Astra");
    expect(byTestId("main-agent-model-saving")).not.toBeNull();

    reject(new Error("Agent configuration changed while you were editing."));
    await settle();
    expect(byTestId("main-agent-model-saving")).toBeNull();
    expect(pillModel()).toBe("GPT-6.1 Sol");
    expect(byTestId("main-agent-model-current")!.textContent).toBe("GPT-6.1 Sol");
    expect(byTestId("main-agent-model-effort")!.textContent).toBe("High");
    const toast = container!.querySelector('[data-testid="toasts"] li')!;
    expect(toast.getAttribute("data-tone")).toBe("error");
    expect(toast.textContent).toBe("Couldn't change the model: Agent configuration changed while you were editing.");
  });

  it("does not save over a model changed elsewhere", async () => {
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      ...agent, adapterConfig: { ...agent.adapterConfig, model: "michael-server/codex/compass-6.1-sol" }, configurationRevision: "rev-2",
    } as never);
    await render();
    await click(pill());
    await click(byTestId("main-agent-model-current"));
    await click(option("GPT-6 Astra"));
    expect(update).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="toasts"] li')!.textContent).toContain("changed elsewhere");
  });
});
