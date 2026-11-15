// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVoiceCall, LocalVoiceCallSnapshot } from "@/lib/local-voice/local-voice-call";
import { ChatVoiceCallButton } from "./ChatVoiceCallButton";

const mocks = vi.hoisted(() => ({ status: vi.fn(), chatEnabled: true }));
vi.mock("@/api/localVoice", () => ({ localVoiceApi: { status: mocks.status } }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: mocks.chatEnabled, loaded: true }) }));

function fakeCall() {
  let snapshot: LocalVoiceCallSnapshot = {
    phase: "idle", mode: "agent_chat", mic: "live", micPausedReason: null, modelSpeaking: false, issue: null,
    agentName: null, startedAt: null, maxSeconds: 600, warningSeconds: 60, timeWarning: false, transcript: [],
    draft: null, replies: [], sentLog: [], notice: null, error: null, endedReason: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<LocalVoiceCallSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => listener()); };
  const call = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    start: vi.fn(async () => set({ phase: "live", startedAt: Date.now(), agentName: "michael" })),
    end: vi.fn(async () => set({ phase: "ended", endedReason: "Call ended." })),
    pauseMic: vi.fn(() => set({ mic: "paused", micPausedReason: "manual" })),
    resumeMic: vi.fn(() => set({ mic: "live", micPausedReason: null })),
    dispose: vi.fn(),
  };
  return { call: call as unknown as LocalVoiceCall, spies: call, set };
}

describe("ChatVoiceCallButton", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); mocks.chatEnabled = true;
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  async function render(call: LocalVoiceCall) {
    await act(async () => root.render(<QueryClientProvider client={client}><ChatVoiceCallButton companyId="company" agentId="agent-1" agentName="michael" call={call} /></QueryClientProvider>));
  }
  const callButton = () => container.querySelector<HTMLButtonElement>('button[aria-label$="voice call with michael"], button[aria-label="Voice call with michael"]');

  it("starts an agent_chat call inline in the top bar without covering the page", async () => {
    mocks.status.mockResolvedValue({ companyId: "company", enabled: true, relayConfigured: true });
    const { call, spies, set } = fakeCall();
    await render(call);
    await vi.waitFor(() => expect(callButton()).not.toBeNull());
    await act(async () => callButton()!.click());
    expect(spies.start).toHaveBeenCalledWith({ companyId: "company", agentId: "agent-1", mode: "agent_chat" });
    const group = container.querySelector('[role="group"][aria-label="Voice call with michael"]');
    expect(group?.textContent).toContain("Listening");
    // No floating panel opens by itself while the call runs.
    expect(document.body.querySelector('section[aria-label^="Voice call details"]')).toBeNull();
    expect(callButton()?.getAttribute("aria-label")).toBe("End voice call with michael");

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Pause listening"]')!.click());
    expect(spies.pauseMic).toHaveBeenCalledWith("manual");
    expect(container.querySelector('button[aria-label="Resume listening"]')).not.toBeNull();

    await act(async () => set({ transcript: [{ id: 1, role: "user", text: "報告一下進度" }] }));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(document.body.querySelector('section[aria-label="Voice call details with michael"]')?.textContent).toContain("報告一下進度");
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Hide call details"]')!.click());
    expect(document.body.querySelector('section[aria-label^="Voice call details"]')).toBeNull();

    await act(async () => callButton()!.click());
    expect(spies.end).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="group"]')?.textContent).toContain("Call ended");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close voice call"]')!.click());
    expect(container.querySelector('[role="group"]')).toBeNull();
  });

  it("opens the details by itself when the call fails", async () => {
    mocks.status.mockResolvedValue({ companyId: "company", enabled: true, relayConfigured: true });
    const { call, set } = fakeCall();
    await render(call);
    await vi.waitFor(() => expect(callButton()).not.toBeNull());
    await act(async () => callButton()!.click());
    await act(async () => set({ phase: "error", error: "Microphone blocked." }));
    expect(document.body.querySelector('section[aria-label="Voice call details with michael"] [role="alert"]')?.textContent).toBe("Microphone blocked.");
  });

  it.each([
    ["voice is off", { enabled: false, relayConfigured: true }, true],
    ["no voice gateway", { enabled: true, relayConfigured: false }, true],
    ["Agent Chat is off", { enabled: true, relayConfigured: true }, false],
  ])("is hidden when %s", async (_name, status, chatEnabled) => {
    mocks.chatEnabled = chatEnabled;
    mocks.status.mockResolvedValue({ companyId: "company", ...status });
    await render(fakeCall().call);
    await vi.waitFor(() => expect(mocks.status).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(callButton()).toBeNull();
  });
});
