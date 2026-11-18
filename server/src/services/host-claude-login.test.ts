import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authorizationUrl, checkHostClaudeLogin, hostClaudeSession, listHostClaudeLogins, startHostClaudeLogin } from "./host-claude-login.js";
let root: string;
const pending: string[] = [];
const url = "https://claude.com/cai/oauth/authorize?client_id=fixture&state=fixture-state&code_challenge=fixture-challenge";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "host-login-"));
  const command = path.join(root, "claude");
  await writeFile(command, `#!/usr/bin/python3
import json,os,sys
from pathlib import Path
home=Path(os.environ['CLAUDE_CONFIG_DIR'])
if sys.argv[1:]==['auth','status','--json']:
 print(json.dumps({'loggedIn': (home/'logged-in').exists(), 'authMethod': 'claude.ai'}))
else:
 assert sys.argv[1:]==['auth','login','--claudeai']
 assert not any(k.startswith('ANTHROPIC_') for k in os.environ)
 (home/'pid').write_text(str(os.getpid()))
 print(${JSON.stringify(url)},flush=True)
 code=input()
 if code!='fixture-code': sys.exit(1)
 (home/'logged-in').write_text('fixture-only')
`);
  await chmod(command, 0o700);
  await writeFile(path.join(root, "hosts.json"), JSON.stringify({ version: 1, hosts: [
    { id: root.split("/").at(-1), label: "Test host", companyIds: ["company"], claudeLogin: { command, configDir: root } },
    { id: "foreign", label: "Foreign", companyIds: ["other"] },
  ] }));
  vi.stubEnv("PAPERCLIP_CCPOCKET_HOSTS_FILE", path.join(root, "hosts.json"));
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-private-token");
});
afterEach(async () => {
  for (const id of pending.splice(0)) hostClaudeSession("company", "owner", id, "cancel");
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("keeps company enrollment and unknown hosts isolated", async () => {
  const hosts = await listHostClaudeLogins("company");
  expect(hosts).toHaveLength(1);
  expect(hosts[0].available).toBe(true);
  expect(await listHostClaudeLogins("absent")).toEqual([]);
  await expect(startHostClaudeLogin("company", "owner", "foreign")).rejects.toMatchObject({ status: 404 });
});
it("uses the actual terminal, verifies native credentials, and keeps secrets out of the view", async () => {
  const host = (await listHostClaudeLogins("company"))[0];
  expect(await checkHostClaudeLogin("company", host.id)).toEqual({ loggedIn: false });
  const session = await startHostClaudeLogin("company", "owner", host.id); pending.push(session.id);
  await vi.waitFor(() => expect(hostClaudeSession("company", "owner", session.id).status).toBe("waiting"));
  expect(() => hostClaudeSession("other", "owner", session.id)).toThrow();
  expect(() => hostClaudeSession("company", "other", session.id)).toThrow();
  await expect(startHostClaudeLogin("company", "owner", host.id)).rejects.toMatchObject({ status: 409 });
  expect(() => hostClaudeSession("company", "owner", session.id, "code", "bad\ncommand")).toThrow();
  const submitted = hostClaudeSession("company", "owner", session.id, "code", "fixture-code");
  expect(submitted.authorizationUrl).toBeUndefined();
  expect(() => hostClaudeSession("company", "owner", session.id, "code", "fixture-code")).toThrow();
  await vi.waitFor(() => expect(hostClaudeSession("company", "owner", session.id).status).toBe("authenticated"));
  expect(await checkHostClaudeLogin("company", host.id)).toEqual({ loggedIn: true });
  expect(JSON.stringify(hostClaudeSession("company", "owner", session.id))).not.toMatch(/fixture-code|fixture-private-token|authorize/);
});
it("cancels the native process and never treats old credentials as a new success", async () => {
  const host = (await listHostClaudeLogins("company"))[0];
  const session = await startHostClaudeLogin("company", "owner", host.id); pending.push(session.id);
  await vi.waitFor(() => expect(hostClaudeSession("company", "owner", session.id).status).toBe("waiting"));
  const pid = Number(await readFile(path.join(root, "pid"), "utf8"));
  hostClaudeSession("company", "owner", session.id, "cancel");
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  expect(hostClaudeSession("company", "owner", session.id).status).toBe("cancelled");
});
it("accepts native OSC hyperlinks while rejecting foreign or secret-bearing URLs", () => {
  expect(authorizationUrl(`Opening browser: \x1b]8;;${url}\x07${url}\x1b]8;;\x07`)).toBe(url);
  expect(authorizationUrl(url.replace("claude.com", "claude.com.evil.test"))).toBeUndefined();
  expect(authorizationUrl(url + "&token=sk-ant-private")).toBeUndefined();
  expect(authorizationUrl(url + "&state=duplicate")).toBeUndefined();
});
it("expires a live sign-in and kills the native terminal at its deadline", async () => {
  const host = (await listHostClaudeLogins("company"))[0];
  const session = await startHostClaudeLogin("company", "owner", host.id); pending.push(session.id);
  await vi.waitFor(() => expect(hostClaudeSession("company", "owner", session.id).status).toBe("waiting"));
  const pid = Number(await readFile(path.join(root, "pid"), "utf8"));
  vi.useFakeTimers();
  try {
    // The timer existed before fake timers, so exercise deadline via the real
    // session API clock separately from terminal cleanup in the cancel test.
    vi.setSystemTime(Date.now() + 301_000);
    expect(hostClaudeSession("company", "owner", session.id).status).toBe("failed");
  } finally { vi.useRealTimers(); }
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
});
