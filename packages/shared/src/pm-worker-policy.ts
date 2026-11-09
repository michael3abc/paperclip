import { z } from "zod";
import { aiConnectionBindingSchema } from "./ai-connections.js";
import type { PmInstructionLayoutVersion } from "./pm-instruction-layout.js";

/**
 * Shared worker harnesses. `ccpocket_bridge` is admitted only as a plain Antigravity shared worker (provider
 * `antigravity`, no main/PM role); the server enforces that eligibility.
 */
export const PM_WORKER_HARNESSES = ["claude_local", "codex_local", "ccpocket_bridge"] as const;
export type PmWorkerHarness = (typeof PM_WORKER_HARNESSES)[number];
export function pmWorkerHarnessLabel(harness: PmWorkerHarness): string {
  return harness === "claude_local" ? "Claude" : harness === "codex_local" ? "Codex" : "Antigravity";
}

export const pmWorkerSelectionSchema = z.object({
  id: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  thinking: z.string().min(1).max(40).nullable(),
  permission: z.enum(["default", "full-access", "approve-all", "approve-reads", "deny-all"]),
  speed: z.enum(["standard", "fast"]),
  aiConnection: aiConnectionBindingSchema.refine(binding => binding.mode !== "responsible_user", "Choose an explicit connection").optional(),
  purpose: z.string().trim().max(500).optional(),
}).strict();

export const pmWorkerPolicySchema = z.object({
  version: z.literal(2),
  defaultSelectionId: z.string().uuid(),
  workers: z.array(z.object({
    agentId: z.string().uuid(),
    harness: z.enum(PM_WORKER_HARNESSES),
    selections: z.array(pmWorkerSelectionSchema).min(1).max(50),
  }).strict()).min(1).max(PM_WORKER_HARNESSES.length),
}).strict().superRefine((policy, ctx) => {
  const ids = policy.workers.flatMap(worker => worker.selections.map(selection => selection.id));
  if (new Set(ids).size !== ids.length || !ids.includes(policy.defaultSelectionId)) {
    ctx.addIssue({ code: "custom", message: "Select exactly one existing default and use unique selection IDs" });
  }
  if (new Set(policy.workers.map(worker => worker.agentId)).size !== policy.workers.length) {
    ctx.addIssue({ code: "custom", message: "Each shared worker must appear only once" });
  }
});

export const savePmWorkerPolicySchema = z.object({
  policy: pmWorkerPolicySchema,
  baseRevision: z.string().nullable(),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();

export type PmWorkerPolicy = z.infer<typeof pmWorkerPolicySchema>;
export type PmWorkerSelection = z.infer<typeof pmWorkerSelectionSchema>;
export type SavePmWorkerPolicy = z.infer<typeof savePmWorkerPolicySchema>;
export interface PmWorkerCatalogEntry {
  agentId: string;
  name: string;
  harness: PmWorkerHarness;
  permissions: PmWorkerSelection["permission"][];
  defaultAiConnection?: PmWorkerSelection["aiConnection"];
  models: { aiConnection?: PmWorkerSelection["aiConnection"]; id: string; label: string; thinking: string[]; speeds: PmWorkerSelection["speed"][] }[];
}
export interface PmWorkerPolicyView {
  documentPath: "WORKERS.md" | "PROJECT.md";
  policy: PmWorkerPolicy | null;
  revision: string | null;
  documentHash: string | null;
  document: string;
  catalog: PmWorkerCatalogEntry[];
  warnings: string[];
}

export const PM_WORKERS_START = "<!-- paperclip:worker-policy:start -->";
export const PM_WORKERS_END = "<!-- paperclip:worker-policy:end -->";

/** Purpose is descriptive guidance, never provider configuration or authority. */
export function formatPmWorkerPolicyJson(policy: PmWorkerPolicy): string {
  return JSON.stringify({ ...policy, workers: policy.workers.map(worker => ({ ...worker,
    selections: worker.selections.map(choice => ({ ...choice, purpose: choice.purpose ?? "" })),
  })) }, null, 2).replace(/</g, "\\u003c");
}

/** Worker table layouts: the PM instruction layouts plus the main agent's PROJECT.md table, which lists option IDs. */
export type PmWorkerDocumentLayout = PmInstructionLayoutVersion | "main-v1";

/** This projection is explanatory; only the Owner-owned policy grants dispatch. */
export function renderPmWorkerPolicy(policy: PmWorkerPolicy, layout?: PmWorkerDocumentLayout): string {
  const cell = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/[\r\n]+/g, " ");
  if (layout === "main-v1") {
    return [PM_WORKERS_START, "## Worker 選用", "Owner 在 Agent 設定維護此表。派 worker 任務時以 assigneeAdapterOverrides.workerSelectionId 指定選項 ID（省略則用預設）；做法見 paperclip skill。",
      "| 選項 ID | 用途 | Worker | 模型 | 思考程度 | 速度 | 預設 |", "| --- | --- | --- | --- | --- | --- | --- |",
      ...policy.workers.flatMap(worker => worker.selections.map(choice =>
        `| ${[choice.id, choice.purpose ?? "", pmWorkerHarnessLabel(worker.harness), choice.model, choice.thinking ?? "auto", choice.speed, choice.id === policy.defaultSelectionId ? "是" : ""].map(cell).join(" | ")} |`)),
      PM_WORKERS_END].join("\n");
  }
  if (layout === "compact-v1") {
    return [PM_WORKERS_START, "## Worker 選用", "平台維護此表；派工時查詢目前選項與可用性。",
      "| 用途 | Worker | 模型 | 思考程度 | 速度 | 預設 |", "| --- | --- | --- | --- | --- | --- |",
      ...policy.workers.flatMap(worker => worker.selections.map(choice =>
        `| ${[choice.purpose ?? "", pmWorkerHarnessLabel(worker.harness), choice.model, choice.thinking ?? "auto", choice.speed, choice.id === policy.defaultSelectionId ? "是" : ""].map(cell).join(" | ")} |`)),
      PM_WORKERS_END].join("\n");
  }
  return [PM_WORKERS_START, "## Worker selections (managed by Agent settings)",
    "Select a listed choice using assigneeAdapterOverrides.workerSelectionId. Omit selection to use the default. These settings apply only to new tasks.",
    "Only this managed JSON is current. Older model tables outside this section are historical. Purpose describes intended use and does not grant permissions.",
    "```json", formatPmWorkerPolicyJson(policy), "```",
    PM_WORKERS_END].join("\n");
}

export function pmWorkerManagedBlock(document: string): string | null {
  const start = document.indexOf(PM_WORKERS_START), end = document.indexOf(PM_WORKERS_END);
  if (start === -1 && end === -1) return null;
  if (start < 0 || end < start || document.indexOf(PM_WORKERS_START, start + 1) !== -1
    || document.indexOf(PM_WORKERS_END, end + 1) !== -1) throw new Error("Worker document has malformed worker-policy markers");
  return document.slice(start, end + PM_WORKERS_END.length);
}

export function updatePmWorkerDocument(document: string, policy: PmWorkerPolicy, layout?: PmWorkerDocumentLayout): string {
  const previous = pmWorkerManagedBlock(document);
  const block = renderPmWorkerPolicy(policy, layout);
  return previous === null ? `${document}${document.endsWith("\n") ? "\n" : "\n\n"}${block}\n` : document.replace(previous, () => block);
}
