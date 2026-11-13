import { describe, expect, it } from "vitest";
import { modelHasEffortSuffix, resolveAgyModelEffort, resolveAgyPrintTimeoutSec } from "./execute.js";
import { normalizeAgyModelId } from "../index.js";

describe("modelHasEffortSuffix and resolveAgyPrintTimeoutSec", () => {
  it("modelHasEffortSuffix detects effort-suffixed model ids", () => {
    expect(modelHasEffortSuffix("gemini-3.6-flash-high")).toBe(true);
    expect(modelHasEffortSuffix("gemini-3.6-flash-medium")).toBe(true);
    expect(modelHasEffortSuffix("gpt-oss-120b-medium")).toBe(true);
    expect(modelHasEffortSuffix("gemini-4-argon-xhigh")).toBe(true);
    expect(modelHasEffortSuffix("gemini-4-argon-max")).toBe(true);
    expect(modelHasEffortSuffix("auto")).toBe(false);
    expect(modelHasEffortSuffix("claude-sonnet-4-6")).toBe(false);
    expect(modelHasEffortSuffix("claude-opus-4-6-thinking")).toBe(false);
  });

  it.each(["high", "xhigh", "max"])("preserves a discovered %s model without a conflicting effort flag", (effort) => {
    const model = `gemini-4-argon-${effort}`;
    expect(resolveAgyModelEffort(model, effort)).toEqual({ model, effort: null, warning: null });
  });

  it("accepts CC Pocket Bridge selectors carried over after a worker switched to agy", () => {
    expect(normalizeAgyModelId("michael-server/antigravity/gemini-4-argon-high")).toBe("gemini-4-argon-high");
    expect(normalizeAgyModelId("antigravity/gemini-4-hydrogen-xhigh")).toBe("gemini-4-hydrogen-xhigh");
    expect(normalizeAgyModelId(" gemini-4-argon-low ")).toBe("gemini-4-argon-low");
    expect(normalizeAgyModelId("michael-server/claude/opus")).toBe("michael-server/claude/opus");
    expect(resolveAgyModelEffort("michael-server/antigravity/gemini-4-argon-high", "high"))
      .toEqual({ model: "gemini-4-argon-high", effort: null, warning: null });
    expect(resolveAgyModelEffort("michael-server/antigravity/gemini-4-argon-high", ""))
      .toEqual({ model: "gemini-4-argon-high", effort: null, warning: null });
  });

  it("agy's print timeout stays under the Paperclip run timeout when resolved", () => {
    expect(resolveAgyPrintTimeoutSec(3600)).toBeLessThan(3600);
    expect(resolveAgyPrintTimeoutSec(3600)).toBe(3420);
    expect(resolveAgyPrintTimeoutSec(120)).toBe(110);
    expect(resolveAgyPrintTimeoutSec(10)).toBe(30);
    expect(resolveAgyPrintTimeoutSec(0)).toBe(0);
  });
});
