import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkHostCodexLogin, hostCodexSession, listHostCodexLogins, startHostCodexLogin } from "./host-codex-login.js";
let root: string;
const pending: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "host-codex-login-"));
  const command = path.join(root, "codex");
  // Mirrors Codex 0.159.3 device-auth output: colored URL and code, CRLF lines.
  await writeFile(command, `#!/usr/bin/python3
import os,sys,time
from pathlib import Path
home=Path(os.environ['CODEX_HOME'])
assert not any(k.startswith('OPENAI_') for k in os.environ)
if sys.argv[1:]==['login','status']:
 if (home/'logged-in').exists(): print('Logged in using ChatGPT'); sys.exit(0)
 print('Not logged in', file=sys.stderr); sys.exit(1)
assert sys.argv[1:]==['login','--device-auth']
(home/'pid').write_text(str(os.getpid()))
sys.stdout.write('Follow these steps to sign in with ChatGPT using device code authorization:\\r\\n\\r\\n1. Open this link in your browser and sign in to your account\\r\\n   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m\\r\\n\\r\\n2. Enter this one-time code \\x1b[90m(expires in 15 minutes)\\x1b[0m\\r\\n   \\x1b[94mAB12-CD345\\x1b[0m\\r\\n')
sys.stdout.flush()
while not (home/'approve').exists(): time.sleep(0.05)
(home/'logged-in').write_text('fixture-only')
`);
  await chmod(command, 0o700);
  await writeFile(path.join(root, "hosts.json"), JSON.stringify({ version: 1, hosts: [
    { id: root.split("/").at(-1), label: "Test host", companyIds: ["company"], codexLogin: { command, codexHome: root } },
    { id: "claude-only", label: "Claude only", companyIds: ["company"], claudeLogin: { command: "/usr/bin/true" } },
    { id: "foreign", label: "Foreign", companyIds: ["other"], codexLogin: { command } },
  ] }));
  vi.stubEnv("PAPERCLIP_CCPOCKET_HOSTS_FILE", path.join(root, "hosts.json"));
  vi.stubEnv("OPENAI_API_KEY", "fixture-private-key");
});
afterEach(async () => {
  for (const id of pending.splice(0)) hostCodexSession("company", "owner", id, "cancel");
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it("lists only company hosts and marks which ones opted into Codex sign-in", async () => {
  const hosts = await listHostCodexLogins("company");
  expect(hosts.map(h => h.available)).toEqual([true, false]);
  expect(await listHostCodexLogins("absent")).toEqual([]);
  await expect(startHostCodexLogin("company", "owner", "foreign")).rejects.toMatchObject({ status: 404 });
  await expect(startHostCodexLogin("company", "owner", "claude-only")).rejects.toMatchObject({ status: 400 });
});
it("shows the device page and code, then verifies the native ChatGPT login", async () => {
  const host = (await listHostCodexLogins("company"))[0];
  expect(await checkHostCodexLogin("company", host.id)).toEqual({ loggedIn: false });
  const session = await startHostCodexLogin("company", "owner", host.id); pending.push(session.id);
  await vi.waitFor(() => expect(hostCodexSession("company", "owner", session.id).status).toBe("waiting"));
  const waiting = hostCodexSession("company", "owner", session.id);
  expect(waiting.verificationUrl).toBe("https://auth.openai.com/codex/device");
  expect(waiting.userCode).toBe("AB12-CD345");
  expect(() => hostCodexSession("other", "owner", session.id)).toThrow();
  expect(() => hostCodexSession("company", "other", session.id)).toThrow();
  await expect(startHostCodexLogin("company", "owner", host.id)).rejects.toMatchObject({ status: 409 });
  await writeFile(path.join(root, "approve"), "");
  await vi.waitFor(() => expect(hostCodexSession("company", "owner", session.id).status).toBe("authenticated"));
  const done = hostCodexSession("company", "owner", session.id);
  expect(done.userCode).toBeUndefined();
  expect(JSON.stringify(done)).not.toMatch(/AB12|fixture-private-key|auth\.openai/);
  expect(await checkHostCodexLogin("company", host.id)).toEqual({ loggedIn: true });
});
it("cancels the native process and does not count an old login as a new success", async () => {
  const host = (await listHostCodexLogins("company"))[0];
  const session = await startHostCodexLogin("company", "owner", host.id); pending.push(session.id);
  await vi.waitFor(() => expect(hostCodexSession("company", "owner", session.id).status).toBe("waiting"));
  const pid = Number(await readFile(path.join(root, "pid"), "utf8"));
  const cancelled = hostCodexSession("company", "owner", session.id, "cancel");
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.userCode).toBeUndefined();
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  expect(hostCodexSession("company", "owner", session.id).status).toBe("cancelled");
});
it("rejects registry entries with unsafe command paths", async () => {
  await writeFile(path.join(root, "hosts.json"), JSON.stringify({ version: 1, hosts: [
    { id: "bad", label: "Bad", companyIds: ["company"], codexLogin: { command: "codex; rm -rf /" } },
  ] }));
  await expect(listHostCodexLogins("company")).rejects.toMatchObject({ status: 400 });
});
