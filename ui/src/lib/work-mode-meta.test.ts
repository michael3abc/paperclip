import { describe, expect, it } from "vitest";

import { isIssueWorkMode, nextWorkMode, titleForPendingWorkMode, workModeMetaFor, workModeMetaList } from "./work-mode-meta";

describe("work mode metadata", () => {
  it("orders issue work modes as auto, planning, then ask", () => {
    expect(workModeMetaList().map((mode) => mode.value)).toEqual(["standard", "planning", "ask"]);
    expect(workModeMetaList().map((mode) => mode.label)).toEqual(["Auto mode", "Plan mode", "Ask mode"]);
  });

  it("cycles issue work modes as auto, planning, ask, then auto", () => {
    expect(nextWorkMode("standard")).toBe("planning");
    expect(nextWorkMode("planning")).toBe("ask");
    expect(nextWorkMode("ask")).toBe("standard");
  });

  it("offers native plan after Plan mode only where a composer enables it", () => {
    expect(workModeMetaList({ nativePlan: true }).map((mode) => mode.value)).toEqual(["standard", "planning", "native_plan", "ask"]);
    expect(nextWorkMode("planning", { nativePlan: true })).toBe("native_plan");
    expect(nextWorkMode("native_plan", { nativePlan: true })).toBe("ask");
    // A composer without the option leaves a saved native plan for Auto mode.
    expect(nextWorkMode("native_plan")).toBe("standard");
    expect(workModeMetaFor("native_plan")).toMatchObject({ value: "native_plan", label: "Native plan", tone: "planning" });
    expect(isIssueWorkMode("native_plan")).toBe(true);
    expect(isIssueWorkMode("native")).toBe(false);
  });

  it("uses graduated tooltip copy", () => {
    expect(titleForPendingWorkMode("standard")).toBe("Auto mode for this submission. Click to change.");
    expect(titleForPendingWorkMode("planning")).toBe("Plan mode is on for this submission. Click to change.");
    expect(titleForPendingWorkMode("native_plan")).toMatch(/^Native plan is on for this submission\. Click to change\./);
  });
});
