import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ spawn: vi.fn(), close: vi.fn(async () => undefined), verify: vi.fn(), unsupportedPlatform: false }));
vi.mock("./antigravity-installation.js", () => ({ antigravityNativeDistributionSpec: () => {
  if (setup.unsupportedPlatform) throw new Error("Antigravity has no admitted complete runtime closure for linux-x64");
  return { pinned: true, manifestPath: "/fixture/closure.json" };
} }));
vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: setup.verify }));
import { AntigravityRedirectError, RUNTIME_NOT_INSTALLED_ERROR, UNSUPPORTED_PLATFORM_ERROR, antigravityRedirectTarget, sanitizeAntigravityCredential, startAntigravityBrowserLogin, validateAntigravityAuthorizationUrl, verifyAntigravityCredential } from "./antigravity-auth.js";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const credential = { client_id: CLIENT_ID, client_secret: "fixture-client-secret", refresh_token: "fixture-refresh-token", token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"], project_id: "fixture-project" };
function authorizationUrl() {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: "http://127.0.0.1:18973/",
    scope: credential.scopes.join(" "), state: "fixture_state_0123456789", code_challenge: "a".repeat(43), code_challenge_method: "S256", access_type: "offline", prompt: "consent" });
}
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals(); vi.clearAllMocks(); setup.unsupportedPlatform = false;
});

async function fixture(mode = "success") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-login-test-"))); roots.push(home);
  const peer = join(home, "peer.cjs");
  await writeFile(peer, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.argv[2], mode = process.argv[3];
const requests = [];
let deferredAuthorization = '';
if(mode==='stubborn') {
 process.on('SIGTERM',()=>{});
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
 fs.writeFileSync(path.join(home,'descendant.pid'),String(child.pid));
}
const reader = readline.createInterface({input:process.stdin});
reader.on('line', line => {
 const request=JSON.parse(line); requests.push(request);
 fs.writeFileSync(path.join(home,'requests.json'),JSON.stringify(requests));
 if(request.method==='initialize') {
  if(mode==='early-url') { process.stderr.write('Open the following link to authenticate the ACP server: '+${JSON.stringify(authorizationUrl())}+'\\n'); return; }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{_meta:{antigravity:{paperclipAdmission:1}}},authMethods:[{id:'oauth-personal'}]}})+'\\n');
 } else if(request.method==='authenticate') {
  const url = mode.startsWith('bad-url')||mode==='late-bad-url' ? 'https://example.invalid/steal' : ${JSON.stringify(authorizationUrl())};
  const message='Open the following link to authenticate the ACP server: '+url+'\\n';
  if(['result-first','late-bad-url','late-duplicate-url'].includes(mode)||mode.endsWith('url-after-result')) deferredAuthorization=message+(mode==='late-duplicate-url'?message:'');
  else {process.stderr.write(message.slice(0,42));process.stderr.write(message.slice(42));}
  if(mode==='blocked' || mode==='bad-url' || mode==='stubborn' || mode==='retained') return;
  if(mode==='error') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'do not expose fixture-refresh-token'}})+'\\n');return;}
  fs.mkdirSync(path.join(home,'antigravity-acp'),{mode:0o700});
  fs.writeFileSync(path.join(home,'antigravity-acp/acp_token.json'),${JSON.stringify(JSON.stringify(credential))},{mode:0o600});
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
 } else {throw new Error('inference/session request forbidden');}
});
reader.on('close',()=> {
 // EOF proves the client received the authenticate result before this stderr.
 if(deferredAuthorization) process.stderr.write(deferredAuthorization,()=>process.exit(0));
 else if(mode==='stubborn'||mode==='retained') setInterval(()=>{},1000);
 else process.exit(0);
});
`);
  setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
  setup.spawn.mockImplementation((_args, options) => {
    const child = spawn(process.execPath, [peer, home, mode], { ...options, detached: true }); children.push(child); return child;
  });
  return home;
}

function googleIdentity(emailVerified = true) {
  return vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      expect(options.redirect).toBe("error");
      expect(String(options.body)).toContain("grant_type=refresh_token");
      return new Response(JSON.stringify({ access_token: "fixture-access-token", refresh_token: "fixture-rotated-refresh", token_type: "Bearer" }));
    }
    expect(url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect(options.headers).toEqual({ Authorization: "Bearer fixture-access-token" });
    return new Response(JSON.stringify({ email: "person@example.test", email_verified: emailVerified }));
  });
}

describe("Antigravity setup-only Google authentication", () => {
  it.each(["network", "unverified"])("preserves an OAuth rotation when userinfo %s verification fails", async failure => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-rotation-test-"))); roots.push(home);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "antigravity-acp"), { mode: 0o700 });
    const token = join(home, "antigravity-acp", "acp_token.json");
    await writeFile(token, JSON.stringify(credential), { mode: 0o600 });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-newest-rotation", token_type: "Bearer" }));
    if (failure === "network") fetch.mockRejectedValueOnce(new Error("fixture userinfo unavailable"));
    else fetch.mockResolvedValueOnce(Response.json({ email: "person@example.test", email_verified: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(verifyAntigravityCredential(home)).rejects.toThrow();
    expect(JSON.parse(await readFile(token, "utf8")).refresh_token).toBe("fixture-newest-rotation");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // The login predicate keeps its five-second bound. Allow ten more seconds
  // for fixture startup and the durable mocked credential checks on a busy CI worker.
  it.each(["success", "result-first", "url-after-result"])("performs native authenticate, retires it, verifies identity, and preserves refresh rotation without repeated status network calls (%s)", async mode => {
    const home = await fixture(mode), fetch = googleIdentity(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5_000 });
    expect(login.outcome).toBe("success");
    expect(login.authorizationUrl).toBe(authorizationUrl());
    expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8")).map((request: { method: string }) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(setup.spawn.mock.calls[0]![1].env).toMatchObject({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "/usr/bin/true" });
    expect(Object.keys(setup.spawn.mock.calls[0]![1].env).some(key => /^(?:GOOGLE_|GEMINI_API|ANTIGRAVITY_|PYTHON|NODE_OPTIONS|HTTP_PROXY)/.test(key))).toBe(false);
    expect(setup.close).toHaveBeenCalledOnce();
    expect(children[0]!.exitCode).toBe(0);
    const verified = await verifyAntigravityCredential(home);
    expect(verified.accountEmail).toBe("person@example.test");
    expect(JSON.parse(verified.credential).refresh_token).toBe("fixture-rotated-refresh");
    expect(JSON.parse(await readFile(join(home, "antigravity-acp/acp_token.json"), "utf8")).refresh_token).toBe("fixture-rotated-refresh");
    expect(fetch).toHaveBeenCalledTimes(2);
    await login.abort();
    // Runtime verification outside a live browser attempt must not retain a
    // credential indefinitely in the browser status cache.
    await verifyAntigravityCredential(home);
    await verifyAntigravityCredential(home);
    expect(fetch).toHaveBeenCalledTimes(6);
  }, 15_000);

  it.each(["error", "bad-url", "early-url", "late-bad-url", "late-duplicate-url", "bad-url-after-result"])("rejects %s without leaking provider text or calling Google", async mode => {
    const home = await fixture(mode), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.error).not.toContain("fixture");
    if (mode.startsWith("bad-url") || ["early-url", "late-bad-url"].includes(mode)) expect(login.authorizationUrl).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unadmitted server platform explicitly instead of a retryable generic failure", async () => {
    const home = await fixture(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    setup.unsupportedPlatform = true;
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await login.abort();
    expect(login.error).toBe(UNSUPPORTED_PLATFORM_ERROR);
    expect(login.authorizationUrl).toBeUndefined();
    expect(setup.verify).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("abort retires a waiting native flow without session requests", async () => {
    const home = await fixture("blocked"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    login.abort();
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.outcome).toBe("failure"); expect(fetch).not.toHaveBeenCalled();
    expect(children[0]!.exitCode).toBe(0);
  });

  it("abort waits for SIGKILL retirement of a login and inherited descendant that ignore EOF and SIGTERM", async () => {
    const home = await fixture("stubborn"); vi.stubGlobal("fetch", vi.fn());
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const descendant = (await readFile(join(home, "descendant.pid"), "utf8")).trim();
    await login.abort();
    expect(children[0]!.signalCode).toBe("SIGKILL");
    expect(setup.close).toHaveBeenCalledOnce();
    let state = "";
    try { state = execFileSync("/bin/ps", ["-o", "stat=", "-p", descendant], { encoding: "utf8" }).trim(); } catch {}
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("keeps abort, the command lease and the private home owned through uncertain retirement until the actual child exits", async () => {
    const home = await fixture("retained"); vi.stubGlobal("fetch", vi.fn());
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const child = children[0]!, realKill = process.kill.bind(process);
    let blockProof = true;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (blockProof && pid === -child.pid! && signal === 0) throw Object.assign(new Error("controlled process-state uncertainty"), { code: "EACCES" });
      return realKill(pid, signal);
    });
    const stopped = login.abort(), releaseHome = vi.fn(() => rm(home, { recursive: true, force: true }));
    const cleaned = stopped.then(releaseHome);
    await vi.waitFor(() => expect(login.error).toContain("still stopping"), { timeout: 5_000 });
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    expect(setup.close).not.toHaveBeenCalled(); expect(releaseHome).not.toHaveBeenCalled();
    await expect(access(home)).resolves.toBeUndefined();
    blockProof = false;
    realKill(-child.pid!, "SIGKILL");
    await cleaned;
    expect(child.signalCode).toBe("SIGKILL");
    expect(setup.close).toHaveBeenCalledOnce(); expect(releaseHome).toHaveBeenCalledOnce();
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept an unverified Google account after native authentication", async () => {
    const home = await fixture(); vi.stubGlobal("fetch", googleIdentity(false));
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it("requires the pinned OAuth client and token destination and strips unrelated native fields", () => {
    expect(JSON.parse(sanitizeAntigravityCredential(JSON.stringify({ ...credential, endpoint: "https://example.invalid", access_token: "discard" })))).toEqual(credential);
    expect(sanitizeAntigravityCredential(JSON.stringify({ ...credential, scopes: [...credential.scopes].reverse() }))).toBe(sanitizeAntigravityCredential(JSON.stringify(credential)));
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, token_uri: "https://example.invalid/token" }))).toThrow("Invalid Antigravity credential");
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, client_id: "another-client" }))).toThrow("Invalid Antigravity credential");
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, scopes: ["openid"] }))).toThrow("Invalid Antigravity credential");
  });

  it("requires Google PKCE and a numeric loopback redirect", () => {
    expect(validateAntigravityAuthorizationUrl(authorizationUrl())).toBe(authorizationUrl());
    for (const url of [authorizationUrl().replace("accounts.google.com", "example.invalid"), authorizationUrl().replace("S256", "plain"), authorizationUrl().replace("127.0.0.1", "localhost"), authorizationUrl() + "&state=duplicate"]) {
      expect(() => validateAntigravityAuthorizationUrl(url)).toThrow();
    }
  });
});

const CODE = "4/0AfixtureCodeCanary_0123456789-abc";
const STATE = "fixture_state_0123456789";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email";
function pasted(overrides: Record<string, string | null> = {}, base = "http://127.0.0.1:18973/") {
  const url = new URL(base);
  const values: Record<string, string | null> = { state: STATE, code: CODE, scope: SCOPE, authuser: "0", prompt: "consent", ...overrides };
  for (const [key, value] of Object.entries(values)) if (value !== null) url.searchParams.set(key, value);
  return url.href;
}
function rejection(value: string, authorization = authorizationUrl()) {
  try { antigravityRedirectTarget(value, authorization); } catch (error) { return error as Error; }
  throw new Error("expected the pasted address to be rejected");
}

describe("Antigravity remote-browser redirect address", () => {
  it("accepts the exact port and state and forwards only code, state and scope to the attempt's own redirect_uri", () => {
    const target = new URL(antigravityRedirectTarget("  " + pasted() + "\n", authorizationUrl()));
    expect(target.origin).toBe("http://127.0.0.1:18973");
    expect(target.pathname).toBe("/");
    expect([...target.searchParams.keys()].sort()).toEqual(["code", "scope", "state"]);
    expect(target.searchParams.get("code")).toBe(CODE);
    expect(target.searchParams.get("state")).toBe(STATE);
    expect(target.searchParams.get("scope")).toBe(SCOPE);
    expect(new URL(antigravityRedirectTarget(pasted({ scope: null }), authorizationUrl())).searchParams.has("scope")).toBe(false);
  });

  it.each([
    ["a wrong state", pasted({ state: "another_state_0123456789" }), /different sign-in attempt/],
    ["a state of another length", pasted({ state: STATE + "x" }), /different sign-in attempt/],
    ["a missing state", pasted({ state: null }), /different sign-in attempt/],
    ["a wrong port", pasted({}, "http://127.0.0.1:18974/"), /different sign-in attempt/],
    ["another host", pasted({}, "http://localhost:18973/"), /not the Google redirect address/],
    ["a remote host", pasted({}, "http://example.invalid:18973/"), /not the Google redirect address/],
    ["https", pasted({}, "https://127.0.0.1:18973/"), /not the Google redirect address/],
    ["user information", pasted({}, "http://user:pass@127.0.0.1:18973/"), /not the Google redirect address/],
    ["a fragment", pasted() + "#fragment", /not the Google redirect address/],
    ["a non-root path", pasted({}, "http://127.0.0.1:18973/callback"), /not the Google redirect address/],
    ["a duplicate parameter", pasted() + "&code=" + CODE, /not the Google redirect address/],
    ["an unknown parameter", pasted({ extra: "1" }), /not the Google redirect address/],
    ["a bad code character set", pasted({ code: "4/0A bad<code>canary" }), /not the Google redirect address/],
    ["a short code", pasted({ code: "abc" }), /not the Google redirect address/],
    ["a bad scope", pasted({ scope: "scope<script>" }), /not the Google redirect address/],
    ["an oversized address", pasted({ prompt: "x".repeat(5000) }), /not the Google redirect address/],
    ["an embedded newline", pasted().replace("code=", "\ncode="), /not the Google redirect address/],
    ["an embedded space", pasted().replace("&code=", "&code= "), /not the Google redirect address/],
    ["a control character", pasted() + "\u0007", /not the Google redirect address/],
    ["an empty value", "   ", /not the Google redirect address/],
    ["a non-URL value", "not a url canary", /not the Google redirect address/],
  ])("rejects %s with fixed copy that never echoes the address, code or state", (_label, value, message) => {
    const error = rejection(value);
    expect(error).toBeInstanceOf(AntigravityRedirectError);
    expect(error.name).toBe("AntigravityRedirectError");
    expect(error.message).toMatch(message);
    for (const secret of [CODE, STATE, "canary", "127.0.0.1:18973", "bad<code>"]) expect(error.message).not.toContain(secret);
  });

  it("reports a Google denial as denied, not as a code failure", () => {
    const error = rejection(pasted({ error: "access_denied", code: null, error_description: CODE }));
    expect(error.message).toMatch(/did not grant access/);
    expect(error.message).not.toContain(CODE);
  });

  it("rejects when the attempt's authorization address has no usable redirect or state", () => {
    expect(() => antigravityRedirectTarget(pasted(), "not a url")).toThrow(AntigravityRedirectError);
    expect(() => antigravityRedirectTarget(pasted(), authorizationUrl().replace(/state=[^&]*&?/, ""))).toThrow(AntigravityRedirectError);
  });

  describe("submitCode on a live attempt", () => {
    const listeners: Server[] = [];
    afterEach(async () => { await Promise.all(listeners.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
    async function listen(received: string[]) {
      const server = createServer((request, response) => { received.push(request.url ?? ""); response.end("ok"); });
      listeners.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(18973, "127.0.0.1", resolve); });
    }

    it("replays a valid address once to the loopback listener, keeps the attempt open after a rejected paste and refuses a second valid paste", async () => {
      const home = await fixture("blocked"); vi.stubGlobal("fetch", vi.fn());
      const received: string[] = [];
      await listen(received);
      const login = startAntigravityBrowserLogin(home);
      await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
      await expect(login.submitCode!(pasted({ state: "another_state_0123456789" }))).rejects.toBeInstanceOf(AntigravityRedirectError);
      expect(received).toEqual([]);
      await login.submitCode!(pasted());
      expect(received).toHaveLength(1);
      const forwarded = new URL(received[0]!, "http://127.0.0.1:18973");
      expect([...forwarded.searchParams.keys()].sort()).toEqual(["code", "scope", "state"]);
      expect(forwarded.searchParams.get("state")).toBe(STATE);
      const second = await login.submitCode!(pasted()).catch((error: Error) => error);
      expect(second).toBeInstanceOf(AntigravityRedirectError);
      expect((second as Error).message).toMatch(/already received/);
      expect(received).toHaveLength(1);
      await login.abort();
      await expect(login.submitCode!(pasted())).rejects.toThrow(/already received/);
    });

    it("hides a failed replay behind fixed copy and still treats the address as used", async () => {
      const home = await fixture("blocked"); vi.stubGlobal("fetch", vi.fn());
      const login = startAntigravityBrowserLogin(home);
      await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
      const failure = await login.submitCode!(pasted()).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(AntigravityRedirectError);
      expect((failure as Error).message).toMatch(/could not be completed on the server/);
      expect((failure as Error).message).not.toContain(CODE);
      await expect(login.submitCode!(pasted())).rejects.toThrow(/already received/);
      await login.abort();
    });

    it("rejects a paste before the authorization address exists and after the attempt has ended", async () => {
      const home = await fixture("error"); vi.stubGlobal("fetch", vi.fn());
      const login = startAntigravityBrowserLogin(home);
      await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
      await expect(login.submitCode!(pasted())).rejects.toThrow(/already received/);
    });
  });

  it("tells the administrator to install the runtime when its closure manifest is missing", async () => {
    const home = await fixture(); vi.stubGlobal("fetch", vi.fn());
    setup.verify.mockRejectedValue(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", path: "/fixture/closure.json" }));
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await login.abort();
    expect(login.error).toBe(RUNTIME_NOT_INSTALLED_ERROR);
    expect(RUNTIME_NOT_INSTALLED_ERROR).not.toContain("/fixture");
    expect(UNSUPPORTED_PLATFORM_ERROR).toContain("Linux x64");
  });
});
