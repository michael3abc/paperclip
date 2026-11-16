import type { IssueWorkMode } from "@paperclipai/shared";
import { ClipboardCheck, ClipboardList, Hammer, MessageCircleQuestion, type LucideIcon } from "lucide-react";

export type WorkModeTone = "neutral" | "ask" | "planning";

export interface WorkModeMeta {
  value: IssueWorkMode;
  label: string;
  icon: LucideIcon;
  tone: WorkModeTone;
  classes: {
    chip: string;
    container: string;
    menuItem: string;
    badge: string;
  };
}

const STANDARD_CLASSES = {
  chip: "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
  container: "",
  menuItem: "text-foreground",
  badge: "",
};

const ASK_CLASSES = {
  chip: "border-sky-500/60 bg-sky-500/15 text-sky-800 hover:bg-sky-500/25 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-200 dark:hover:bg-sky-500/25",
  container: "border-sky-500/60 bg-sky-50/60 supports-[backdrop-filter]:bg-sky-50/40 dark:border-sky-500/50 dark:bg-sky-500/[0.07] dark:supports-[backdrop-filter]:bg-sky-500/[0.07]",
  menuItem: "text-sky-700 dark:text-sky-300",
  badge: "border-sky-500/40 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200",
};

const PLANNING_CLASSES = {
  chip: "border-amber-500/60 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 dark:border-amber-500/50 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/25",
  container: "border-amber-500/60 bg-amber-50/60 supports-[backdrop-filter]:bg-amber-50/40 dark:border-amber-500/50 dark:bg-amber-500/[0.07] dark:supports-[backdrop-filter]:bg-amber-500/[0.07]",
  menuItem: "text-amber-700 dark:text-amber-300",
  badge: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function isIssueWorkMode(value: unknown): value is IssueWorkMode {
  return value === "standard" || value === "ask" || value === "planning" || value === "native_plan";
}

/** Which optional modes a composer offers. Native plan exists only in a CC Pocket Claude main agent's Agent Chat. */
export interface WorkModeOptions {
  nativePlan?: boolean;
}

const STANDARD_META: WorkModeMeta = { value: "standard", label: "Auto mode", icon: Hammer, tone: "neutral", classes: STANDARD_CLASSES };
const PLANNING_META: WorkModeMeta = { value: "planning", label: "Plan mode", icon: ClipboardList, tone: "planning", classes: PLANNING_CLASSES };
/** The harness's own plan mode; its plan proposal is approved in Agent Chat. */
const NATIVE_PLAN_META: WorkModeMeta = { value: "native_plan", label: "Native plan", icon: ClipboardCheck, tone: "planning", classes: PLANNING_CLASSES };
const ASK_META: WorkModeMeta = { value: "ask", label: "Ask mode", icon: MessageCircleQuestion, tone: "ask", classes: ASK_CLASSES };

export function workModeMetaList(options: WorkModeOptions = {}): WorkModeMeta[] {
  return options.nativePlan
    ? [STANDARD_META, PLANNING_META, NATIVE_PLAN_META, ASK_META]
    : [STANDARD_META, PLANNING_META, ASK_META];
}

export function workModeMetaFor(mode: IssueWorkMode): WorkModeMeta {
  const modes = workModeMetaList({ nativePlan: true });
  return modes.find((meta) => meta.value === mode) ?? modes[0]!;
}

export function nextWorkMode(mode: IssueWorkMode, options: WorkModeOptions = {}): IssueWorkMode {
  const modes = workModeMetaList(options);
  const index = modes.findIndex((meta) => meta.value === mode);
  return modes[(index + 1) % modes.length]?.value ?? "standard";
}

export function titleForPendingWorkMode(mode: IssueWorkMode): string {
  if (mode === "ask") {
    return "Ask mode for this submission. Click to change. The responsible will answer in this thread; no implementation work.";
  }
  if (mode === "planning") {
    return "Plan mode is on for this submission. Click to change.";
  }
  if (mode === "native_plan") {
    return "Native plan is on for this submission. Click to change. The agent's harness plans first; approve its plan in this chat to let it implement.";
  }
  return "Auto mode for this submission. Click to change.";
}
