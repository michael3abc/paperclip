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
  { id: "michael-server/codex/compass-mini", label: "compass-mini", source: "Compass", efforts: [] },
  { id: "michael-server/codex/gpt-6-astra", label: "GPT-6 Astra", source: "Subscription", efforts: ["low", "medium"] },
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

function mockSavedUpdate() {
  return vi.spyOn(agentsApi, "update").mockImplementation(async (_id, patch) => {
    serverAgent = { ...serverAgent, adapterConfig: { ...serverAgent.adapterConfig, ...(patch.adapterConfig as object) } };
    return serverAgent as never;
  });
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

const pill = () => container!.querySelector<HTMLButtonElement>('[data-testid="main-agent-model-pill"]');
const option = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  .find((item) => item.textContent?.includes(label));
const applyButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "套用");

function setRange(range: HTMLInputElement, value: string) {
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(range, value);
    range.dispatchEvent(new Event("input", { bubbles: true }));
  });
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
  it("shows the saved effort and model display name without loading the Bridge catalog", async () => {
    await render();
    expect(pill()).not.toBeNull();
    expect(container!.querySelector('[data-testid="main-agent-model-pill-effort"]')!.textContent).toBe("高");
    // Before the catalog loads, the qualified ID is shown without its host/provider prefix.
    expect(container!.querySelector('[data-testid="main-agent-model-pill-model"]')!.textContent).toBe("gpt-6-sol");
    expect(agentsApi.adapterModels).not.toHaveBeenCalled();
  });

  it.each([false, true])("lists the agent's Bridge models in catalog order and saves a model change (mobile: %s)", async (mobile) => {
    const update = mockSavedUpdate();
    await render({ mobile });
    await click(pill());
    expect(agentsApi.adapterModels).toHaveBeenCalledWith("company-1", "ccpocket_bridge",
      { environmentId: null, hostId: "michael-server", provider: "codex" });
    expect([...document.querySelectorAll('[role="option"]')].map((item) => item.textContent))
      .toEqual(["GPT-6.1 SolSubscription", "compass-miniCompass", "GPT-6 AstraSubscription"]);
    expect(option("GPT-6.1 Sol")!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid="main-agent-model-hint"]')!.textContent).toContain("下一輪");
    expect(applyButton()!.disabled).toBe(true);

    await click(option("GPT-6 Astra"));
    // "high" is not offered by GPT-6 Astra, so the draft falls back to the model default.
    expect(document.querySelector('[data-testid="main-agent-model-effort"]')!.textContent).toBe("模型預設");
    await click(applyButton());

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-astra", effort: "" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
    expect(container!.querySelector('[data-testid="main-agent-model-pill-model"]')!.textContent).toBe("GPT-6 Astra");
    expect(container!.querySelector('[data-testid="main-agent-model-pill-effort"]')).toBeNull();
  });

  it("changes effort with discrete slider stops and can reset to the saved setting", async () => {
    const update = mockSavedUpdate();
    await render();
    await click(pill());
    const range = document.querySelector<HTMLInputElement>('input[aria-label="推理強度"]')!;
    expect(range.max).toBe("4");
    expect(range.value).toBe("3");
    expect(range.getAttribute("aria-valuetext")).toBe("高");

    setRange(range, "4");
    expect(range.getAttribute("aria-valuetext")).toBe("超高");
    await click(document.querySelector('button[aria-label="還原為已儲存設定"]'));
    expect(document.querySelector<HTMLInputElement>('input[aria-label="推理強度"]')!.getAttribute("aria-valuetext")).toBe("高");

    setRange(document.querySelector<HTMLInputElement>('input[aria-label="推理強度"]')!, "2");
    await click(applyButton());
    expect(update).toHaveBeenCalledWith("agent-main", {
      adapterConfig: { model: "michael-server/codex/gpt-6-sol", effort: "medium" },
      expectedConfigurationRevision: "rev-1",
    }, "company-1");
  });

  it("hides the effort slider when the selected model reports no efforts", async () => {
    await render();
    await click(pill());
    expect(document.querySelector('input[aria-label="推理強度"]')).not.toBeNull();
    await click(option("compass-mini"));
    expect(document.querySelector('input[aria-label="推理強度"]')).toBeNull();
  });

  it("shows read-only text to viewers without agent configuration access", async () => {
    await render({ role: "viewer" });
    expect(pill()).toBeNull();
    const readOnly = container!.querySelector('[data-testid="main-agent-model-readonly"]')!;
    expect(readOnly.textContent).toBe("高gpt-6-sol");
    expect(readOnly.querySelector("button")).toBeNull();
    expect(agentsApi.adapterModels).not.toHaveBeenCalled();
  });

  it("reverts the optimistic selection and reports a failed save", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(agentsApi, "update").mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }) as never);
    await render({ role: "operator" });
    await click(pill());
    await click(option("GPT-6 Astra"));
    await click(applyButton());
    expect(container!.querySelector('[data-testid="main-agent-model-pill-model"]')!.textContent).toBe("GPT-6 Astra");
    expect(pill()!.disabled).toBe(true);

    reject(new Error("Agent configuration changed while you were editing."));
    await settle();
    expect(pill()!.disabled).toBe(false);
    expect(container!.querySelector('[data-testid="main-agent-model-pill-model"]')!.textContent).toBe("GPT-6.1 Sol");
    const toast = container!.querySelector('[data-testid="toasts"] li')!;
    expect(toast.getAttribute("data-tone")).toBe("error");
    expect(toast.textContent).toContain("Agent configuration changed while you were editing.");
  });

  it("does not save over a model changed elsewhere", async () => {
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      ...agent, adapterConfig: { ...agent.adapterConfig, model: "michael-server/codex/compass-mini" }, configurationRevision: "rev-2",
    } as never);
    await render();
    await click(pill());
    await click(option("GPT-6 Astra"));
    await click(applyButton());
    expect(update).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="toasts"] li')!.textContent).toContain("已在其他地方變更");
  });
});
