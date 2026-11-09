import { useInfiniteQuery } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { artifactsApi } from "../api/artifacts";
import { ArtifactCard } from "./artifacts/ArtifactCard";
import { Link } from "../lib/router";
import { formatDate } from "../lib/utils";
import { Button } from "./ui/button";
import { StatusBadge } from "./StatusBadge";

export function ProjectSessions({ projectId }: { projectId: string }) {
  const query = useInfiniteQuery({ queryKey: ["project-native-sessions", projectId], initialPageParam: 0,
    queryFn: ({ pageParam }) => projectsApi.sessions(projectId, pageParam),
    getNextPageParam: page => page.nextOffset ?? undefined, retry: false });
  return <section className="space-y-4" aria-label="Native project sessions">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-medium">Sessions</h2><Button variant="outline" onClick={() => void query.refetch()}>Refresh</Button></div>
    <p className="text-sm text-muted-foreground">Paperclip PM and worker runs, including completed, cancelled and failed attempts.</p>
    {query.data?.pages[0]?.pms.map(pm => <p key={pm.id}><Link className="underline" to={`/agents/${pm.id}/runtime`}>{pm.name} · Worker settings</Link></p>)}
    {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
    {query.isPending && <p>Loading sessions…</p>}
    {!query.error && query.data && query.data.pages.every(page => !page.records.length) && <p>No recorded native runs in this project.</p>}
    <ul className="space-y-3">{query.data?.pages.flatMap(page => page.records).map(row => <li key={row.runId} className="space-y-1 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2"><Link className="underline" to={`/issues/${row.identifier ?? row.issueId}`}>{row.identifier} · {row.title}</Link><StatusBadge status={row.status} /></div>
      <p className="text-sm">{row.agentName} · <Link className="underline" to={`/agents/${row.agentId}/runs/${row.runId}`}>View run</Link>{row.startedAt ? ` · ${formatDate(row.startedAt)}` : ""}</p>
      {row.sessionId && <p className="break-all font-mono text-xs text-muted-foreground">{row.sessionId}</p>}
    </li>)}</ul>
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more runs</Button>}
  </section>;
}

export function ProjectArtifacts({ companyId, projectId }: { companyId: string; projectId: string }) {
  // Same projection as the project's folder on the Artifacts page: media files only, no task documents.
  const query = useInfiniteQuery({ queryKey: ["project-native-artifacts", companyId, projectId, "media-only"], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => artifactsApi.list(companyId, { projectId, mediaOnly: true, limit: 30, cursor: pageParam }),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false });
  return <section className="space-y-4" aria-label="Native project artifacts">
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-medium">Artifacts</h2><Button variant="outline" onClick={() => void query.refetch()}>Refresh</Button></div>
    <p className="text-sm text-muted-foreground">Images, videos, audio, PDF and Office files registered on this project's tasks. Task documents such as plans and notes are not listed, and files remaining only in a workspace are not automatically published.</p>
    {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
    {query.isPending && <p>Loading artifacts…</p>}
    {!query.error && query.data && query.data.pages.every(page => !page.artifacts.length) && <p>No media artifacts in this project.</p>}
    <ProjectDeliveries projectId={projectId} />
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{query.data?.pages.flatMap(page => page.artifacts).map(artifact => <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />)}</div>
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more artifacts</Button>}
  </section>;
}

function ProjectDeliveries({ projectId }: { projectId: string }) {
  const query = useInfiniteQuery({ queryKey: ["project-native-work-products", projectId], initialPageParam: 0,
    queryFn: ({ pageParam }) => projectsApi.workProducts(projectId, pageParam),
    getNextPageParam: page => page.nextOffset ?? undefined, retry: false });
  return <section className="space-y-3" aria-label="Delivery and review records">
    <div className="flex items-center justify-between gap-3"><h3 className="font-medium">Delivery and review records</h3><Button variant="outline" onClick={() => void query.refetch()}>Refresh delivery records</Button></div>
    {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
    {query.isPending && <p>Loading delivery records…</p>}
    {!query.error && query.data && query.data.pages.every(page => !page.records.length) && <p>No registered delivery or review records.</p>}
    <ul className="space-y-2">{query.data?.pages.flatMap(page => page.records).map(row => <li key={row.id} className="rounded-md border border-border p-3">
      <Link className="underline" to={`/issues/${row.identifier ?? row.issueId}`}>{row.identifier} · {row.title}</Link>
      <p className="text-sm text-muted-foreground">{row.source === "review" ? "Review decision" : row.type} · {row.status} · Review: {row.reviewState} · {formatDate(row.updatedAt)}</p>
    </li>)}</ul>
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more work products</Button>}
  </section>;
}
