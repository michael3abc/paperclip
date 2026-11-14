import { useId, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, RotateCcw, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToastActions } from "@/context/ToastContext";
import { useMobileEntityPickerViewportStyle } from "@/hooks/useMobileEntityPickerViewportStyle";
import { ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS } from "@/lib/native-model-catalog";
import { queryKeys } from "@/lib/queryKeys";
import {
  BRIDGE_ADAPTER_TYPE, bridgeCatalogForScope, bridgeModelDisplayName, bridgeModelEfforts, canEditAgentConfiguration,
  effortForModel, mainAgentEffortLabel, readMainAgentModelScope, sameSelection, saveMainAgentModel,
  type BridgeCatalogModel, type MainAgentModelSelection,
} from "./main-agent-model";
import "./composer-run-settings.css";

interface Props {
  agent: Agent;
  companyId: string;
  mobile?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };

/**
 * Main-agent chat composer control for the agent's saved Bridge model and effort.
 * A saved change applies from the agent's next turn in the same native session.
 */
export function MainAgentModelPicker({ agent, companyId, mobile = false }: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const mobileViewportStyle = useMobileEntityPickerViewportStyle();
  const sliderId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MainAgentModelSelection | null>(null);
  const [pending, setPending] = useState<MainAgentModelSelection | null>(null);
  const saved = readMainAgentModelScope(agent.adapterConfig);
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

  const save = useMutation({
    mutationFn: (next: MainAgentModelSelection) => saveMainAgentModel({ agentId: agent.id, companyId, saved, next }),
    onMutate: (next) => setPending(next),
    onSuccess: (_updated, next) => {
      queryClient.setQueryData<Agent[]>(queryKeys.agents.list(companyId), (list) => list?.map((item) => item.id === agent.id
        ? { ...item, adapterConfig: { ...item.adapterConfig, model: next.model, effort: next.effort } }
        : item));
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      if (agent.urlKey) void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
    onError: (error) => {
      pushToast({ title: "無法變更模型", body: error instanceof Error ? error.message : "儲存失敗，請再試一次。", tone: "error" });
    },
    onSettled: () => {
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });
  const saving = save.isPending;
  const shown = pending ?? saved;
  const shownName = bridgeModelDisplayName(shown.model, catalog, saved) || "未設定模型";
  const shownEffort = shown.effort ? mainAgentEffortLabel(shown.effort) : null;

  if (!canEdit) {
    return (
      <span data-testid="main-agent-model-readonly" title="需要此 agent 的設定權限才能變更模型"
        className="flex h-8 min-w-0 max-w-full items-center gap-1.5 px-2.5 text-xs font-medium text-muted-foreground">
        {shownEffort ? <span className="shrink-0">{shownEffort}</span> : null}
        <span className="min-w-0 truncate">{shownName}</span>
      </span>
    );
  }

  const selection = draft ?? saved;
  const selectedModel = catalog.find((model) => model.id === selection.model);
  const efforts = bridgeModelEfforts(selectedModel);
  const stops = ["", ...efforts];
  const effortIndex = Math.max(0, stops.indexOf(effortForModel(selection.effort, efforts)));
  const dirty = !sameSelection(selection, saved);
  const savedMissing = catalogQuery.isSuccess && Boolean(saved.model) && !catalog.some((model) => model.id === saved.model);
  const canApply = dirty && !saving && Boolean(selectedModel);

  const onOpenChange = (next: boolean) => {
    if (next && saving) return;
    setOpen(next);
    setDraft(next ? { model: saved.model, effort: saved.effort } : null);
  };
  const chooseModel = (model: BridgeCatalogModel) => {
    setDraft({ model: model.id, effort: effortForModel(selection.effort, bridgeModelEfforts(model)) });
  };
  const apply = () => {
    if (!canApply) return;
    const next = { model: selection.model, effort: effortForModel(selection.effort, efforts) };
    onOpenChange(false);
    save.mutate(next);
  };
  const providerLabel = PROVIDER_LABELS[saved.provider] ?? saved.provider;
  const closeButton = mobile ? (
    <DialogClose asChild>
      <button type="button" aria-label="關閉" className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent">
        <X className="size-4" aria-hidden />
      </button>
    </DialogClose>
  ) : null;

  const trigger = (
    <button type="button" disabled={saving} aria-label="選擇模型與推理強度" aria-haspopup="dialog" aria-expanded={open}
      aria-busy={saving} data-testid="main-agent-model-pill"
      className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
      {shownEffort ? <span data-testid="main-agent-model-pill-effort" className="shrink-0 text-foreground">{shownEffort}</span> : null}
      <span data-testid="main-agent-model-pill-model" className="min-w-0 truncate">{shownName}</span>
      {saving ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden /> : <ChevronDown className="size-3 shrink-0" aria-hidden />}
    </button>
  );

  const body = (
    <div className="flex min-h-0 flex-col gap-3 p-3" data-testid="main-agent-model-panel">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">模型與推理強度</p>
          <p className="truncate text-xs text-muted-foreground">{saved.hostId ? `${providerLabel} · ${saved.hostId}` : providerLabel}</p>
        </div>
        <button type="button" aria-label="還原為已儲存設定" title="還原為已儲存設定" disabled={!dirty || saving}
          onClick={() => setDraft({ model: saved.model, effort: saved.effort })}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-40">
          <RotateCcw className="size-4" aria-hidden />
        </button>
        {closeButton}
      </div>

      {efforts.length ? (
        <div>
          <div className="flex items-center gap-2">
            <label htmlFor={sliderId} className="min-w-0 flex-1 text-xs text-muted-foreground">推理強度</label>
            <span data-testid="main-agent-model-effort" className="composer-run-settings-accent text-sm font-medium">
              {mainAgentEffortLabel(stops[effortIndex] ?? "")}
            </span>
          </div>
          <input id={sliderId} type="range" min={0} max={stops.length - 1} step={1} value={effortIndex} disabled={saving}
            aria-label="推理強度" aria-valuetext={mainAgentEffortLabel(stops[effortIndex] ?? "")}
            onChange={(event) => setDraft({ model: selection.model, effort: stops[Number(event.target.value)] ?? "" })}
            className="composer-run-effort-range mt-3 w-full"
            style={{ "--fill": `${(effortIndex / (stops.length - 1)) * 100}%` } as CSSProperties} />
          <div className="mt-2 flex justify-between text-xs text-muted-foreground" aria-hidden>
            {stops.map((stop) => <span key={stop || "default"}>{stop ? mainAgentEffortLabel(stop) : "預設"}</span>)}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 max-h-60 overflow-y-auto overscroll-contain touch-pan-y" role="listbox" aria-label="模型">
        {catalog.map((model) => (
          <button key={model.id} type="button" role="option" aria-selected={model.id === selection.model} disabled={saving}
            onClick={() => chooseModel(model)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
            <span className="min-w-0 flex-1 truncate font-medium">{model.label || model.id}</span>
            {model.source ? <span className="shrink-0 text-xs text-muted-foreground">{model.source}</span> : null}
            {model.id === selection.model ? <Check className="composer-run-settings-accent size-4 shrink-0" aria-hidden /> : null}
          </button>
        ))}
        {catalogQuery.isPending ? <p className="px-2 py-2 text-xs text-muted-foreground">正在載入模型清單…</p> : null}
        {catalogQuery.isSuccess && !catalog.length ? <p className="px-2 py-2 text-xs text-muted-foreground">此主機與執行器沒有可用的模型。</p> : null}
        {catalogQuery.isError ? (
          <div role="alert" className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">{catalogQuery.error instanceof Error ? catalogQuery.error.message : "無法載入模型清單。"}</span>
            <Button type="button" size="xs" variant="ghost" onClick={() => void catalogQuery.refetch()}>重試</Button>
          </div>
        ) : null}
      </div>
      {savedMissing ? <p role="alert" className="text-xs text-destructive">目前模型不在此主機與執行器的清單中，請重新選擇。</p> : null}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <p data-testid="main-agent-model-hint" className="min-w-0 flex-1 text-xs text-muted-foreground">變更會從下一輪開始，在同一個 session 中套用。</p>
        <Button type="button" size="sm" onClick={apply} disabled={!canApply}>套用</Button>
      </div>
    </div>
  );

  return mobile ? (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent aria-describedby={undefined} showCloseButton={false} style={mobileViewportStyle}
        className="composer-mobile-dialog gap-0 overflow-hidden p-0" data-testid="main-agent-model-dialog">
        <DialogTitle className="sr-only">選擇模型與推理強度</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  ) : (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-80 max-w-full p-0 shadow-sm" data-testid="main-agent-model-popover">
        {body}
      </PopoverContent>
    </Popover>
  );
}
