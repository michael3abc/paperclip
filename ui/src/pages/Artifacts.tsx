import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, FolderOpen, Layers, Package } from "lucide-react";
import type { To } from "react-router-dom";
import {
  artifactsApi,
  type ArtifactGroupBy,
  type ArtifactKindFilter,
  type CompanyArtifactGroup,
} from "../api/artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ArtifactCard } from "../components/artifacts/ArtifactCard";
import { ArtifactGroupCard } from "../components/artifacts/ArtifactGroupCard";
import { useSearchParams, Link } from "@/lib/router";
import { ArtifactsToolbar, ARTIFACT_KIND_FILTERS } from "@/components/artifacts/ArtifactsToolbar";
import { ArtifactSingleTile, ArtifactStackTile, ArtifactTileGrid, ArtifactsV1Filters, artifactsV1View, subjectFromCompanyArtifact, type ArtifactsV1View } from "@/components/artifacts/v1";
import { useArtifactsV1Enabled } from "@/hooks/useArtifactsV1Enabled";
export { ARTIFACT_KIND_FILTERS, ARTIFACT_GROUP_OPTIONS, artifactGroupByLabel } from "@/components/artifacts/ArtifactsToolbar";

const ARTIFACTS_PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 250;

const KIND_VALUES = new Set(ARTIFACT_KIND_FILTERS.map((filter) => filter.value));
/** The page opens on one folder per project; the URL omits this default. */
const DEFAULT_GROUP_BY: ArtifactGroupBy = "project";
const NO_PROJECT_GROUP_ID = "none";

function parseGroupBy(value: string | null, hasGroupIssueId: boolean): ArtifactGroupBy {
  if (value === "none" || value === "task" || value === "parent_task" || value === "project") return value;
  // Links saved while Task was the default open a stack without naming the grouping.
  return hasGroupIssueId ? "task" : DEFAULT_GROUP_BY;
}

function setGroupByParam(next: URLSearchParams, value: ArtifactGroupBy) {
  if (value === DEFAULT_GROUP_BY) next.delete("groupBy");
  else next.set("groupBy", value);
}

/** The URL key that opens a group: a project folder or a task stack. */
function groupKeyOf(group: CompanyArtifactGroup): string {
  if (group.groupBy === "project") return group.project?.id ?? NO_PROJECT_GROUP_ID;
  return group.issue?.id ?? "";
}

function parseKind(value: string | null): ArtifactKindFilter {
  return value && KIND_VALUES.has(value as ArtifactKindFilter)
    ? (value as ArtifactKindFilter)
    : "all";
}

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const { enabled: v1 } = useArtifactsV1Enabled();
  const kind = parseKind(searchParams.get("kind"));
  const query = searchParams.get("q") ?? "";
  const urlGroupBy = parseGroupBy(searchParams.get("groupBy"), searchParams.has("groupIssueId"));
  // Artifacts V1 has one row of views: a kind is always a flat view, so a kind in the URL
  // overrides a grouping there — the view row then says what the page shows.
  const groupBy: ArtifactGroupBy = v1 && kind !== "all" ? "none" : urlGroupBy;
  const byProject = groupBy === "project";
  const groupIssueId = !byProject ? searchParams.get("groupIssueId") ?? undefined : undefined;
  const groupProjectId = byProject ? searchParams.get("groupProjectId") ?? undefined : undefined;
  const selectedGroupKey = byProject ? groupProjectId : groupIssueId;

  const [draftQuery, setDraftQuery] = useState(query);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const grouping = groupBy !== "none";
  const viewingStackList = grouping && !selectedGroupKey;
  const viewingSelectedStack = grouping && !!selectedGroupKey;

  // Keep the search box in sync when the committed query changes from outside
  // (e.g. back/forward navigation or a shared URL), without clobbering in-flight
  // typing (which leaves `query` unchanged until the debounce commits).
  useEffect(() => {
    setDraftQuery((prev) => (prev.trim() === query ? prev : query));
  }, [query]);

  // Debounce the search box into the `q` URL param so searches are shareable.
  useEffect(() => {
    const trimmed = draftQuery.trim();
    if (trimmed === query) return;
    const handle = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set("q", trimmed);
          else next.delete("q");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draftQuery, query, setSearchParams]);

  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        mutate(next);
        return next;
      });
    },
    [setSearchParams],
  );

  const selectKind = useCallback(
    (value: ArtifactKindFilter) => {
      updateParams((next) => {
        if (value === "all") next.delete("kind");
        else next.set("kind", value);
      });
    },
    [updateParams],
  );

  // Artifacts V1: one row of views. Projects is the project grouping; every other
  // view is the flat list, filtered by kind. Either way the open folder closes.
  const selectV1View = useCallback(
    (view: ArtifactsV1View) => {
      updateParams((next) => {
        next.delete("groupIssueId");
        next.delete("groupProjectId");
        if (view === "projects" || view === "tasks") {
          setGroupByParam(next, view === "projects" ? "project" : "task");
          next.delete("kind");
          return;
        }
        next.set("groupBy", "none");
        if (view === "all") next.delete("kind");
        else next.set("kind", view);
      });
    },
    [updateParams],
  );

  const selectGroupBy = useCallback(
    (value: ArtifactGroupBy) => {
      updateParams((next) => {
        // Switching the grouping mode always returns to the stack list.
        next.delete("groupIssueId");
        next.delete("groupProjectId");
        setGroupByParam(next, value);
        // Artifacts V1: a grouping is the Projects (or Tasks) view, which carries no kind filter.
        if (v1 && value !== "none") next.delete("kind");
      });
    },
    [updateParams, v1],
  );

  // Build a relative `To` that preserves the active filters/search while
  // changing only the grouping selection. A bare query string keeps the current
  // pathname (the company-prefixed /artifacts route) and stays linkable.
  const buildTo = useCallback(
    (mutate: (next: URLSearchParams) => void): To => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      const serialized = next.toString();
      return serialized ? `?${serialized}` : "?";
    },
    [searchParams],
  );

  const stackTo = useCallback(
    (group: CompanyArtifactGroup): To =>
      buildTo((next) => {
        if (groupBy !== "none") setGroupByParam(next, groupBy);
        next.set(group.groupBy === "project" ? "groupProjectId" : "groupIssueId", groupKeyOf(group));
      }),
    [buildTo, groupBy],
  );

  const backToStacksTo = useMemo<To>(
    () =>
      buildTo((next) => {
        // Name the grouping explicitly: a legacy stack link inferred `task` from groupIssueId alone.
        setGroupByParam(next, groupBy);
        next.delete("groupIssueId");
        next.delete("groupProjectId");
      }),
    [buildTo, groupBy],
  );

  const {
    data,
    isLoading,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useInfiniteQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!, kind, query, groupBy, groupIssueId, true, groupProjectId),
    queryFn: ({ pageParam }) =>
      artifactsApi.list(selectedCompanyId!, {
        kind,
        q: query || undefined,
        groupBy,
        groupIssueId,
        ...(groupProjectId ? { groupProjectId } : {}),
        mediaOnly: true,
        limit: ARTIFACTS_PAGE_SIZE,
        cursor: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void fetchNextPage();
      }
    }, { rootMargin: "320px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const artifacts = useMemo(() => data?.pages.flatMap((page) => page.artifacts) ?? [], [data]);
  const groups = useMemo(
    () => data?.pages.flatMap((page) => page.groups ?? []) ?? [],
    [data],
  );
  const selectedGroup = useMemo(
    () => data?.pages.map((page) => page.selectedGroup).find(Boolean) ?? null,
    [data],
  );
  const searching = query.length > 0;

  useEffect(() => {
    if (viewingSelectedStack && selectedGroup) {
      setBreadcrumbs([
        { label: "Artifacts", href: "/artifacts" },
        { label: selectedGroup.issue ? `${selectedGroup.issue.identifier} · ${selectedGroup.title}` : selectedGroup.title },
      ]);
    } else {
      setBreadcrumbs([{ label: "Artifacts" }]);
    }
  }, [setBreadcrumbs, viewingSelectedStack, selectedGroup]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select an organization to view artifacts." />;
  }

  const showGroupCards = viewingStackList;
  const items = showGroupCards ? groups : artifacts;

  const emptyMessage = showGroupCards
    ? searching
      ? byProject ? "No project folders match this search." : "No artifact stacks match this search."
      : byProject
        ? "No media artifacts in any project yet. Images, videos, audio, PDF and Office files attached to issues will appear here."
        : "No media artifact stacks yet."
    : searching
      ? "No artifacts match this search."
      : viewingSelectedStack
        ? byProject ? "No media artifacts in this project match the current filters." : "No artifacts in this stack match the current filters."
        : kind === "all"
          ? "No media artifacts yet. Images, videos, audio, PDF and Office files attached to issues will appear here."
          : "No artifacts of this type yet.";

  return (
    <div className="w-full max-w-6xl space-y-5">
      <ArtifactsToolbar
        query={draftQuery}
        onQueryChange={setDraftQuery}
        groupBy={groupBy}
        onGroupByChange={selectGroupBy}
        kind={kind}
        onKindChange={selectKind}
        filters={v1 ? <ArtifactsV1Filters view={artifactsV1View(groupBy, kind)} onViewChange={selectV1View} /> : undefined}
      />

      {viewingSelectedStack ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link
            to={backToStacksTo}
            data-testid="artifact-stack-back"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            {byProject ? "All projects" : "All stacks"}
          </Link>
          {selectedGroup ? (
            <span className="truncate text-muted-foreground">
              {selectedGroup.issue ? (
                <>
                  <span className="text-foreground/80">{selectedGroup.issue.identifier}</span>{" "}
                </>
              ) : (
                <FolderOpen className="mr-1 inline h-3.5 w-3.5 align-text-bottom" aria-hidden="true" />
              )}
              {selectedGroup.title}
              {selectedGroup.issue ? null : ` · ${selectedGroup.count} ${selectedGroup.count === 1 ? "artifact" : "artifacts"}`}
            </span>
          ) : null}
        </div>
      ) : null}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : items.length === 0 ? (
        <EmptyState icon={showGroupCards ? Layers : Package} message={emptyMessage} />
      ) : v1 ? (
        <>
          {/* Artifacts V1 (doc/plans/2026-10-22-artifacts-mvp-v1.md): a project folder, or a task with several
              artifacts, is a stack whose newest artifact is the first page; a task with one, and every flat view,
              is a single tile. */}
          <ArtifactTileGrid>
            {showGroupCards
              ? groups.map((group) => {
                  const preview = group.previewArtifacts[0];
                  const folder = group.groupBy === "project";
                  if (folder || group.count > 1 || !preview) {
                    const identifier = group.issue?.identifier ?? null;
                    return (
                      <ArtifactStackTile
                        key={group.id}
                        identifier={identifier}
                        title={group.title}
                        count={group.count}
                        updatedAt={group.updatedAt}
                        front={preview ? subjectFromCompanyArtifact(preview) : { kind: "file", title: group.title, updatedAt: group.updatedAt, taskIdentifier: identifier }}
                        to={stackTo(group)}
                        testId={folder ? "artifact-v1-folder-tile" : undefined}
                      />
                    );
                  }
                  return <ArtifactSingleTile key={group.id} subject={subjectFromCompanyArtifact(preview)} to={preview.href} />;
                })
              : artifacts.map((artifact) => (
                  <ArtifactSingleTile key={`${artifact.source}:${artifact.id}`} subject={subjectFromCompanyArtifact(artifact)} to={artifact.href} />
                ))}
          </ArtifactTileGrid>
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground">
            {isFetchingNextPage ? "Loading more artifacts..." : hasNextPage ? null : isFetching ? "Updating artifacts..." : null}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {showGroupCards
              ? groups.map((group) => (
                  <ArtifactGroupCard key={group.id} group={group} to={stackTo(group)} />
                ))
              : artifacts.map((artifact) => (
                  <ArtifactCard key={`${artifact.source}:${artifact.id}`} artifact={artifact} />
                ))}
          </div>
          <div ref={loadMoreRef} className="flex min-h-10 items-center justify-center pb-2 text-xs text-muted-foreground">
            {isFetchingNextPage
              ? "Loading more artifacts..."
              : hasNextPage
                ? null
                : isFetching
                  ? "Updating artifacts..."
                  : null}
          </div>
        </>
      )}
    </div>
  );
}
