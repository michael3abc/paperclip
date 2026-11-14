import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, RotateCcw, Sparkles } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToastActions } from "@/context/ToastContext";
import { ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS } from "@/lib/native-model-catalog";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  BRIDGE_ADAPTER_TYPE, MAIN_AGENT_EFFORT_SAVE_DELAY, bridgeCatalogForScope, bridgeModelDisplayName, bridgeModelEfforts,
  canEditAgentConfiguration, compactBridgeModelName, effortForModel, groupBridgeCatalog, mainAgentEffortLabel,
  readMainAgentModelScope, sameSelection, saveMainAgentModel,
  type BridgeCatalogModel, type MainAgentModelSelection,
} from "./main-agent-model";
import "./main-agent-model-picker.css";

interface Props {
  agent: Agent;
  companyId: string;
  mobile?: boolean;
}

type View = "main" | "models";

const HELPER_TEXT = "Applies from the next turn in this session.";
const PILL_CLASS = "inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground";
const ICON_BUTTON_CLASS = "grid shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

/**
 * Main-agent chat composer control for the agent's saved Bridge model and effort.
 * Changes save as soon as the slider settles or a model is picked, and apply from the
 * agent's next turn in the same native session.
 */
export function MainAgentModelPicker({ agent, companyId, mobile = false }: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const idBase = useId();
  const [open, setOpen] = useState(false);
  const [view, setViewState] = useState<View>("main");
  const [viewChanged, setViewChanged] = useState(false);
  /** Slider position not yet committed (inside the debounce window). */
  const [draft, setDraftState] = useState<MainAgentModelSelection | null>(null);
  /** Committed selection (saving or saved) that the agent props have not caught up with. */
  const [optimistic, setOptimistic] = useState<MainAgentModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  /** The setting when the picker opened; reset returns to it. */
  const [baseline, setBaseline] = useState<MainAgentModelSelection | null>(null);
  const saved = readMainAgentModelScope(agent.adapterConfig);

  const savedRef = useRef(saved);
  const serverRef = useRef<MainAgentModelSelection>({ model: saved.model, effort: saved.effort });
  const draftRef = useRef<MainAgentModelSelection | null>(null);
  const queuedRef = useRef<MainAgentModelSelection | null>(null);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousViewRef = useRef<View>("main");

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  const canEdit = canEditAgentConfiguration(boardAccess, companyId);
  // Same scoped Bridge catalog query (and cache identity) as the Agent settings model picker.
  const catalogQuery = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, BRIDGE_ADAPTER_TYPE, agent.defaultEnvironmentId ?? null,
      JSON.stringify([saved.hostId, saved.provider])),
    queryFn: () => agentsApi.adapterModels(companyId, BRIDGE_ADAPTER_TYPE, {
      environmentId: agent.defaultEnvironmentId ?? null, hostId: saved.hostId || undefined, provider: saved.provider,
    }),
    ...ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS,
    enabled: open && canEdit,
  });
  const catalog = bridgeCatalogForScope((catalogQuery.data ?? []) as BridgeCatalogModel[], saved);

  useEffect(() => {
    savedRef.current = saved;
  });
  // Fresh agent data replaces the optimistic value, except while our own saves are running.
  useEffect(() => {
    if (busyRef.current) return;
    serverRef.current = { model: saved.model, effort: saved.effort };
    setOptimistic(null);
  }, [saved.model, saved.effort]);

  const setDraft = (next: MainAgentModelSelection | null) => {
    draftRef.current = next;
    setDraftState(next);
  };
  const clearTimer = () => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const applySaved = (next: MainAgentModelSelection) => {
    queryClient.setQueryData<Agent[]>(queryKeys.agents.list(companyId), (list) => list?.map((item) => item.id === agent.id
      ? { ...item, adapterConfig: { ...item.adapterConfig, model: next.model, effort: next.effort } }
      : item));
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
    if (agent.urlKey) void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
  };

  /** Saves run one at a time; a change made meanwhile is saved next, against the value just stored. */
  const runSaves = async (first: MainAgentModelSelection) => {
    busyRef.current = true;
    setSaving(true);
    let next: MainAgentModelSelection | null = first;
    try {
      while (next) {
        setOptimistic(next);
        const scope = savedRef.current;
        await saveMainAgentModel({
          agentId: agent.id, companyId, next,
          saved: { hostId: scope.hostId, provider: scope.provider, ...serverRef.current },
        });
        serverRef.current = next;
        applySaved(next);
        const queued: MainAgentModelSelection | null = queuedRef.current;
        queuedRef.current = null;
        next = queued && !sameSelection(queued, serverRef.current) ? queued : null;
      }
    } catch (error) {
      queuedRef.current = null;
      clearTimer();
      setDraft(null);
      setOptimistic(sameSelection(serverRef.current, savedRef.current) ? null : serverRef.current);
      pushToast({
        title: "Couldn't change the model",
        body: error instanceof Error ? error.message : "The setting wasn't saved. Try again.",
        tone: "error",
      });
    } finally {
      busyRef.current = false;
      setSaving(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    }
  };

  const commit = (next: MainAgentModelSelection) => {
    clearTimer();
    setDraft(null);
    if (busyRef.current) {
      queuedRef.current = next;
      setOptimistic(next);
      return;
    }
    if (sameSelection(next, serverRef.current)) {
      setOptimistic(sameSelection(next, savedRef.current) ? null : next);
      return;
    }
    void runSaves(next);
  };
  const flush = () => {
    clearTimer();
    const pendingDraft = draftRef.current;
    if (pendingDraft) commit(pendingDraft);
  };
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });
  // A slider change still inside the debounce window is saved, not dropped, on unmount.
  useEffect(() => () => flushRef.current(), []);

  const shown = draft ?? optimistic ?? saved;
  const selectedModel = catalog.find((model) => model.id === shown.model);
  const efforts = bridgeModelEfforts(selectedModel);
  const stops = ["", ...efforts];
  const effortIndex = Math.max(0, stops.indexOf(effortForModel(shown.effort, efforts)));
  const displayName = bridgeModelDisplayName(shown.model, catalog, saved) || "Default model";
  const pillEffort = shown.effort ? mainAgentEffortLabel(shown.effort) : null;
  const summary = pillEffort ? `${pillEffort}, ${displayName}` : displayName;

  // Move focus with the view: into the list when it opens, back to the model button when it closes.
  useEffect(() => {
    if (!open) {
      previousViewRef.current = "main";
      return;
    }
    if (view === "models") {
      const list = listRef.current;
      const target = list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
        ?? list?.querySelector<HTMLElement>('[role="option"]') ?? backButtonRef.current;
      target?.focus();
    } else if (previousViewRef.current === "models") {
      modelButtonRef.current?.focus();
    }
    previousViewRef.current = view;
  }, [open, view]);
  // Opening focuses the slider; when it is still loading, focus waits on the model button
  // and moves to the slider once it appears, unless the viewer has moved focus meanwhile.
  const sliderFocusPendingRef = useRef(false);
  useEffect(() => {
    if (!sliderFocusPendingRef.current || !sliderRef.current) return;
    sliderFocusPendingRef.current = false;
    if (document.activeElement === modelButtonRef.current) sliderRef.current.focus();
  }, [open, view, efforts.length]);

  const pillContent = (
    <>
      {pillEffort ? (
        <>
          <span data-testid="main-agent-model-pill-effort" className="shrink-0">{pillEffort}</span>
          <span aria-hidden className="shrink-0 opacity-60">·</span>
        </>
      ) : null}
      <span data-testid="main-agent-model-pill-model" className="min-w-0 truncate">{compactBridgeModelName(displayName)}</span>
    </>
  );

  if (!canEdit) {
    return (
      <span data-testid="main-agent-model-readonly" title="You need permission to configure this agent to change its model."
        className={PILL_CLASS}>
        {pillContent}
      </span>
    );
  }

  const setView = (next: View) => {
    sliderFocusPendingRef.current = false;
    setViewChanged(true);
    setViewState(next);
  };
  const onOpenChange = (next: boolean) => {
    if (next) setBaseline({ model: (optimistic ?? saved).model, effort: (optimistic ?? saved).effort });
    else flush();
    sliderFocusPendingRef.current = false;
    setViewState("main");
    setViewChanged(false);
    setOpen(next);
  };
  const changeEffort = (index: number) => {
    setDraft({ model: shown.model, effort: stops[index] ?? "" });
    clearTimer();
    timerRef.current = window.setTimeout(flush, MAIN_AGENT_EFFORT_SAVE_DELAY);
  };
  const chooseModel = (model: BridgeCatalogModel) => {
    if (model.id !== shown.model) {
      commit({ model: model.id, effort: effortForModel(shown.effort, bridgeModelEfforts(model)) });
    }
    setView("main");
  };
  const resetEnabled = Boolean(baseline && !sameSelection(shown, baseline));
  const reset = () => {
    if (!baseline) return;
    commit(baseline);
    (sliderRef.current ?? modelButtonRef.current)?.focus();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (!options.length) return;
    const index = options.indexOf(document.activeElement as HTMLElement);
    const last = options.length - 1;
    const target = event.key === "ArrowDown" ? (index < 0 ? 0 : Math.min(last, index + 1))
      : event.key === "ArrowUp" ? (index < 0 ? last : Math.max(0, index - 1))
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : -1;
    if (target < 0) return;
    event.preventDefault();
    options[target]!.focus();
  };

  const iconBox = mobile ? "size-11" : "size-8";
  const catalogLoaded = catalogQuery.isSuccess;
  const modelMissing = catalogLoaded && Boolean(shown.model) && !selectedModel;
  // A model without effort levels runs at its default; otherwise the label names the slider stop.
  const headerMuted = Boolean(selectedModel) && !efforts.length;
  const headerEffort = mainAgentEffortLabel(selectedModel ? stops[effortIndex] ?? "" : shown.effort);
  const catalogError = catalogQuery.isError ? (
    <div role="alert" className="flex items-center justify-center gap-2 text-xs text-destructive">
      <span className="min-w-0">{catalogQuery.error instanceof Error ? catalogQuery.error.message : "Couldn't load models."}</span>
      <Button type="button" size="xs" variant="ghost" onClick={() => void catalogQuery.refetch()}>Retry</Button>
    </div>
  ) : null;

  const effortControl = catalogQuery.isPending ? (
    <div className="main-agent-effort-skeleton animate-pulse motion-reduce:animate-none" aria-hidden data-testid="main-agent-model-effort-loading" />
  ) : efforts.length ? (
    <div className="main-agent-effort" style={{ "--main-agent-effort-fraction": effortIndex / (stops.length - 1) } as CSSProperties}>
      <input ref={sliderRef} type="range" min={0} max={stops.length - 1} step={1} value={effortIndex}
        aria-label="Effort" aria-valuetext={mainAgentEffortLabel(stops[effortIndex] ?? "")}
        onChange={(event) => changeEffort(Number(event.target.value))} onPointerUp={flush}
        className="main-agent-effort-input" data-testid="main-agent-model-effort-slider" />
      <div className="main-agent-effort-track" aria-hidden>
        <div className="main-agent-effort-fill" />
        <div className="main-agent-effort-thumb" />
      </div>
    </div>
  ) : null;

  const mainView = (
    <div className={cn("flex flex-col gap-4", mobile ? "px-4 pb-5 pt-2" : "p-4")} data-testid="main-agent-model-main-view">
      <div className="flex items-center gap-2">
        <span className={cn("grid shrink-0 place-items-center text-muted-foreground", iconBox)} aria-hidden>
          {saving
            ? <Loader2 className="size-4 animate-spin" data-testid="main-agent-model-saving" />
            : <Sparkles className="size-4" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-center">
          <span data-testid="main-agent-model-effort"
            className={cn("text-sm font-semibold", headerMuted ? "text-muted-foreground" : "main-agent-model-accent")}>
            {headerEffort}
          </span>
          <button ref={modelButtonRef} type="button" onClick={() => setView("models")}
            aria-label={`Model: ${displayName}. Choose model`} data-testid="main-agent-model-current"
            className="inline-flex max-w-full items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0 truncate">{displayName}</span>
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          </button>
        </div>
        <button type="button" aria-label="Revert changes" disabled={!resetEnabled} onClick={reset}
          title={baseline ? `Revert to ${baseline.effort ? `${mainAgentEffortLabel(baseline.effort)} · ` : ""}${bridgeModelDisplayName(baseline.model, catalog, saved) || "Default model"}` : undefined}
          className={cn(ICON_BUTTON_CLASS, iconBox)} data-slot={mobile ? undefined : "icon-button"}>
          <RotateCcw className="size-4" aria-hidden />
        </button>
      </div>
      {effortControl}
      {catalogError}
      {modelMissing ? (
        <p role="alert" className="text-center text-xs text-destructive">This model isn't offered on this host anymore. Choose another.</p>
      ) : null}
      <p data-testid="main-agent-model-hint" className="text-center text-xs text-muted-foreground">{HELPER_TEXT}</p>
      <span role="status" className="sr-only">{saving ? "Saving…" : ""}</span>
    </div>
  );

  const groups = groupBridgeCatalog(catalog, saved);
  const tabStopId = selectedModel?.id ?? catalog[0]?.id;
  const modelView = (
    <div className="flex min-h-0 flex-col" data-testid="main-agent-model-models-view">
      <div className={cn("flex shrink-0 items-center gap-2", mobile ? "px-2 pb-1" : "p-2")}>
        <button ref={backButtonRef} type="button" aria-label="Back" onClick={() => setView("main")}
          className={cn(ICON_BUTTON_CLASS, iconBox)} data-slot={mobile ? undefined : "icon-button"}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span id={`${idBase}-models`} className="min-w-0 flex-1 text-center text-sm font-semibold">Model</span>
        <span className={cn("shrink-0", iconBox)} aria-hidden />
      </div>
      <div ref={listRef} role="listbox" aria-labelledby={`${idBase}-models`} onKeyDown={onListKeyDown}
        className={cn("min-h-0 overflow-y-auto overscroll-contain touch-pan-y", mobile ? "px-2 pb-4" : "max-h-80 px-1.5 pb-1.5")}>
        {groups.map((group, groupIndex) => (
          <div key={group.key || "unrouted"} role={group.label ? "group" : undefined}
            aria-labelledby={group.label ? `${idBase}-route-${groupIndex}` : undefined}>
            {group.label ? (
              <div id={`${idBase}-route-${groupIndex}`} data-testid="main-agent-model-route"
                className="px-2.5 pb-1 pt-2.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                {group.label}
              </div>
            ) : null}
            {group.models.map((model) => {
              const selected = model.id === shown.model;
              return (
                <button key={model.id} type="button" role="option" aria-selected={selected} title={model.id}
                  tabIndex={model.id === tabStopId ? 0 : -1} onClick={() => chooseModel(model)}
                  className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    mobile ? "min-h-11" : "h-9", selected && "font-medium")}>
                  <span className="min-w-0 flex-1 truncate">{bridgeModelDisplayName(model.id, catalog, saved)}</span>
                  {selected ? <Check className="main-agent-model-accent size-4 shrink-0" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        ))}
        {catalogQuery.isPending ? <p className="px-2.5 py-2 text-xs text-muted-foreground">Loading models…</p> : null}
        {catalogLoaded && !catalog.length ? <p className="px-2.5 py-2 text-xs text-muted-foreground">No models are available for this host.</p> : null}
        {catalogError ? <div className="px-2.5 py-2">{catalogError}</div> : null}
      </div>
    </div>
  );

  const body = (
    <div key={view} className={cn("flex min-h-0 flex-col", viewChanged && "animate-in fade-in-0 motion-reduce:animate-none",
      viewChanged && (view === "models" ? "slide-in-from-right-2" : "slide-in-from-left-2"))}>
      {view === "main" ? mainView : modelView}
    </div>
  );

  const trigger = (
    <button type="button" data-testid="main-agent-model-pill" aria-label={`Effort and model: ${summary}`} aria-busy={saving}
      className={cn(PILL_CLASS, "transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground")}>
      {pillContent}
      {saving
        ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
        : <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />}
    </button>
  );

  return mobile ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent side="bottom" showCloseButton={false} aria-describedby={undefined} data-testid="main-agent-model-sheet"
        className="max-h-(--sz-85vh) gap-0 rounded-t-2xl border-border bg-popover p-0 pb-(--sz-safe-bottom) text-popover-foreground">
        <div className="mx-auto mt-2 mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" aria-hidden />
        <SheetTitle className="sr-only">Effort and model</SheetTitle>
        {body}
        <SheetClose className="sr-only">Close</SheetClose>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} collisionPadding={8} aria-label="Effort and model"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          sliderFocusPendingRef.current = !sliderRef.current;
          (sliderRef.current ?? modelButtonRef.current)?.focus();
        }}
        className="w-(--main-agent-model-popover-width) max-w-(--radix-popover-content-available-width) overflow-hidden rounded-2xl border-border/70 p-0 shadow-(--shadow-main-agent-model-popover)"
        data-testid="main-agent-model-popover">
        {body}
      </PopoverContent>
    </Popover>
  );
}
