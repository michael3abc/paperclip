// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceCall, type LocalVoiceCallDependencies, type VoiceAudioEngine } from "@/lib/local-voice/local-voice-call";
import { LocalVoiceCallProvider, useLocalVoiceCall } from "./LocalVoiceCallProvider";
import { ChatVoiceCallButton } from "./ChatVoiceCallButton";
import { LocalVoicePanel } from "./LocalVoicePanel";

vi.mock("@/api/localVoice", () => ({ localVoiceApi: { status: async () => ({ enabled: true, relayConfigured: true }) } }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a> }));

class Socket {
  readyState = 1;
  binaryType = "arraybuffer";
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn((data: string | ArrayBuffer) => {
    if (typeof data === "string" && JSON.parse(data).type === "end") {
      // The real call waits for the relay to flush before completing end().
      queueMicrotask(() => this.emit({ type: "ended", reason: "caller_ended" }));
    }
  });
  close = vi.fn(() => { this.readyState = 3; });
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function fixture() {
  const sockets: Socket[] = [];
  const audio: VoiceAudioEngine = {
    start: vi.fn(async () => {}), play: vi.fn(), flush: vi.fn(), setInputSampleRate: vi.fn(), close: vi.fn(async () => {}),
  };
  const ensureEndpoint = vi.fn(async () => ({ endpointId: "endpoint", agentId: "agent-a", agentName: "Alice", created: false }));
  const ensureChat = vi.fn(async () => ({ id: "original-chat", identifier: "CHAT-1" }));
  const postChatMessage = vi.fn(async () => ({ id: "comment" }));
  const createAudio = vi.fn(() => audio);
  const endRemote = vi.fn(async () => ({} as never));
  const deps: LocalVoiceCallDependencies = {
    api: {
      ensureEndpoint,
      start: vi.fn(async () => ({ session: { id: "session", issueId: "original-chat" } as never, media: { transportToken: "test-token" } as never })),
      end: endRemote, relayPath: () => "/api/voice-test/ws",
    },
    ensureChat, postChatMessage, createAudio,
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    now: Date.now, randomId: () => "operation",
    setInterval: () => 1, clearInterval: vi.fn(),
  };
  const call = new LocalVoiceCall(deps);
  const dispose = vi.spyOn(call, "dispose");
  const start = vi.spyOn(call, "start");
  return { call, sockets, audio, ensureEndpoint, ensureChat, postChatMessage, createAudio, endRemote, dispose, start };
}
const ready = { type: "ready", issueId: "original-chat", issueIdentifier: "CHAT-1", agentName: "Alice", maxSeconds: 900, warningSeconds: 600, inputSampleRate: 24_000 };

// A second consumer must not be able to switch the active binding even if it
// invokes the host directly before the disabled control is painted.
function SecondStart() {
  const host = useLocalVoiceCall();
  return <button onClick={() => host.start({ companyId: "company", agentId: "agent-b", agentName: "Bob", mode: "agent_chat" })}>Try second call</button>;
}

describe("LocalVoiceCallProvider route and identity lifetime", () => {
  let container: HTMLDivElement, root: Root, client: QueryClient;
  let h: ReturnType<typeof fixture>;
  let factory: () => LocalVoiceCall;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    h = fixture(); factory = () => h.call;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear(); container.remove(); localStorage.clear(); vi.unstubAllGlobals();
  });
  async function render(page: "alice" | "bob" | "none" | "voice" = "alice", companyId: string | null = "company", userId: string | null = "viewer", controlCompanyId: string | null = companyId) {
    await act(async () => root.render(<StrictMode><QueryClientProvider client={client}>
      <LocalVoiceCallProvider companyId={companyId} userId={userId} createCall={factory}>
        {controlCompanyId && (page === "alice" || page === "bob") && <ChatVoiceCallButton key={page} companyId={controlCompanyId} agentId={page === "alice" ? "agent-a" : "agent-b"} agentName={page === "alice" ? "Alice" : "Bob"} />}
        {page === "voice" && companyId && <LocalVoicePanel companyId={companyId} agentId="agent-b" agentName="Bob" mode="voice_task" />}
        <SecondStart />
      </LocalVoiceCallProvider>
    </QueryClientProvider></StrictMode>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  async function start() {
    await render();
    h.dispose.mockClear(); // Ignore StrictMode's idle setup/cleanup probe.
    await act(async () => {
      button("Voice call with Alice").click();
      // Audio creation happened before the click returns, not after an effect.
      expect(h.createAudio).toHaveBeenCalledOnce();
    });
  }
  async function live() {
    await start();
    await act(async () => h.sockets[0].emit(ready));
    expect(h.call.getSnapshot().phase).toBe("live");
  }

  it("keeps the original call and dictation route alive across chat changes and control remounts", async () => {
    await live();
    await act(async () => h.sockets[0].emit({ type: "voice_turn", turnId: "question", state: "stored" }));
    await render("bob");
    expect(container.textContent).toContain("等待回答");
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.audio.close).not.toHaveBeenCalled();
    expect(button("Voice call with Bob").disabled).toBe(true);
    expect(container.querySelector('aside[aria-label="Current voice call with Alice"]')).not.toBeNull();
    await act(async () => {
      [...container.querySelectorAll("button")].find(node => node.textContent === "Try second call")!.click();
      h.sockets[0].emit({ type: "dictation", operationId: "dictation-one", text: "Keep working", body: "Keep working" });
    });
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.ensureChat).toHaveBeenCalledWith("company", "agent-a");
    expect(h.postChatMessage).toHaveBeenCalledWith("original-chat", "Keep working", "dictation-one", "session");
    await render("none");
    expect(button("End voice call with Alice")).not.toBeNull();
    await act(async () => button("Pause listening").click());
    expect(h.call.getSnapshot().mic).toBe("paused");
    await act(async () => button("Resume listening").click());
    expect(h.call.getSnapshot().mic).toBe("live");
    await render("alice");
    expect(container.textContent).toContain("等待回答");
    expect(h.call.getSnapshot().turns).toHaveLength(1);
    expect(container.querySelector('aside[aria-label^="Current voice call"]')).toBeNull();
    expect(container.querySelector('[role="group"][aria-label="Voice call with Alice"]')).not.toBeNull();
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.dispose).not.toHaveBeenCalled();
    await act(async () => button("End voice call with Alice").click());
    expect(h.audio.close).toHaveBeenCalledOnce();
    expect(h.call.getSnapshot().phase).toBe("ended");
  });

  it("retains the original target while start is still awaiting the endpoint", async () => {
    let resolveEndpoint!: (value: Awaited<ReturnType<typeof h.ensureEndpoint>>) => void;
    h.ensureEndpoint.mockReturnValueOnce(new Promise(resolve => { resolveEndpoint = resolve; }));
    await start();
    expect(h.call.getSnapshot().phase).toBe("starting");
    await render("bob");
    expect(container.querySelector('aside[aria-label="Current voice call with Alice"]')?.textContent).toContain("Connecting");
    expect(button("Voice call with Bob").disabled).toBe(true);
    expect(h.dispose).not.toHaveBeenCalled();
    await act(async () => resolveEndpoint({ endpointId: "endpoint", agentId: "agent-a", agentName: "Alice", created: false }));
    await act(async () => h.sockets[0].emit(ready));
    expect(h.ensureChat).toHaveBeenCalledWith("company", "agent-a");
    expect(h.call.getSnapshot().phase).toBe("live");
  });

  it("shares the same call with the voice page and blocks another agent/mode", async () => {
    await live();
    await render("voice");
    expect(container.querySelector('section[aria-label="Voice call with Bob"]')?.textContent).toContain("Alice is still active");
    const startButtons = [...container.querySelectorAll<HTMLButtonElement>("section button")];
    expect(startButtons.length).toBeGreaterThan(0);
    expect(startButtons.every(node => node.disabled)).toBe(true);
    expect(h.start).toHaveBeenCalledOnce();
    expect(h.dispose).not.toHaveBeenCalled();
    await act(async () => button("End voice call with Alice").click());
    expect(h.call.getSnapshot().phase).toBe("ended");
  });

  it.each([
    ["company change", "other-company", "viewer"],
    ["account change", "company", "other-viewer"],
    ["logout", "company", null],
    ["company cleared", null, "viewer"],
  ])("cleans up on %s and never shows the old call in the new scope", async (_reason, companyId, userId) => {
    await live();
    const old = h;
    const next = fixture(); factory = () => next.call;
    await render("bob", companyId, userId);
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(old.audio.close).toHaveBeenCalledOnce();
    expect(old.call.getSnapshot().phase).toBe("ended");
    expect(container.textContent).not.toContain("Alice");
    expect(container.querySelector('aside[aria-label^="Current voice call"]')).toBeNull();
    expect(next.start).not.toHaveBeenCalled();
  });

  it("cancels a pending start on account change without reviving the old target", async () => {
    let resolveEndpoint!: (value: Awaited<ReturnType<typeof h.ensureEndpoint>>) => void;
    h.ensureEndpoint.mockReturnValueOnce(new Promise(resolve => { resolveEndpoint = resolve; }));
    await start();
    const old = h;
    const next = fixture(); factory = () => next.call;
    await render("bob", "company", "other-viewer");
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(old.audio.close).toHaveBeenCalled();
    await act(async () => resolveEndpoint({ endpointId: "endpoint", agentId: "agent-a", agentName: "Alice", created: false }));
    expect(old.ensureChat).not.toHaveBeenCalled();
    expect(old.sockets).toHaveLength(0);
    expect(old.call.getSnapshot().phase).toBe("ended");
    expect(container.textContent).not.toContain("Alice");
    expect(next.start).not.toHaveBeenCalled();
  });

  it.each([
    ["unresolved account", "company", null, "Select an organization and sign in"],
    ["unresolved organization", null, "viewer", "Select an organization and sign in"],
    ["organization mismatch", "other-company", "viewer", "belongs to another organization"],
  ])("disables call start for %s with an explicit explanation", async (_reason, companyId, userId, explanation) => {
    await render("alice", companyId, userId, "company");
    const control = button("Voice call with Alice");
    expect(control.disabled).toBe(true);
    expect(control.title).toContain(explanation);
    await act(async () => control.click());
    expect(h.start).not.toHaveBeenCalled();
    expect(h.createAudio).not.toHaveBeenCalled();
  });

  it("releases audio and the relay when the app provider unmounts", async () => {
    await live();
    await act(async () => root.render(<p>Signed out</p>));
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.audio.close).toHaveBeenCalledOnce();
    expect(h.sockets[0].close).toHaveBeenCalledOnce();
  });
});
