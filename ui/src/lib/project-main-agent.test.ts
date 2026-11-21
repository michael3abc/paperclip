import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { liveMainAgents, mainAgentCreateBody, mainAgentHosts, suggestedMainAgentCwd, templateMainAgent, validMainAgentCwd } from "./project-main-agent";

function main(id: string, hostId: string, model: string, cwd: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: id, status: "idle", adapterType: "ccpocket_bridge", reportsTo: "boss",
    adapterConfig: { role: "main", hostId, provider: "claude", model, cwd }, ...extra } as unknown as Agent;
}
const agents = [
  main("a", "michael-server", "michael-server/claude/family:sonnet-5.5", "/home/michael/projects/a"),
  main("b", "michael-server", "michael-server/claude/family:opus-5.5", "/home/michael/projects/b"),
  main("c", "yoyo-server", "yoyo-server/claude/family:opus-5.5", "/home/yoyo/projects/c"),
  main("old", "other", "other/claude/x", "/x", { status: "terminated" }),
  { id: "worker", name: "worker", status: "idle", adapterType: "ccpocket_bridge", adapterConfig: { role: "worker", hostId: "michael-server" } } as unknown as Agent,
];

describe("project main agent helpers", () => {
  it("lists live mains and their hosts, most used first", () => {
    expect(liveMainAgents(agents).map(a => a.id)).toEqual(["a", "b", "c"]);
    expect(mainAgentHosts(agents)).toEqual(["michael-server", "yoyo-server"]);
    expect(mainAgentHosts([])).toEqual([]);
  });
  it("copies from the Opus 5.5 main of the host, else the first one", () => {
    expect(templateMainAgent(agents, "michael-server")?.id).toBe("b");
    expect(templateMainAgent([agents[0]], "michael-server")?.id).toBe("a");
    expect(templateMainAgent(agents, "nowhere")).toBeNull();
  });
  it("suggests the host's projects folder plus the project name, or nothing", () => {
    expect(suggestedMainAgentCwd(agents, "yoyo-server", "My New Project!")).toBe("/home/yoyo/projects/my-new-project");
    expect(suggestedMainAgentCwd(agents, "yoyo-server", "專案")).toBe("");
    expect(suggestedMainAgentCwd([main("m", "h", "h/claude/x", "/home/michael")], "h", "demo")).toBe("");
  });
  it("accepts only an absolute folder", () => {
    expect(validMainAgentCwd("/home/yoyo/projects/x")).toBe(true);
    for (const bad of ["", "/", "relative/path", "C:\\x", "/a\nb"]) expect(validMainAgentCwd(bad)).toBe(false);
  });
  it("builds the create body with the project binding, fixed folder and bundle", () => {
    const body = mainAgentCreateBody({ name: " Demo ", projectId: "p-1", hostId: "yoyo-server", cwd: " /home/yoyo/projects/demo ", agents });
    expect(body).toMatchObject({
      name: "Demo", role: "engineer", adapterType: "ccpocket_bridge", reportsTo: "boss",
      adapterConfig: { role: "main", binding: "fixed", provider: "claude", hostId: "yoyo-server", model: "yoyo-server/claude/family:opus-5.5",
        effort: "high", permissionMode: "fullAccess", cwd: "/home/yoyo/projects/demo", projectId: "p-1" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 }, workspaceBinding: { mode: "fixed", cwd: "/home/yoyo/projects/demo" } },
    });
    const files = (body.instructionsBundle as { files: Record<string, string> }).files;
    expect(files["AGENTS.md"]).toContain("# Demo 主 agent");
    expect(files["PROJECT.md"]).toContain("p-1");
    expect(files["PROJECT.md"]).toContain("/home/yoyo/projects/demo");
  });
  it("falls back to Opus 5.5 on a host with no template main", () => {
    const body = mainAgentCreateBody({ name: "X", projectId: "p", hostId: "new-host", cwd: "/w", agents: [] });
    expect(body.adapterConfig).toMatchObject({ provider: "claude", model: "new-host/claude/family:opus-5.5" });
    expect(body.reportsTo).toBeNull();
  });
});
