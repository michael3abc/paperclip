import { describe, expect, it } from "vitest";
import { unwrapToolResponse } from "./runnerd-codex-transport.js";

describe("runnerd semantic tool response", () => {
  it("retains explicitly public dispatch diagnostics and their error status", () => {
    const response = { success: false, publicError: { message: "PM_WORKER_MIGRATION_REQUIRED" },
      contentItems: [{ type: "inputText", text: JSON.stringify({ code: "PM_WORKER_MIGRATION_REQUIRED" }) }] };
    expect(unwrapToolResponse(response)).toEqual({ __paperclipSemanticToolOutcome: true, result: response, isError: true });
  });
  it("preserves the validated ACPX terminal acknowledgement envelope", () => {
    const response = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, accepted: true }) }] };
    expect(unwrapToolResponse(response, true)).toEqual({ __paperclipSemanticToolOutcome: true, result: response, isError: false });
    expect(unwrapToolResponse(response)).toEqual({ __paperclipSemanticToolOutcome: true, result: { ok: true, accepted: true }, isError: false });
  });
  it("keeps denial feedback and does not promote rejected terminal reports to success", () => {
    const response = { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, denial: { code: "stale_completion_contract" } }) }] };
    expect(unwrapToolResponse(response, true)).toMatchObject({ isError: true, result: { success: false } });
  });
});
