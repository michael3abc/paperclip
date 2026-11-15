// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseDefaultVoiceAgentId, normalizeVoiceName, readAgentVoice, readLastVoiceAgentId, saveAgentVoice, saveLastVoiceAgentId } from "./voice-agent-choice";

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

  it("remembers a voice per agent, normalizes it and tolerates unavailable storage (HOM-265)", () => {
    expect(readAgentVoice("a1")).toBeNull();
    saveAgentVoice("a1", "Cedar");
    saveAgentVoice("a2", "alloy");
    expect(readAgentVoice("a1")).toBe("cedar");
    expect(readAgentVoice("a2")).toBe("alloy");
    saveAgentVoice("a1", null);
    expect(readAgentVoice("a1")).toBeNull();
    saveAgentVoice("a2", "Kore");
    expect(readAgentVoice("a2")).toBeNull();
    window.localStorage.setItem("paperclip.voice.agentVoice:a3", "not-a-voice");
    expect(readAgentVoice("a3")).toBeNull();
    expect(normalizeVoiceName(" Marin ")).toBe("marin");
    expect(normalizeVoiceName(undefined)).toBeNull();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readAgentVoice("a1")).toBeNull();
    expect(() => saveAgentVoice("a1", "ash")).not.toThrow();
    expect(() => saveAgentVoice("a1", null)).not.toThrow();
  });
});
