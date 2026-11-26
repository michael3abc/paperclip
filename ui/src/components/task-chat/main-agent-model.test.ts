import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "@/api/agents";
import type { CurrentBoardAccess } from "@/api/access";
import {
  bridgeCatalogForScope, bridgeModelDisplayName, bridgeModelEfforts, bridgeModelHasFastTier, canEditAgentConfiguration,
  compactBridgeModelName, effortForModel, groupBridgeCatalog, humanizeBridgeModelId, isBridgeMainAgent, mainAgentEffortLabel,
  MainAgentModelConflictError, readMainAgentModelScope, saveMainAgentModel, serviceTierForModel, unqualifiedBridgeModelId,
} from "./main-agent-model";

const scope = { hostId: "controller-host", provider: "codex" };

function access(overrides: Partial<CurrentBoardAccess>): CurrentBoardAccess {
  return { user: null, userId: "user-1", isInstanceAdmin: false, companyIds: ["company-1"], memberships: [],
    source: "session", keyId: null, ...overrides };
}

afterEach(() => vi.restoreAllMocks());

describe("main agent model helpers", () => {
  it("recognizes only Bridge main agents", () => {
    expect(isBridgeMainAgent({ adapterType: "ccpocket_bridge", adapterConfig: { role: "main" } } as unknown as Agent)).toBe(true);
    expect(isBridgeMainAgent({ adapterType: "ccpocket_bridge", adapterConfig: { role: "" } } as unknown as Agent)).toBe(false);
    expect(isBridgeMainAgent({ adapterType: "codex_local", adapterConfig: { role: "main" } } as unknown as Agent)).toBe(false);
    expect(isBridgeMainAgent(undefined)).toBe(false);
  });

  it("reads the saved scope with the Bridge's default executor", () => {
    expect(readMainAgentModelScope({ hostId: "controller-host", model: "controller-host/codex/gpt-6-sol" }))
      .toEqual({ hostId: "controller-host", provider: "codex", model: "controller-host/codex/gpt-6-sol", effort: "", serviceTier: "standard" });
  });

  it("reads the saved service tier: only fast is fast", () => {
    expect(readMainAgentModelScope({ serviceTier: "fast" }).serviceTier).toBe("fast");
    expect(readMainAgentModelScope({ serviceTier: " fast " }).serviceTier).toBe("fast");
    for (const serviceTier of ["standard", "priority", "", 1, null, undefined]) {
      expect(readMainAgentModelScope({ serviceTier }).serviceTier).toBe("standard");
    }
  });

  it("offers fast only for catalog models that report the fast tier", () => {
    const fast = { id: "m", label: "m", serviceTiers: ["standard", "fast"] };
    const standard = { id: "s", label: "s", serviceTiers: ["standard"] };
    expect(bridgeModelHasFastTier(fast)).toBe(true);
    expect(bridgeModelHasFastTier({ id: "f", label: "f", serviceTiers: ["fast"] })).toBe(true);
    expect(bridgeModelHasFastTier(standard)).toBe(false);
    expect(bridgeModelHasFastTier({ id: "x", label: "x", serviceTiers: "fast" })).toBe(false);
    expect(bridgeModelHasFastTier({ id: "x", label: "x" })).toBe(false);
    expect(bridgeModelHasFastTier(undefined)).toBe(false);
    expect(serviceTierForModel("fast", fast)).toBe("fast");
    expect(serviceTierForModel("fast", standard)).toBe("standard");
    expect(serviceTierForModel("standard", fast)).toBe("standard");
  });

  it("keeps Bridge order and qualified IDs while fixing the host and executor", () => {
    const models = [
      { id: "controller-host/codex/b", label: "b" },
      { id: "controller-host/claude/c", label: "c" },
      { id: "remote-host-b/codex/a", label: "a" },
      { id: "controller-host/codex/a", label: "a" },
    ];
    expect(bridgeCatalogForScope(models, scope).map((model) => model.id))
      .toEqual(["controller-host/codex/b", "controller-host/codex/a"]);
  });

  it("uses a human catalog label as the display name", () => {
    const catalog = [
      { id: "controller-host/codex/gpt-6-sol", label: "GPT-6.1 Sol" },
      { id: "controller-host/codex/gpt-6-luna", label: "GPT-6" },
      { id: "controller-host/claude/opus", label: "opus" },
      { id: "controller-host/claude/compass-opus5.5[1m]", label: "compass-opus5.5[1m]" },
      { id: "controller-host/claude/Qwen3.8_RTX2080ti_Strata", label: "controller-host/claude/Qwen3.8_RTX2080ti_Strata" },
    ];
    const claude = { hostId: "controller-host", provider: "claude" };
    expect(bridgeModelDisplayName("controller-host/codex/gpt-6-sol", catalog, scope)).toBe("GPT-6.1 Sol");
    expect(bridgeModelDisplayName("controller-host/codex/gpt-6-luna", catalog, scope)).toBe("GPT-6");
    // Labels that only repeat the ID are humanized instead.
    expect(bridgeModelDisplayName("controller-host/claude/opus", catalog, claude)).toBe("Claude Opus");
    expect(bridgeModelDisplayName("controller-host/claude/compass-opus5.5[1m]", catalog, claude)).toBe("Opus 5.5 · 1M");
    expect(bridgeModelDisplayName("controller-host/claude/Qwen3.8_RTX2080ti_Strata", catalog, claude)).toBe("Qwen3.8 Strata (RTX 2080 Ti)");
    expect(bridgeModelDisplayName("", catalog, scope)).toBe("");
  });

  it.each([
    ["default", "Default"],
    ["opus", "Claude Opus"],
    ["sonnet", "Claude Sonnet"],
    ["haiku", "Claude Haiku"],
    ["claude-fable-5-1[1m]", "Claude Fable 5.1 · 1M"],
    ["compass-opus5.5", "Opus 5.5"],
    ["family:opus5.5", "Opus 5.5"],
    ["family:sonnet-5.5", "Sonnet 5.5"],
    ["family:fable5.2", "Fable 5.2"],
    ["compass-sonnet5.5", "Sonnet 5.5"],
    ["compass-fable5", "Fable 5"],
    ["compass-opus5", "Opus 5"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-6-astra", "GPT-6 Astra"],
    ["gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-6-luna", "GPT-6 Luna"],
    ["compass-6.1-sol", "6.1 Sol"],
    ["Qwen3.8_RTX2080ti_Strata", "Qwen3.8 Strata (RTX 2080 Ti)"],
  ])("humanizes the model ID %s as %s, with or without its host/provider prefix", (id, name) => {
    expect(humanizeBridgeModelId(id)).toBe(name);
    expect(bridgeModelDisplayName(`controller-host/codex/${id}`, [], scope)).toBe(name);
    expect(bridgeModelDisplayName(`remote-host-b/claude/${id}`, [{ id: `remote-host-b/claude/${id}`, label: id }], scope)).toBe(name);
  });

  it("keeps the stored ID unqualified only for display", () => {
    expect(unqualifiedBridgeModelId("controller-host/codex/gpt-6-sol", scope)).toBe("gpt-6-sol");
    expect(unqualifiedBridgeModelId("remote-host-b/claude/opus", scope)).toBe("opus");
    expect(unqualifiedBridgeModelId("opus", scope)).toBe("opus");
    expect(compactBridgeModelName("Claude Opus")).toBe("Opus");
    expect(compactBridgeModelName("Claude Fable 5.1 · 1M")).toBe("Fable 5.1 · 1M");
    expect(compactBridgeModelName("GPT-6.1 Sol")).toBe("GPT-6.1 Sol");
  });

  it("groups models by billing route in a fixed order and keeps Bridge order within each group", () => {
    const claude = { hostId: "controller-host", provider: "claude" };
    const models = [
      { id: "controller-host/claude/default", label: "default", source: "Subscription" },
      { id: "controller-host/claude/Qwen3.8_RTX2080ti_Strata", label: "Qwen", source: "Local" },
      { id: "controller-host/claude/opus", label: "opus", source: "Subscription" },
      { id: "controller-host/claude/compass-fable5", label: "compass-fable5" },
      { id: "controller-host/claude/compass-opus5.5", label: "compass-opus5.5", source: "compass" },
      { id: "controller-host/claude/mystery", label: "mystery" },
      { id: "controller-host/claude/sonnet", label: "sonnet", source: "Subscription" },
    ];
    const groups = groupBridgeCatalog(models, claude);
    expect(groups.map((group) => group.label)).toEqual(["Subscription", "Compass", "Local", "Other"]);
    expect(groups.map((group) => group.models.map((model) => model.id.split("/")[2]))).toEqual([
      ["default", "opus", "sonnet"], ["compass-fable5", "compass-opus5.5"], ["Qwen3.8_RTX2080ti_Strata"], ["mystery"],
    ]);
    expect(groupBridgeCatalog([{ id: "controller-host/claude/opus", label: "opus" }], claude))
      .toEqual([{ key: "", label: null, models: [{ id: "controller-host/claude/opus", label: "opus" }] }]);
  });

  it("reads efforts from catalog metadata and labels them in English", () => {
    expect(bridgeModelEfforts({ id: "m", label: "m", efforts: ["low", "high", 3, "high", ""] })).toEqual(["low", "high"]);
    expect(bridgeModelEfforts({ id: "m", label: "m" })).toEqual([]);
    expect(effortForModel("xhigh", ["low", "high"])).toBe("");
    expect(effortForModel("high", ["low", "high"])).toBe("high");
    expect(["", "low", "medium", "high", "xhigh", "max"].map(mainAgentEffortLabel))
      .toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    expect(mainAgentEffortLabel("turbo")).toBe("Turbo");
  });

  it("mirrors the default agents:configure role grants for the presentation gate", () => {
    expect(canEditAgentConfiguration(undefined, "company-1")).toBe(false);
    expect(canEditAgentConfiguration(access({ source: "local_implicit" }), "company-1")).toBe(true);
    expect(canEditAgentConfiguration(access({ isInstanceAdmin: true }), "company-1")).toBe(true);
    for (const role of ["owner", "admin", "operator", "member"] as const) {
      expect(canEditAgentConfiguration(access({ memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }] }), "company-1")).toBe(true);
    }
    expect(canEditAgentConfiguration(access({ memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }] }), "company-1")).toBe(false);
    expect(canEditAgentConfiguration(access({ memberships: [{ companyId: "company-1", membershipRole: "owner", status: "suspended" }] }), "company-1")).toBe(false);
    expect(canEditAgentConfiguration(access({ memberships: [{ companyId: "company-2", membershipRole: "owner", status: "active" }] }), "company-1")).toBe(false);
  });

  it("patches only model and effort, bound to the current configuration revision", async () => {
    const saved = { ...scope, model: "controller-host/codex/gpt-6-sol", effort: "high", serviceTier: "standard" as const };
    // A config without serviceTier reads as standard; an unchanged tier is not written.
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      adapterConfig: { ...scope, model: saved.model, effort: saved.effort, role: "main", env: { TOKEN: "***REDACTED***" } },
      configurationRevision: "rev-9",
    } as never);
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    await saveMainAgentModel({ agentId: "agent-1", companyId: "company-1", saved,
      next: { model: "controller-host/codex/gpt-6-astra", effort: "low", serviceTier: "standard" } });
    expect(update).toHaveBeenCalledWith("agent-1", {
      adapterConfig: { model: "controller-host/codex/gpt-6-astra", effort: "low" },
      expectedConfigurationRevision: "rev-9",
    }, "company-1");
  });

  it.each([
    { from: "standard", to: "fast", stored: {} },
    { from: "fast", to: "standard", stored: { serviceTier: "fast" } },
  ] as const)("writes serviceTier $to when fast mode changes from $from", async ({ from, to, stored }) => {
    const saved = { ...scope, model: "controller-host/codex/gpt-6-sol", effort: "high", serviceTier: from };
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      adapterConfig: { hostId: saved.hostId, provider: saved.provider, model: saved.model, effort: saved.effort, ...stored },
      configurationRevision: "rev-9",
    } as never);
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    await saveMainAgentModel({ agentId: "agent-1", companyId: "company-1", saved,
      next: { model: saved.model, effort: "high", serviceTier: to } });
    expect(update).toHaveBeenCalledWith("agent-1", {
      adapterConfig: { model: "controller-host/codex/gpt-6-sol", effort: "high", serviceTier: to },
      expectedConfigurationRevision: "rev-9",
    }, "company-1");
  });

  it.each([
    { label: "model", change: { model: "controller-host/codex/other" } },
    { label: "effort", change: { effort: "low" } },
    { label: "service tier", change: { serviceTier: "fast" } },
    { label: "host", change: { hostId: "remote-host-b" } },
    { label: "executor", change: { provider: "claude" } },
  ])("refuses to save when the $label changed elsewhere", async ({ change }) => {
    const saved = { ...scope, model: "controller-host/codex/gpt-6-sol", effort: "high", serviceTier: "standard" as const };
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      adapterConfig: { ...saved, ...change }, configurationRevision: "rev-9",
    } as never);
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    await expect(saveMainAgentModel({ agentId: "agent-1", companyId: "company-1", saved,
      next: { model: "controller-host/codex/gpt-6-astra", effort: "", serviceTier: "standard" } })).rejects.toBeInstanceOf(MainAgentModelConflictError);
    expect(update).not.toHaveBeenCalled();
  });
});
