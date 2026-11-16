// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseDefaultVoiceAgentId, normalizeVoiceName, readSharedVoice, readLastVoiceAgentId, saveSharedVoice, saveLastVoiceAgentId } from "./voice-agent-choice";

const agents = [{ id: "a1", name: "Alpha" }, { id: "a2", name: "MoMo" }, { id: "a3", name: "Primary" }];

describe("voice agent choice", () => {
  afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

  it("prefers ?agentId=, then the remembered agent, then momo, then the primary agent, then the first", () => {
    expect(chooseDefaultVoiceAgentId(agents, { requested: "a3", lastChosen: "a1", primaryAgentId: "a1" })).toBe("a3");
    expect(chooseDefaultVoiceAgentId(agents, { requested: "gone", lastChosen: "a1", primaryAgentId: "a3" })).toBe("a1");
    expect(chooseDefaultVoiceAgentId(agents, { lastChosen: "gone", primaryAgentId: "a3" })).toBe("a2");
    expect(chooseDefaultVoiceAgentId([agents[0]!, agents[2]!], { primaryAgentId: "a3" })).toBe("a3");
    expect(chooseDefaultVoiceAgentId([agents[0]!, agents[2]!], {})).toBe("a1");
    expect(chooseDefaultVoiceAgentId([], {})).toBeNull();
  });

  it("remembers the choice per company and tolerates unavailable storage", () => {
    saveLastVoiceAgentId("c1", "a1");
    expect(readLastVoiceAgentId("c1")).toBe("a1");
    expect(readLastVoiceAgentId("c2")).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readLastVoiceAgentId("c1")).toBeNull();
    expect(() => saveLastVoiceAgentId("c1", "a2")).not.toThrow();
  });

  it("stores one voice without consulting historical per-agent choices", () => {
    window.localStorage.setItem("paperclip.voice.agentVoice:a1", "alloy");
    expect(readSharedVoice()).toBeNull();
    saveSharedVoice("Cedar");
    expect(readSharedVoice()).toBe("cedar");
    saveSharedVoice(null);
    expect(readSharedVoice()).toBeNull();
    saveSharedVoice("Kore");
    expect(readSharedVoice()).toBeNull();
    expect(normalizeVoiceName(" Marin ")).toBe("marin");
    expect(normalizeVoiceName(undefined)).toBeNull();
    expect(window.localStorage.getItem("paperclip.voice.agentVoice:a1")).toBe("alloy");
  });

  it("surfaces storage write failures instead of claiming the choice was saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => saveSharedVoice("ash")).toThrow("denied");
  });
});
