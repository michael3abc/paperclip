import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { instanceUserRoles } from "@paperclipai/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupHostTerminalWebSocketServer } from "../realtime/host-terminal-ws.js";
import { HostTerminalSessions } from "../services/host-terminal-sessions.js";
import { launchHostTerminal } from "../services/host-terminal-pty.js";
const { WebSocket } = createRequire(import.meta.url)("ws");
let root: string, server: Server, endpoint: string, origin: string;
let service: HostTerminalSessions, transport: ReturnType<typeof setupHostTerminalWebSocketServer>;
let admin: boolean, member: boolean;
let clients: InstanceType<typeof WebSocket>[];
const scope = { companyId: "company", userId: "owner", hostId: "local" };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paperclip-terminal-ws-"));
  const registry = path.join(root, "hosts.json");
  await writeFile(registry, JSON.stringify({ version: 1, hosts: [{ id: "local", label: "Local", companyIds: ["company"], terminal: { enabled: true } }] }));
  vi.stubEnv("PAPERCLIP_CCPOCKET_HOSTS_FILE", registry);
  admin = true; member = true; clients = [];
  service = new HostTerminalSessions(async () => {}, { onError: vi.fn(),
    launch: host => launchHostTerminal(host, { ...userInfo(), shell: "/bin/sh", homedir: root }) });
  server = createServer();
  const db = { select: () => ({ from: (table: unknown) => ({ where: async () => (table === instanceUserRoles ? admin : member) ? [{ id: "allowed" }] : [] }) }) };
  transport = setupHostTerminalWebSocketServer(server, db as never, service, {
    resolveSessionFromHeaders: async headers => headers.get("cookie") === "human=owner" ? { user: { id: "owner" } } as never : null,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  endpoint = origin.replace("http:", "ws:") + "/api/companies/company/host-terminals/local/ws";
});
afterEach(async () => {
  for (const client of clients) client.terminate();
  await transport.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});
function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(endpoint, { headers: { Origin: origin, Cookie: "human=owner", ...headers } }); clients.push(ws);
  const frames: Array<{ type: string; data?: string; reason?: string }> = [];
  ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, frames, opened };
}
it.each([{ Origin: "https://evil.invalid" }, { Origin: "" }, { Cookie: "" }, { Authorization: "Bearer fake-agent-key" }] as Record<string, string>[])("rejects untrusted origins and non-cookie identities: %j", async headers => {
  const { opened } = connect(headers); await expect(opened).rejects.toThrow("403");
});
it("rechecks current admin and company membership before upgrade", async () => {
  await service.create(scope); admin = false;
  await expect(connect().opened).rejects.toThrow("403");
  admin = true; member = false;
  await expect(connect().opened).rejects.toThrow("403");
});
it("accepts one token once, echoes through a real PTY and closes the shell on disconnect", async () => {
  const minted = await service.create(scope);
  const first = connect(); await first.opened;
  first.ws.send(JSON.stringify({ type: "auth", sessionId: minted.id, token: minted.token }));
  await vi.waitFor(() => expect(first.frames.some(frame => frame.type === "ready")).toBe(true));
  first.ws.send(JSON.stringify({ type: "resize", cols: 93, rows: 31 }));
  first.ws.send(JSON.stringify({ type: "input", data: "echo hi\nstty size\nprintf 'PID:%s\\n' \"$$\"\n" }));
  await vi.waitFor(() => {
    const output = first.frames.map(frame => frame.data ?? "").join("");
    expect(output).toContain("hi\r\n"); expect(output).toContain("31 93"); expect(output).toMatch(/PID:\d+/);
  });
  const pid = /PID:(\d+)/.exec(first.frames.map(frame => frame.data ?? "").join(""))![1]!;
  const second = connect(); await second.opened;
  second.ws.send(JSON.stringify({ type: "auth", sessionId: minted.id, token: minted.token }));
  await vi.waitFor(() => expect(second.frames).toContainEqual({ type: "closed", reason: "invalid_frame", exitCode: null }));
  first.ws.close();
  await vi.waitFor(() => expect(() => process.kill(Number(pid), 0)).toThrow());
});
it("reports server shutdown and stops active PTYs", async () => {
  const minted = await service.create(scope); const client = connect(); await client.opened;
  client.ws.send(JSON.stringify({ type: "auth", sessionId: minted.id, token: minted.token }));
  await vi.waitFor(() => expect(client.frames.some(frame => frame.type === "ready")).toBe(true));
  await transport.close();
  await vi.waitFor(() => expect(client.frames).toContainEqual({ type: "closed", reason: "server_shutdown", exitCode: null }));
});
