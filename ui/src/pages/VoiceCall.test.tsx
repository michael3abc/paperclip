// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCall } from "./VoiceCall";
import { SHARED_VOICE_KEY } from "@/lib/local-voice/voice-agent-choice";

const mocks = vi.hoisted(() => ({ breadcrumbs: vi.fn(), active: false }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [{ id: "a1", name: "momo" }, { id: "a2", name: "michael" }] } }));
vi.mock("@/api/localVoice", () => ({ localVoiceApi: { status: async () => ({ enabled: true, relayConfigured: true, voices: ["alloy", "cedar"], defaultVoice: "alloy" }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/hooks/usePrimaryAgent", () => ({ usePrimaryAgent: () => ({ loading: false, data: { primaryAgentId: "a1" } }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ loaded: true, enabled: true }) }));
vi.mock("@/lib/router", () => ({ useSearchParams: () => [new URLSearchParams()] }));
vi.mock("@/components/voice/LocalVoiceCallProvider", () => ({ useLocalVoiceCall: () => ({ active: mocks.active, binding: { voiceName: "alloy" } }) }));
vi.mock("@/components/voice/LocalVoicePanel", () => ({ LocalVoicePanel: ({ agentId, voiceName }: { agentId: string; voiceName: string | null }) => <output>{agentId}:{voiceName ?? "default"}</output> }));

describe("Voice page shared voice", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    mocks.active = false;
    window.localStorage.clear();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); window.localStorage.clear(); vi.restoreAllMocks(); });
  const voice = () => container.querySelector<HTMLSelectElement>('select[aria-label="Voice for all agents"]')!;
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><VoiceCall /></QueryClientProvider>));
    await vi.waitFor(() => expect(voice()).not.toBeNull());
  }
  async function select(value: string) {
    await act(async () => { voice().value = value; voice().dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("shares one selection across agents and responds to another tab's change or reset", async () => {
    window.localStorage.setItem("paperclip.voice.agentVoice:a1", "alloy");
    await render();
    await select("cedar");
    expect(window.localStorage.getItem(SHARED_VOICE_KEY)).toBe("cedar");
    const agent = container.querySelector<HTMLSelectElement>('select:not([aria-label])')!;
    await act(async () => { agent.value = "a2"; agent.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(voice().value).toBe("cedar");
    expect(container.querySelector("output")?.textContent).toBe("a2:cedar");
    await act(async () => {
      window.localStorage.setItem(SHARED_VOICE_KEY, "alloy");
      window.dispatchEvent(new StorageEvent("storage", { key: SHARED_VOICE_KEY, storageArea: window.localStorage }));
    });
    expect(voice().value).toBe("alloy");
    await act(async () => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: window.localStorage }));
    });
    expect(voice().value).toBe("");
  });

  it("shows that a changed voice applies to the next call", async () => {
    mocks.active = true;
    window.localStorage.setItem(SHARED_VOICE_KEY, "alloy");
    await render();
    expect(container.textContent).not.toContain("Applies to the next call.");
    await select("cedar");
    expect(container.textContent).toContain("Applies to the next call.");
  });

  it("reports failed persistence and keeps the saved selection", async () => {
    window.localStorage.setItem(SHARED_VOICE_KEY, "alloy");
    await render();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await select("cedar");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the voice");
    expect(voice().value).toBe("alloy");
  });
});
