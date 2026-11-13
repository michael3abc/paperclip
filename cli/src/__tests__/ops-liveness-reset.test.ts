import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpsCommands, resolveLivenessResetOptions } from "../commands/ops-liveness-reset.js";

const created: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-ops-liveness-reset-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe("ops liveness-reset options", () => {
  it("refuses to run without --receipt", () => {
    expect(() => resolveLivenessResetOptions({ dryRun: true }, tempDir())).toThrow(/--receipt <path> is required/);
    expect(() => resolveLivenessResetOptions({ apply: true, receipt: "  " }, tempDir())).toThrow(/--receipt <path> is required/);
  });

  it("requires exactly one of --dry-run or --apply", () => {
    const cwd = tempDir();
    expect(() => resolveLivenessResetOptions({ receipt: "r.json" }, cwd)).toThrow(/exactly one of --dry-run or --apply/);
    expect(() => resolveLivenessResetOptions({ dryRun: true, apply: true, receipt: "r.json" }, cwd)).toThrow(/exactly one/);
  });

  it("refuses an existing receipt and a missing receipt directory", () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, "existing.json"), "{}");
    expect(() => resolveLivenessResetOptions({ apply: true, receipt: "existing.json" }, cwd)).toThrow(/Receipt already exists/);
    expect(fs.readFileSync(path.join(cwd, "existing.json"), "utf8")).toBe("{}");
    expect(() => resolveLivenessResetOptions({ dryRun: true, receipt: "missing/r.json" }, cwd)).toThrow(/Receipt directory does not exist/);
  });

  it("rejects never-lifted pause holds and invalid run ids before connecting", () => {
    const cwd = tempDir();
    expect(() => resolveLivenessResetOptions({ dryRun: true, receipt: "r.json", liftHold: ["manual"] }, cwd)).toThrow(/never lifts/);
    expect(() => resolveLivenessResetOptions({ dryRun: true, receipt: "r.json", liveRun: ["not-a-uuid"] }, cwd)).toThrow(/Invalid UUID/);
  });

  it("resolves a valid apply with an absolute receipt path", () => {
    const cwd = tempDir();
    const runId = "11111111-2222-4333-8444-555555555555";
    expect(resolveLivenessResetOptions({ apply: true, receipt: "r.json", serverStopped: true, liveRun: [runId, runId] }, cwd))
      .toEqual({ mode: "apply", receiptPath: path.join(cwd, "r.json"), serverStopped: true, liveRunIds: [runId] });
  });

  it("registers `ops liveness-reset`", () => {
    const program = new Command();
    registerOpsCommands(program);
    const command = program.commands.find(c => c.name() === "ops")?.commands.find(c => c.name() === "liveness-reset");
    expect(command?.options.map(option => option.long)).toEqual(expect.arrayContaining([
      "--dry-run", "--apply", "--receipt", "--server-stopped", "--live-run", "--lift-hold", "--company", "--config",
    ]));
  });
});
