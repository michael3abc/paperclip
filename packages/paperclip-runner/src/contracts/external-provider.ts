import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";

export type ExternalBotProviderKind = "openai_dot" | "grok_bot";
export const GROK_BRIDGE_REVISION = "grok-bot-mcp-v1" as const;
export const DOT_BRIDGE_REVISION = "dot-mcp-v1" as const;
export const MUSE_BRIDGE_REVISION = "muse-v1" as const;
export interface DotBindingSnapshot {
  bindingId: string;
  bindingGeneration: number;
  companyId: string;
  agentId: string;
  acceptByUnixMs: number;
  expiresAtUnixMs: number;
}
/** Public immutable Muse authority; credentials never enter the execution input. */
export interface MuseBindingSnapshot extends DotBindingSnapshot {}
export interface ExternalProviderBinding extends Omit<DotBindingSnapshot, "acceptByUnixMs" | "expiresAtUnixMs"> {
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  assignmentRevision: number;
}
export interface ExternalProviderOperation {
  requestId: string;
  bindingId: string;
  bindingGeneration: number;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  assignmentRevision: number;
  digest: string;
  action: "accept" | "tool" | "progress" | "finish" | "renew" | "request_user_input" | "consume_input";
  input: Record<string, unknown>;
}
/** Broker port uses only the authenticated run's existing PRP command lane. */
export interface ExternalProviderPort {
  dispatch(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  settle(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  /** Persist the exact answer delivery before acknowledging the Runner event. */
  inputAvailable?(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  attach(send: (operation: ExternalProviderOperation) => Promise<void>, revoke?: () => Promise<void>, hasProviderCheckpoint?: boolean): Promise<() => Promise<void>>;
}
export function externalOperationDigest(action: ExternalProviderOperation["action"], input: Record<string, unknown>): string {
  return digestPaperclipSemanticContent({ action, input });
}

/** Only fixed protocol reasons cross the broker boundary; never raw Runner diagnostics. */
export function externalOperationRejection(reason: unknown): { status: "rejected"; code?: string; message: string } {
  if (reason === "Dot completion requires settled tool calls" || reason === "Dot cannot finish with unsettled tool calls") {
    return { status: "rejected", code: "unsettled_tool_calls",
      message: "Reconcile pending tool operations with their original request IDs before submitting completion." };
  }
  if (reason === "Dot completion was already accepted") {
    return { status: "rejected", code: "completion_already_accepted",
      message: "The completion report was accepted. Submit the same accepted report with the external finish operation." };
  }
  if (reason === "Dot completion is pending") {
    return { status: "rejected", code: "completion_pending",
      message: "Reconcile the completion tool's original request ID before issuing another tool operation." };
  }
  return { status: "rejected", message: "Runner rejected this operation; inspect the assignment and arguments before proceeding." };
}
