import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { assertManagedAiProjectAuth } from "../../server/src/services/ai-connection-runtime.ts";

const execFileAsync = promisify(execFile);
const providers = [
    ["openai", ".codex/config.toml", 'experimental_bearer_token = "fixture-only"\n'],
    ["anthropic", ".claude/settings.json", '{"apiKeyHelper":"fixture-only"}\n'],
    ["anthropic", ".claude/settings.local.json", '{"env":{"ANTHROPIC_AUTH_TOKEN":"fixture-only"}}\n'],
];
const incompatible = (error) => error.status === 422 && error.details?.code === "ai_connection_incompatible";

async function fixture(t) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-auth-scope-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const operatorHome = path.join(root, "operator home");
    const project = path.join(operatorHome, "projects", "example");
    const cwd = path.join(project, "src");
    await mkdir(cwd, { recursive: true });
    t.mock.method(os, "homedir", () => operatorHome);
    const writeConfig = async (directory, relative, content) => {
        const file = path.join(directory, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
    };
    // Exercise the real remote shell script via a local sandbox transport fixture.
    const target = {
        kind: "remote", transport: "sandbox", remoteCwd: cwd,
        runner: {
            async execute(input) {
                try {
                    const output = await execFileAsync(input.command, input.args, {
                        cwd: input.cwd, env: { PATH: process.env.PATH, HOME: operatorHome, ...input.env },
                        timeout: input.timeoutMs,
                    });
                    return { ...output, exitCode: 0, timedOut: false, signal: null };
                } catch (error) {
                    if (typeof error.code !== "number") throw error;
                    assert.equal(error.stdout, "", "auth scan must not expose config contents");
                    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code, timedOut: false, signal: null };
                }
            },
        },
    };
    return { root, operatorHome, project, cwd, writeConfig, target };
}

for (const remote of [false, true]) {
    const location = remote ? "remote" : "local";
    for (const [provider, relative, content] of providers) {
        test(`${location}: global ${relative} does not block a managed connection`, async (t) => {
            const f = await fixture(t);
            await f.writeConfig(f.operatorHome, relative, content);
            await assertManagedAiProjectAuth({ cwd: f.cwd }, provider, remote ? f.target : undefined);
        });
        test(`${location}: project ${relative} still rejects an auth override`, async (t) => {
            const f = await fixture(t);
            await f.writeConfig(f.project, relative, content);
            await assert.rejects(assertManagedAiProjectAuth({ cwd: f.cwd }, provider, remote ? f.target : undefined), incompatible);
        });
    }
    test(`${location}: an ancestor above the user's home is still checked`, async (t) => {
        const f = await fixture(t);
        await f.writeConfig(f.root, ".codex/config.toml", 'model_provider = "fixture"\n');
        await assert.rejects(assertManagedAiProjectAuth({ cwd: f.cwd }, "openai", remote ? f.target : undefined), incompatible);
    });
    test(`${location}: benign project settings pass`, async (t) => {
        const f = await fixture(t);
        await f.writeConfig(f.project, ".codex/config.toml", 'model_reasoning_effort = "medium"\n');
        await assertManagedAiProjectAuth({ cwd: f.cwd }, "openai", remote ? f.target : undefined);
    });
    test(`${location}: home as working directory is the global settings layer`, async (t) => {
        const f = await fixture(t);
        await f.writeConfig(f.operatorHome, ".codex/config.toml", 'env_key = "FIXTURE_KEY"\n');
        await assertManagedAiProjectAuth({ cwd: f.operatorHome }, "openai", remote ? { ...f.target, remoteCwd: f.operatorHome } : undefined);
    });
}

test("explicit CLI authentication/config overrides still fail", async (t) => {
    const f = await fixture(t);
    for (const key of ["args", "extraArgs"]) {
        for (const arg of ["-c", "--config=fixture", "--settings", "--setting-sources", "--api-key", "--auth-token=fixture"]) {
            await assert.rejects(assertManagedAiProjectAuth({ cwd: f.cwd, [key]: [arg] }, "openai"), incompatible);
        }
    }
});

test("local config read errors remain visible", async (t) => {
    const f = await fixture(t);
    await mkdir(path.join(f.project, ".codex", "config.toml"), { recursive: true });
    await assert.rejects(assertManagedAiProjectAuth({ cwd: f.cwd }, "openai"), { code: "EISDIR" });
});

test("remote execution errors still reject the connection", async (t) => {
    const f = await fixture(t);
    f.target.runner.execute = async () => ({ exitCode: 43, stdout: "", stderr: "", timedOut: false, signal: null });
    await assert.rejects(assertManagedAiProjectAuth({ cwd: f.cwd }, "openai", f.target), incompatible);
});
