import { z } from "zod";

export const pmWorkerSelectionSchema = z.object({
  id: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  thinking: z.string().min(1).max(40).nullable(),
  permission: z.enum(["default", "full-access", "approve-all", "approve-reads", "deny-all"]),
  speed: z.enum(["standard", "fast"]),
}).strict();

export const pmWorkerPolicySchema = z.object({
  version: z.literal(2),
  defaultSelectionId: z.string().uuid(),
  workers: z.array(z.object({
    agentId: z.string().uuid(),
    harness: z.enum(["claude_local", "codex_local"]),
    selections: z.array(pmWorkerSelectionSchema).min(1).max(50),
  }).strict()).min(1).max(2),
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
  harness: "claude_local" | "codex_local";
  permissions: PmWorkerSelection["permission"][];
  models: { id: string; label: string; thinking: string[]; speeds: PmWorkerSelection["speed"][] }[];
}
export interface PmWorkerPolicyView {
  policy: PmWorkerPolicy | null;
  revision: string | null;
  documentHash: string | null;
  document: string;
  catalog: PmWorkerCatalogEntry[];
  warnings: string[];
}

export const PM_WORKERS_START = "<!-- paperclip:worker-policy:start -->";
export const PM_WORKERS_END = "<!-- paperclip:worker-policy:end -->";

/** This projection is explanatory; only the Owner-owned policy grants dispatch. */
export function renderPmWorkerPolicy(policy: PmWorkerPolicy): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
  return [PM_WORKERS_START, "## Worker selections (managed by Agent settings)",
    "Select a listed choice using assigneeAdapterOverrides.workerSelectionId. Omit selection to use the default. These settings apply only to new tasks.",
    "Only this managed selection table is current. Any older model tables outside this section are historical and cannot authorize dispatch.",
    "| Selection ID | Worker | Harness | Model | Thinking | Permission | Speed | Default |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...policy.workers.flatMap(worker => worker.selections.map(choice =>
      `| ${choice.id} | ${worker.agentId} | ${worker.harness} | ${cell(choice.model)} | ${choice.thinking ?? "auto"} | ${choice.permission} | ${choice.speed} | ${choice.id === policy.defaultSelectionId ? "yes" : "no"} |`)),
    PM_WORKERS_END].join("\n");
}

export function pmWorkerManagedBlock(document: string): string | null {
  const start = document.indexOf(PM_WORKERS_START), end = document.indexOf(PM_WORKERS_END);
  if (start === -1 && end === -1) return null;
  if (start < 0 || end < start || document.indexOf(PM_WORKERS_START, start + 1) !== -1
    || document.indexOf(PM_WORKERS_END, end + 1) !== -1) throw new Error("WORKERS.md has malformed worker-policy markers");
  return document.slice(start, end + PM_WORKERS_END.length);
}

export function updatePmWorkerDocument(document: string, policy: PmWorkerPolicy): string {
  const previous = pmWorkerManagedBlock(document);
  const block = renderPmWorkerPolicy(policy);
  return previous === null ? `${document}${document.endsWith("\n") ? "\n" : "\n\n"}${block}\n` : document.replace(previous, () => block);
}
