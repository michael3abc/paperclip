import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "@/api/agents";
import type { CurrentBoardAccess } from "@/api/access";
import {
  bridgeCatalogForScope, bridgeModelDisplayName, bridgeModelEfforts, canEditAgentConfiguration, effortForModel,
  isBridgeMainAgent, mainAgentEffortLabel, MainAgentModelConflictError, readMainAgentModelScope, saveMainAgentModel,
} from "./main-agent-model";

const scope = { hostId: "michael-server", provider: "codex" };

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
    expect(readMainAgentModelScope({ hostId: "michael-server", model: "michael-server/codex/gpt-6-sol" }))
      .toEqual({ hostId: "michael-server", provider: "codex", model: "michael-server/codex/gpt-6-sol", effort: "" });
  });

  it("keeps Bridge order and qualified IDs while fixing the host and executor", () => {
    const models = [
      { id: "michael-server/codex/b", label: "b" },
      { id: "michael-server/claude/c", label: "c" },
      { id: "shopee-d/codex/a", label: "a" },
      { id: "michael-server/codex/a", label: "a" },
    ];
    expect(bridgeCatalogForScope(models, scope).map((model) => model.id))
      .toEqual(["michael-server/codex/b", "michael-server/codex/a"]);
  });

  it("names a model by catalog label, else by its unqualified ID", () => {
    const catalog = [{ id: "michael-server/codex/gpt-6-sol", label: "GPT-6.1 Sol" }];
    expect(bridgeModelDisplayName("michael-server/codex/gpt-6-sol", catalog, scope)).toBe("GPT-6.1 Sol");
    expect(bridgeModelDisplayName("michael-server/codex/gpt-6-astra", [], scope)).toBe("gpt-6-astra");
    expect(bridgeModelDisplayName("other/codex/x", [], scope)).toBe("other/codex/x");
  });

  it("reads efforts from catalog metadata and drops unsupported efforts", () => {
    expect(bridgeModelEfforts({ id: "m", label: "m", efforts: ["low", "high", 3, "high", ""] })).toEqual(["low", "high"]);
    expect(bridgeModelEfforts({ id: "m", label: "m" })).toEqual([]);
    expect(effortForModel("xhigh", ["low", "high"])).toBe("");
    expect(effortForModel("high", ["low", "high"])).toBe("high");
    expect(mainAgentEffortLabel("high")).toBe("高");
    expect(mainAgentEffortLabel("")).toBe("模型預設");
    expect(mainAgentEffortLabel("turbo")).toBe("turbo");
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
    const saved = { ...scope, model: "michael-server/codex/gpt-6-sol", effort: "high" };
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      adapterConfig: { ...saved, role: "main", env: { TOKEN: "***REDACTED***" } }, configurationRevision: "rev-9",
    } as never);
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    await saveMainAgentModel({ agentId: "agent-1", companyId: "company-1", saved,
      next: { model: "michael-server/codex/gpt-6-astra", effort: "low" } });
    expect(update).toHaveBeenCalledWith("agent-1", {
      adapterConfig: { model: "michael-server/codex/gpt-6-astra", effort: "low" },
      expectedConfigurationRevision: "rev-9",
    }, "company-1");
  });

  it.each([
    { label: "model", change: { model: "michael-server/codex/other" } },
    { label: "effort", change: { effort: "low" } },
    { label: "host", change: { hostId: "shopee-d" } },
    { label: "executor", change: { provider: "claude" } },
  ])("refuses to save when the $label changed elsewhere", async ({ change }) => {
    const saved = { ...scope, model: "michael-server/codex/gpt-6-sol", effort: "high" };
    vi.spyOn(agentsApi, "getConfiguration").mockResolvedValue({
      adapterConfig: { ...saved, ...change }, configurationRevision: "rev-9",
    } as never);
    const update = vi.spyOn(agentsApi, "update").mockResolvedValue({} as never);
    await expect(saveMainAgentModel({ agentId: "agent-1", companyId: "company-1", saved,
      next: { model: "michael-server/codex/gpt-6-astra", effort: "" } })).rejects.toBeInstanceOf(MainAgentModelConflictError);
    expect(update).not.toHaveBeenCalled();
  });
});
