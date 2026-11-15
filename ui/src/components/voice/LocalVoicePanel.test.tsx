// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVoiceCall, LocalVoiceCallSnapshot } from "@/lib/local-voice/local-voice-call";
import { LocalVoiceCallProvider } from "./LocalVoiceCallProvider";
import { LocalVoicePanel } from "./LocalVoicePanel";

vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => <a>{children as string}</a> }));

function fakeCall() {
  let snapshot: LocalVoiceCallSnapshot = {
    phase: "idle", mode: "voice_task", mic: "live", micPausedReason: null, modelSpeaking: false, issue: null,
    agentName: null, startedAt: null, maxSeconds: 900, warningSeconds: 600, timeWarning: false, transcript: [],
    draft: null, replies: [], sentLog: [], notice: null, error: null, endedReason: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<LocalVoiceCallSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((listener) => listener()); };
  const call = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    start: vi.fn(async () => set({ phase: "live", startedAt: Date.now() })),
    end: vi.fn(async () => set({ phase: "ended", endedReason: "Call ended." })),
    dispose: vi.fn(),
  };
  return { call: call as unknown as LocalVoiceCall, spies: call };
}

/** Voice page panel (HOM-265): the remembered voice goes with each call start; a change mid-call waits for the next call. */
describe("LocalVoicePanel voice choice", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = (call: LocalVoiceCall, voiceName: string | null) => act(async () => root.render(
    <LocalVoiceCallProvider companyId="company" userId="viewer" createCall={() => call}><LocalVoicePanel companyId="company" agentId="agent-1" agentName="momo" mode="voice_task" voiceName={voiceName} /></LocalVoiceCallProvider>,
  ));
  const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))!;

  it("starts with the chosen voice and shows that a change applies to the next call", async () => {
    const { call, spies } = fakeCall();
    await render(call, "cedar");
    await act(async () => button("Start voice call").click());
    expect(spies.start).toHaveBeenLastCalledWith({ companyId: "company", agentId: "agent-1", mode: "voice_task", voiceName: "cedar" });
    expect(container.textContent).not.toContain("applies to the next call");
    await render(call, "ash");
    expect(container.textContent).toContain("Voice change applies to the next call.");
    await act(async () => button("End call").click());
    expect(container.textContent).not.toContain("applies to the next call");
    await act(async () => button("Start voice call").click());
    expect(spies.start).toHaveBeenLastCalledWith({ companyId: "company", agentId: "agent-1", mode: "voice_task", voiceName: "ash" });
  });

  it("keeps the server default without a chosen voice", async () => {
    const { call, spies } = fakeCall();
    await render(call, null);
    await act(async () => button("Start voice call").click());
    expect(spies.start).toHaveBeenLastCalledWith({ companyId: "company", agentId: "agent-1", mode: "voice_task" });
  });
});
