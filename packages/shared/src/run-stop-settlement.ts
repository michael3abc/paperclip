/** Public, bounded projection of the server-owned cancellation obligation. */
export interface RunStopSettlement {
  state: "stopping" | "cleaning" | "needs_attention" | "settled";
  reason: string;
  attempts: number;
  checkedAt: string | null;
  nextCheckAt: string | null;
}

export function readRunStopSettlement(result: Record<string, unknown> | null | undefined): RunStopSettlement | null {
  const value = result?.stopSettlement as Record<string, unknown> | undefined;
  if (!value || value.schema !== "paperclip.run-stop-settlement.v1" ||
      !["stopping", "cleaning", "needs_attention", "settled"].includes(String(value.state))) return null;
  return { state: value.state as RunStopSettlement["state"],
    reason: typeof value.reason === "string" ? value.reason.slice(0, 160) : "stop_unverified",
    attempts: Number.isSafeInteger(value.attempts) ? Number(value.attempts) : 0,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    nextCheckAt: typeof value.nextCheckAt === "string" ? value.nextCheckAt : null };
}
