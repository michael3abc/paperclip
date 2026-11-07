export interface ProjectSessionRecord {
  runId: string;
  issueId: string;
  identifier: string | null;
  title: string;
  agentId: string;
  agentName: string;
  status: string;
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ProjectSessionRecords {
  records: ProjectSessionRecord[];
  nextOffset: number | null;
  pms: { id: string; name: string }[];
}
export interface ProjectWorkProductRecords {
  records: { id: string; issueId: string; identifier: string | null; title: string; type: string;
    source: "work_product" | "review"; status: string; reviewState: string; createdByRunId: string | null; updatedAt: string }[];
  nextOffset: number | null;
}
