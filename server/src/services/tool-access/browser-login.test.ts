import { describe, expect, it, vi } from "vitest";
import { createBrowserLogin } from "./browser-login.js";

function fixture(payload: unknown = { status: "waiting", mode: "browser", url: "https://login.example/login#token=owned" }) {
  const connection = { transport: "mcp_remote", enabled: true, status: "active", config: { browserLogin: { enabled: true, allowedOrigins: ["https://login.example"] } } };
  const deps = {
    getConnectionRow: vi.fn().mockResolvedValue(connection),
    resolveCredentialHeaders: vi.fn().mockResolvedValue({ Authorization: "Bearer owned-fixture-key" }),
    resolvedRemoteEndpoint: vi.fn().mockResolvedValue("https://mcp.example/private/mcp"),
    requestRemoteHttpEndpoint: vi.fn().mockResolvedValue(Response.json(payload)),
  };
  const invoke = createBrowserLogin(deps as unknown as Parameters<typeof createBrowserLogin>[0]);
  return { invoke, deps, connection };
}
const human = { actorType: "user" as const, actorId: "current-human" };

describe("custom MCP browser sign-in", () => {
  it("rejects agent identities before looking up a credential or connection", async () => {
    const { invoke, deps } = fixture();
    await expect(invoke("connection", "POST", { actorType: "agent", actorId: "agent" })).rejects.toMatchObject({ status: 403 });
    expect(deps.getConnectionRow).not.toHaveBeenCalled();
  });
  it("uses the acting human's grant and only the same-origin companion, without following redirects", async () => {
    const { invoke, deps, connection } = fixture();
    expect(await invoke("connection", "POST", human)).toEqual({ status: "waiting", mode: "browser", url: "https://login.example/login#token=owned" });
    expect(deps.resolveCredentialHeaders).toHaveBeenCalledWith(connection, human);
    expect(deps.resolvedRemoteEndpoint).toHaveBeenCalledWith(connection, human);
    const [url, init] = deps.requestRemoteHttpEndpoint.mock.calls[0];
    expect(url.toString()).toBe("https://mcp.example/private/browser-login");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { Authorization: "Bearer owned-fixture-key" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("strips login credentials from status reads and drops untrusted extra fields", async () => {
    const { invoke } = fixture({ status: "logged_in", mode: "qr", url: "javascript:secret", qrImage: "secret", details: "secret" });
    expect(await invoke("connection", "GET", human)).toEqual({ status: "logged_in", mode: "qr" });
  });
  it("does not invoke disabled or unconfigured connections", async () => {
    const { invoke, deps, connection } = fixture();
    connection.config.browserLogin.enabled = false;
    await expect(invoke("connection", "POST", human)).rejects.toMatchObject({ status: 400 });
    expect(deps.requestRemoteHttpEndpoint).not.toHaveBeenCalled();
  });
  it.each(["javascript:alert(1)", "https://other.example/login", "https://user:password@login.example/", "https://login.example:9443/"])("refuses an unsafe or unapproved browser URL: %s", async (url) => {
    const { invoke } = fixture({ status: "waiting", mode: "browser", url });
    await expect(invoke("connection", "POST", human)).rejects.toMatchObject({ status: 502 });
  });
  it("admits PNG QR data and rejects executable data URIs", async () => {
    const good = fixture({ status: "waiting", mode: "qr", qrImage: "data:image/png;base64,iVBORw==" });
    expect((await good.invoke("connection", "POST", human)).qrImage).toBe("data:image/png;base64,iVBORw==");
    const bad = fixture({ status: "waiting", mode: "qr", qrImage: "data:image/svg+xml,<svg onload=alert(1)>" });
    await expect(bad.invoke("connection", "POST", human)).rejects.toMatchObject({ status: 502 });
  });
  it("returns fixed errors for transport errors, redirects and hostile failure bodies", async () => {
    const { invoke, deps } = fixture();
    for (const status of [302, 401, 500]) {
      deps.requestRemoteHttpEndpoint.mockResolvedValueOnce(new Response("owned-provider-secret", { status }));
      await expect(invoke("connection", "POST", human)).rejects.toMatchObject({ status: 502, message: "Browser sign-in is unavailable. Try again from this connection." });
    }
    deps.requestRemoteHttpEndpoint.mockRejectedValueOnce(new Error("owned-provider-secret"));
    await expect(invoke("connection", "POST", human)).rejects.not.toHaveProperty("message", expect.stringContaining("owned-provider-secret"));
  });
  it("bounds response bytes and rejects unknown login states", async () => {
    const { invoke, deps } = fixture({ status: "maybe", mode: "qr" });
    await expect(invoke("connection", "POST", human)).rejects.toMatchObject({ status: 502 });
    deps.requestRemoteHttpEndpoint.mockResolvedValueOnce(new Response("x".repeat(1_000_001)));
    await expect(invoke("connection", "POST", human)).rejects.toMatchObject({ status: 502 });
  });
});
