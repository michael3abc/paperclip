/** Owner-selected instruction layout. Markdown never selects its own policy. */
export type PmInstructionLayoutVersion = "split-v1" | "compact-v1";

const splitFiles = ["AGENTS.md", "PROJECT.md", "WORKERS.md", "REVIEW.md", "memory/decisions.md", "memory/handoff.md"] as const;
const compactFiles = ["AGENTS.md", "PROJECT.md", "MEMORY.md"] as const;

export function pmInstructionLayout(runtimeConfig?: Record<string, unknown> | null) {
  const version = runtimeConfig?.pmInstructionLayout ?? "split-v1";
  if (version !== "split-v1" && version !== "compact-v1") throw new Error("Unsupported PM instruction layout");
  const compact = version === "compact-v1";
  return {
    version: version as PmInstructionLayoutVersion,
    files: (compact ? compactFiles : splitFiles) as readonly [string, ...string[]],
    editableFiles: compact ? ["PROJECT.md", "MEMORY.md"] : splitFiles.filter(file => file !== "AGENTS.md"),
    workerDocumentPath: compact ? "PROJECT.md" as const : "WORKERS.md" as const,
    readGuidance: compact
      ? "Read AGENTS.md and PROJECT.md with read_bundle_file every run. Read MEMORY.md when continuing work or making a related decision."
      : "Read AGENTS.md, PROJECT.md and memory/handoff.md with read_bundle_file every run; WORKERS.md and REVIEW.md before dispatch; REVIEW.md before review.",
  };
}

export function requiredPmBundleFiles(version: PmInstructionLayoutVersion | undefined, operation: string): string[] {
  if (version === "compact-v1") return ["AGENTS.md", "PROJECT.md"];
  const required = ["AGENTS.md", "PROJECT.md", "memory/handoff.md"];
  if (["create_task", "reassign_task", "dispatch"].includes(operation)) required.push("WORKERS.md", "REVIEW.md");
  else if (["resolve_review", "request_review", "review", "resolve_delegated_request", "escalate_delegated_request"].includes(operation)) required.push("REVIEW.md");
  return required;
}
