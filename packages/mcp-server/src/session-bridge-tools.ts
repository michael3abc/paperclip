import { z } from "zod";
import { selectTaskWorkspaceSchema } from "@paperclipai/shared";
import type { PaperclipApiClient } from "./client.js";
import { makeTool, type ToolDefinition } from "./tool-definition.js";

/** Session-owned tools are separate from the Runner legacy MCP contract. */
export function createSessionBridgeTools(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool("paperclipInspectTaskWorkspace", "Inspect the task's formal workspace selection, binding revision, effective host/directory and waiting reason. A worktree path in task text does not select it.",
      z.object({ issueId: z.uuid() }), async ({ issueId }) => client.requestJson("GET", `/issues/${issueId}/workspace`)),
    makeTool("paperclipSelectTaskWorkspace", "Schedule an authorized formal workspace selection for the next normal admission. Register an existing worktree as a project source first; shared means that source directory. Preserve expectedBindingRevision and requestKey; reconcile an uncertain response without resending. Does not Retry or start a task.",
      selectTaskWorkspaceSchema.extend({ issueId: z.uuid() }), async ({ issueId, ...body }) => client.requestJson("PUT", `/issues/${issueId}/workspace`, { body })),
    makeTool("paperclipListWorkerSelections", "Read this main agent’s approved worker selections and project sources. Use a ready selection ID in paperclipCreateIssue.assigneeAdapterOverrides.workerSelectionId and a configured_source workspaceSelection. Never substitute models.",
      z.object({}), async () => client.requestJson("GET", "/agents/me/session-bridge/workers")),
    makeTool("paperclipSearchAssignedTools", "Search connectors already assigned to this native session’s Paperclip agent. Returns current tool schemas. This does not create connections or grants.",
      z.object({ query: z.string().max(200).default(""), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(20).optional() }),
      async input => client.requestJson("POST", "/agents/me/session-bridge/tools-search", { body: input })),
    makeTool("paperclipCallAssignedTool", "Call an exact tool returned by paperclipSearchAssignedTools. Existing grants, approval and audit apply. Keep the same idempotencyKey for the same operation; inspect an uncertain result, never repeat a write with a new key.",
      z.object({ name: z.string().min(1).max(300), arguments: z.record(z.string(), z.unknown()), idempotencyKey: z.string().min(1).max(200), approvedActionRequestId: z.uuid().optional() }),
      async input => client.requestJson("POST", "/agents/me/session-bridge/tools-call", { body: input })),
  ];
}
