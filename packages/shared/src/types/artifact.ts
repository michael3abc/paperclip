export type CompanyArtifactSource = "document" | "attachment" | "work_product";

export type CompanyArtifactMediaKind = "image" | "video" | "text" | "document" | "file" | "empty";

export type CompanyArtifactGroupBy = "none" | "task" | "parent_task" | "project";

export interface CompanyArtifactIssueSummary {
  id: string;
  identifier: string;
  title: string;
}

export interface CompanyArtifactProjectSummary {
  id: string;
  name: string;
}

export interface CompanyArtifactAgentSummary {
  id: string;
  name: string;
}

export interface CompanyArtifact {
  id: string;
  source: CompanyArtifactSource;
  mediaKind: CompanyArtifactMediaKind;
  title: string;
  previewText: string | null;
  contentType: string | null;
  contentPath: string | null;
  openPath: string | null;
  downloadPath: string | null;
  issue: CompanyArtifactIssueSummary;
  project: CompanyArtifactProjectSummary | null;
  createdByAgent: CompanyArtifactAgentSummary | null;
  updatedAt: string;
  href: string;
}

export interface CompanyArtifactGroup {
  id: string;
  groupBy: Exclude<CompanyArtifactGroupBy, "none">;
  /** The task (or root task) of a task group; null for a project group. */
  issue: CompanyArtifactIssueSummary | null;
  /** The project of a project group; null for the folder of tasks without a project. Absent on task groups. */
  project?: CompanyArtifactProjectSummary | null;
  title: string;
  count: number;
  mediaKinds: CompanyArtifactMediaKind[];
  previewArtifacts: CompanyArtifact[];
  updatedAt: string;
  href: string;
}

export interface CompanyArtifactsResponse {
  artifacts: CompanyArtifact[];
  groups?: CompanyArtifactGroup[];
  selectedGroup?: CompanyArtifactGroup | null;
  nextCursor: string | null;
}
