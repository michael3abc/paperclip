import type { ArtifactGroupBy, ArtifactKindFilter } from "@/api/artifacts";
import { TabFilters, type TabBarItem } from "@/components/TabBar";

/**
 * The Artifacts page's one row of views: Projects — one folder per project,
 * the default — then every media file flat, by type (images, videos, audio,
 * PDF and Office files; documents, text and worker state are not listed).
 * Grouping and the kind filter are still two URL parameters; a view maps onto
 * both. Task grouping stays reachable from the Group by menu (`tasks`, no tab).
 */
export type ArtifactsV1View = "projects" | "tasks" | Exclude<ArtifactKindFilter, never>;

export const ARTIFACTS_V1_VIEWS: TabBarItem<ArtifactsV1View>[] = [
  { value: "projects", label: "Projects" },
  { value: "all", label: "All files" },
  { value: "image", label: "Images" },
  { value: "video", label: "Videos" },
  { value: "file", label: "Audio, PDF & Office" },
];

/** Project grouping is the Projects view, task grouping the (menu-only) Tasks view; flat views are named by their kind. */
export const artifactsV1View = (groupBy: ArtifactGroupBy, kind: ArtifactKindFilter): ArtifactsV1View =>
  groupBy === "project" ? "projects" : groupBy !== "none" ? "tasks" : kind;

export function ArtifactsV1Filters({ view, onViewChange }: { view: ArtifactsV1View; onViewChange: (view: ArtifactsV1View) => void }) {
  return <TabFilters items={ARTIFACTS_V1_VIEWS} value={view} onValueChange={onViewChange} size="standard" label="Show artifacts by project or by type" />;
}
