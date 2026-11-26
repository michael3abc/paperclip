import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { liveMainAgents, mainAgentCreateBody, mainAgentHosts, suggestedMainAgentCwd, templateMainAgent, validMainAgentCwd } from "./project-main-agent";

function main(id: string, hostId: string, model: string, cwd: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: id, status: "idle", adapterType: "ccpocket_bridge", reportsTo: "boss",
    adapterConfig: { role: "main", hostId, provider: "claude", model, cwd }, ...extra } as unknown as Agent;
}
const agents = [
  main("a", "controller-host", "controller-host/claude/family:sonnet-5.5", "/home/controller/projects/a"),
  main("b", "controller-host", "controller-host/claude/family:opus-5.5", "/home/controller/projects/b"),
  main("c", "remote-host-c", "remote-host-c/claude/family:opus-5.5", "/home/worker/projects/c"),
  main("old", "other", "other/claude/x", "/x", { status: "terminated" }),
  { id: "worker", name: "worker", status: "idle", adapterType: "ccpocket_bridge", adapterConfig: { role: "worker", hostId: "controller-host" } } as unknown as Agent,
];

describe("project main agent helpers", () => {
  it("lists live mains and their hosts, most used first", () => {
    expect(liveMainAgents(agents).map(a => a.id)).toEqual(["a", "b", "c"]);
    expect(mainAgentHosts(agents)).toEqual(["controller-host", "remote-host-c"]);
    expect(mainAgentHosts([])).toEqual([]);
  });
  it("copies from the Opus 5.5 main of the host, else the first one", () => {
    expect(templateMainAgent(agents, "controller-host")?.id).toBe("b");
    expect(templateMainAgent([agents[0]], "controller-host")?.id).toBe("a");
    expect(templateMainAgent(agents, "nowhere")).toBeNull();
  });
  it("suggests the host's projects folder plus the project name, or nothing", () => {
    expect(suggestedMainAgentCwd(agents, "remote-host-c", "My New Project!")).toBe("/home/worker/projects/my-new-project");
    expect(suggestedMainAgentCwd(agents, "remote-host-c", "專案")).toBe("");
    expect(suggestedMainAgentCwd([main("m", "h", "h/claude/x", "/home/controller")], "h", "demo")).toBe("");
  });
  it("accepts only an absolute folder", () => {
    expect(validMainAgentCwd("/home/worker/projects/x")).toBe(true);
    for (const bad of ["", "/", "relative/path", "C:\\x", "/a\nb"]) expect(validMainAgentCwd(bad)).toBe(false);
  });
  it("builds the create body with the project binding, fixed folder and bundle", () => {
    const body = mainAgentCreateBody({ name: " Demo ", projectId: "p-1", hostId: "remote-host-c", cwd: " /home/worker/projects/demo ", agents });
    expect(body).toMatchObject({
      name: "Demo", role: "engineer", adapterType: "ccpocket_bridge", reportsTo: "boss",
      adapterConfig: { role: "main", binding: "fixed", provider: "claude", hostId: "remote-host-c", model: "remote-host-c/claude/family:opus-5.5",
        effort: "high", permissionMode: "fullAccess", cwd: "/home/worker/projects/demo", projectId: "p-1" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, workspaceBinding: { mode: "fixed", cwd: "/home/worker/projects/demo" } },
    });
    const files = (body.instructionsBundle as { files: Record<string, string> }).files;
    expect(files["AGENTS.md"]).toContain("# Demo 主 agent");
    expect(files["AGENTS.md"]).toContain("### 對外動作與額外費用（Owner 2026-11-21）");
    expect(files["PROJECT.md"]).toContain("p-1");
    expect(files["PROJECT.md"]).toContain("/home/worker/projects/demo");
  });
  it("falls back to Opus 5.5 on a host with no template main", () => {
    const body = mainAgentCreateBody({ name: "X", projectId: "p", hostId: "new-host", cwd: "/w", agents: [] });
    expect(body.adapterConfig).toMatchObject({ provider: "claude", model: "new-host/claude/family:opus-5.5" });
    expect(body.reportsTo).toBeNull();
  });
});
