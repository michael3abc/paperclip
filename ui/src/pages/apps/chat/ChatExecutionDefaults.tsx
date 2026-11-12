import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChatExecutionDefaults as Defaults, TaskWorkspaceSelection } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { isOpenManagedWorktree } from "@/lib/issue-workspace-selection";

function selectionKey(value: TaskWorkspaceSelection | null | undefined): string {
  if (value === undefined) return "inherit";
  if (value === null) return "clear";
  if (value.kind === "session_only") return "session";
  if (value.kind === "task_directory") return "task";
  if (value.kind === "existing") return `existing:${value.workspaceId}`;
  return `source:${value.projectWorkspaceId}:${value.mode}`;
}

export function ChatExecutionDefaults({ companyId, value, resource = false, onSave }: {
  companyId: string;
  value: Defaults | null | undefined;
  resource?: boolean;
  onSave: (defaults: Defaults | null) => Promise<void>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Defaults | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFrom, setSavedFrom] = useState<string | null>(null);
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId), queryFn: () => projectsApi.list(companyId) });
  const workspaces = useQuery({
    queryKey: ["channel-workspace-choices", companyId],
    queryFn: () => executionWorkspacesApi.list(companyId, { selectableForTask: true }),
  });
  const current = draft ?? value ?? {};
  const valueKey = JSON.stringify(value ?? {});
  const saved = savedFrom !== null;
  // Keep the accepted selections until the parent publishes refreshed defaults.
  useEffect(() => {
    if (savedFrom !== null && savedFrom !== valueKey) setDraft(null);
  }, [savedFrom, valueKey]);
  const projectValue = current.projectId === undefined ? "inherit" : current.projectId ?? "none";
  const workspaceValue = selectionKey(current.workspace);
  const choices = new Map<string, TaskWorkspaceSelection>();
  choices.set("session", { kind: "session_only" });
  const availableWorktrees = (workspaces.data ?? []).filter(isOpenManagedWorktree)
    .filter(workspace => !current.projectId || workspace.projectId === current.projectId);
  for (const workspace of availableWorktrees) {
    choices.set(`existing:${workspace.id}`, { kind: "existing", workspaceId: workspace.id });
  }
  const dirty = !saved && JSON.stringify(current) !== valueKey;
  const change = (next: Defaults) => { setDraft(next); setSavedFrom(null); setError(null); };
  return <form className="space-y-3" aria-labelledby={`${id}-title`} onSubmit={async (event) => {
    event.preventDefault();
    if (pending || !dirty) return;
    setPending(true); setError(null); setSavedFrom(null);
    try { await onSave(Object.keys(current).length ? current : null); setSavedFrom(valueKey); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t save task defaults. Try again."); }
    finally { setPending(false); }
  }}>
    <div className="space-y-1">
      <h3 id={`${id}-title`} className="text-sm font-semibold">Task defaults</h3>
      <p className="text-sm text-muted-foreground">Applies to new conversations. Existing tasks keep their files and project.</p>
    </div>
    {(projects.isError || workspaces.isError) && <p role="alert" className="text-sm text-destructive">Couldn’t load available projects or workspaces. <button type="button" className="underline" onClick={() => { void projects.refetch(); void workspaces.refetch(); }}>Try again</button></p>}
    <div className="space-y-2">
      <label htmlFor={`${id}-project`} className="text-sm font-medium">Project</label>
      <NativeSelect id={`${id}-project`} value={projectValue} disabled={pending || projects.isPending} onChange={(event) => {
        const { projectId: _previous, ...rest } = current;
        change(event.target.value === "inherit" ? rest : { ...rest, projectId: event.target.value === "none" ? null : event.target.value });
      }}>
        <option value="inherit">{resource ? "Use connection defaults" : "Use task defaults"}</option>
        <option value="none">No project</option>
        {current.projectId && !projects.data?.some((project) => project.id === current.projectId) && <option value={current.projectId}>Saved project (unavailable)</option>}
        {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </NativeSelect>
    </div>
    <div className="space-y-2">
      <label htmlFor={`${id}-workspace`} className="text-sm font-medium">Workspace</label>
      <NativeSelect id={`${id}-workspace`} value={workspaceValue} disabled={pending || projects.isPending || workspaces.isPending} onChange={(event) => {
        const key = event.target.value;
        const { workspace: _previous, ...rest } = current;
        if (key === "inherit") change(rest);
        else if (key === "clear") change({ ...rest, workspace: null });
        else { const workspace = choices.get(key); if (workspace) change({ ...rest, workspace }); }
      }}>
        <option value="inherit">{resource ? "Use connection defaults" : "Use project or task defaults"}</option>
        {resource && <option value="clear">Use project or task defaults</option>}
        {!resource && workspaceValue === "clear" && <option value="clear">Use project or task defaults</option>}
        <option value="session">Session only · external resources</option>
        {current.workspace && !choices.has(workspaceValue) && <option value={workspaceValue}>Saved workspace (unavailable)</option>}
        {availableWorktrees.length > 0 && <optgroup label="Registered Git worktrees">{availableWorktrees.map((workspace) => <option key={workspace.id} value={`existing:${workspace.id}`}>{workspace.name}</option>)}</optgroup>}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">Code work uses an open Git worktree registered by the project main. Session-only work keeps external resources in place.</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between gap-3">
      <div>{dirty ? <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setError(null); }}>Cancel</Button> : saved ? <span role="status" className="text-sm text-muted-foreground">Saved for new tasks.</span> : null}</div>
      <Button type="submit" disabled={!dirty || pending}>{pending ? "Saving…" : "Save defaults"}</Button>
    </div>
  </form>;
}
