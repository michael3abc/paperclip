import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatPmWorkerPolicyJson, pmWorkerPolicySchema, type PmWorkerPolicy, type PmWorkerPolicyView, type PmWorkerSelection } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/select";
import { Input } from "./ui/input";

type Row = PmWorkerSelection & { agentId: string; harness: "claude_local" | "codex_local" };
const modelKey = (id: string, binding?: PmWorkerSelection["aiConnection"]) => binding
  ? `${id}::${binding.mode}:${binding.connectionId}:${binding.grantId}` : id;

export function PmWorkerSettings({ agentId }: { agentId: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["pm-worker-policy", agentId], queryFn: () => agentsApi.workerPolicy(agentId), retry: false, refetchOnWindowFocus: false });
  if (query.error && !query.data) return <p role="alert">{query.error.message} <Button variant="outline" onClick={() => void query.refetch()}>Reload</Button></p>;
  if (!query.data) return <p>Loading worker settings…</p>;
  return <WorkerEditor key={agentId} agentId={agentId} initial={query.data} onSaved={async () => {
    await client.invalidateQueries({ queryKey: ["pm-worker-policy", agentId] });
    await client.invalidateQueries({ queryKey: ["agents"] });
  }} />;
}

function WorkerEditor({ agentId, initial, onSaved }: { agentId: string; initial: PmWorkerPolicyView; onSaved: () => Promise<void> }) {
  const [base, setBase] = useState(initial);
  const [rows, setRows] = useState<Row[]>(() => initial.policy?.workers.flatMap(worker => worker.selections.map(choice => ({ ...choice, agentId: worker.agentId, harness: worker.harness }))) ?? []);
  const [defaultId, setDefaultId] = useState(initial.policy?.defaultSelectionId ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const change = (id: string, patch: Partial<Row>) => { setRows(values => values.map(row => row.id === id ? { ...row, ...patch } : row)); setSaved(false); };
  const workers: PmWorkerPolicy["workers"] = [];
  for (const { agentId: workerId, harness, ...choice } of rows) {
    let worker = workers.find(worker => worker.agentId === workerId);
    if (!worker) { worker = { agentId: workerId, harness, selections: [] }; workers.push(worker); }
    worker.selections.push(choice);
  }
  const draft: PmWorkerPolicy = { version: 2, defaultSelectionId: defaultId, workers };
  async function save() {
    setBusy(true); setError(""); setSaved(false);
    try {
      const policy = pmWorkerPolicySchema.parse(draft);
      const receipt = await agentsApi.saveWorkerPolicy(agentId, { policy, baseRevision: base.revision, baseHash: base.documentHash });
      const current = await agentsApi.workerPolicy(agentId);
      if (current.revision !== receipt.revision || current.documentHash !== receipt.documentHash) throw new Error("Worker settings changed after saving. Reload to review the current version.");
      setBase(current); setRows(current.policy?.workers.flatMap(worker => worker.selections.map(choice => ({ ...choice, agentId: worker.agentId, harness: worker.harness }))) ?? []);
      setDefaultId(current.policy?.defaultSelectionId ?? ""); setSaved(true); await onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const validRows = rows.every(row => {
    const worker = base.catalog.find(item => item.agentId === row.agentId);
    const model = worker?.models.find(item => modelKey(item.id, item.aiConnection) === modelKey(row.model, row.aiConnection ?? worker.defaultAiConnection));
    return model && (row.thinking === null || model.thinking.includes(row.thinking))
      && worker?.permissions.includes(row.permission) && model.speeds.includes(row.speed);
  });
  return <section className="space-y-4" aria-label="PM worker settings">
    <h2 className="text-lg font-medium">Workers</h2>
    <fieldset disabled={busy} className="space-y-4">
      {rows.map((row, index) => {
        const catalog = base.catalog.find(worker => worker.agentId === row.agentId);
        const model = catalog?.models.find(model => modelKey(model.id, model.aiConnection) === modelKey(row.model, row.aiConnection ?? catalog.defaultAiConnection));
        return <div key={row.id} className="space-y-3 rounded-md border border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2"><input type="radio" name={`default-worker-${agentId}`} checked={defaultId === row.id} onChange={() => { setDefaultId(row.id); setSaved(false); }} />Default</label>
            <Button variant="ghost" onClick={() => { setRows(values => values.filter(value => value.id !== row.id)); if (defaultId === row.id) setDefaultId(""); setSaved(false); }}>Remove</Button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
            <label>Harness<NativeSelect aria-label={`Worker ${index + 1} harness`} value={row.agentId} onChange={event => {
              const worker = base.catalog.find(worker => worker.agentId === event.target.value)!;
              change(row.id, { agentId: worker.agentId, harness: worker.harness, aiConnection: undefined, model: "", thinking: null, permission: "" as Row["permission"], speed: "standard" });
            }}><option value="" disabled>Choose harness</option>{base.catalog.map(worker => <option key={worker.agentId} value={worker.agentId}>{worker.harness === "claude_local" ? "Claude" : "Codex"} · {worker.name}</option>)}
              {row.agentId && !catalog && <option value={row.agentId}>Unavailable worker</option>}</NativeSelect></label>
            <label>Model<NativeSelect aria-label={`Worker ${index + 1} model`} value={modelKey(row.model, row.aiConnection ?? catalog?.defaultAiConnection)} onChange={event => {
              const selected = catalog?.models.find(item => modelKey(item.id, item.aiConnection) === event.target.value);
              if (selected) change(row.id, { model: selected.id, aiConnection: selected.aiConnection, thinking: null, speed: "standard" });
            }}>
              <option value="" disabled>Choose model</option>{catalog?.models.map(model => <option key={modelKey(model.id, model.aiConnection)} value={modelKey(model.id, model.aiConnection)}>{model.label}</option>)}
              {row.model && !model && <option value={modelKey(row.model, row.aiConnection ?? catalog?.defaultAiConnection)}>{row.model} · Unavailable</option>}</NativeSelect></label>
            <label>Thinking<NativeSelect aria-label={`Worker ${index + 1} thinking`} value={row.thinking ?? ""} disabled={!model?.thinking.length} onChange={event => change(row.id, { thinking: event.target.value || null })}>
              <option value="">Auto</option>{model?.thinking.map(value => <option key={value}>{value}</option>)}
              {row.thinking && !model?.thinking.includes(row.thinking) && <option value={row.thinking}>{row.thinking} · Unavailable</option>}</NativeSelect></label>
            <label>Permission<NativeSelect aria-label={`Worker ${index + 1} permission`} value={row.permission} onChange={event => change(row.id, { permission: event.target.value as Row["permission"] })}>
              <option value="" disabled>Choose permission</option>{catalog?.permissions.map(value => <option key={value}>{value}</option>)}
              {row.permission && !catalog?.permissions.includes(row.permission) && <option value={row.permission}>{row.permission} · Unavailable</option>}</NativeSelect></label>
            <label>Speed<NativeSelect aria-label={`Worker ${index + 1} speed`} value={row.speed} disabled={!model} onChange={event => change(row.id, { speed: event.target.value as Row["speed"] })}>
              <option value="standard">Standard</option><option value="fast" disabled={!model?.speeds.includes("fast")}>Fast</option></NativeSelect></label>
            <label>Purpose<Input aria-label={`Worker ${index + 1} purpose`} value={row.purpose ?? ""} maxLength={500} placeholder="用途" onChange={event => change(row.id, { purpose: event.target.value })} /></label>
          </div>
        </div>;
      })}
      <Button variant="outline" disabled={rows.length >= 100} onClick={() => { setRows(values => [...values, { id: crypto.randomUUID(), agentId: "", harness: "claude_local", model: "", thinking: null, permission: "" as Row["permission"], speed: "standard", purpose: "" }]); setSaved(false); }}>Add worker option</Button>
    </fieldset>
    <details><summary>Worker settings JSON</summary><pre aria-label="Worker settings JSON" className="whitespace-pre-wrap break-words text-sm">{formatPmWorkerPolicyJson(draft)}</pre></details>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {saved && <p role="status">Worker settings and {base.documentPath} saved.</p>}
    <div className="flex items-center justify-between gap-3">
      <Button variant="outline" disabled={busy} onClick={async () => {
        try { const current = await agentsApi.workerPolicy(agentId); setBase(current); setRows(current.policy?.workers.flatMap(worker => worker.selections.map(choice => ({ ...choice, agentId: worker.agentId, harness: worker.harness }))) ?? []); setDefaultId(current.policy?.defaultSelectionId ?? ""); setError(""); setSaved(false); }
        catch (error) { setError(String(error)); }
      }}>Discard and reload</Button>
      <Button disabled={busy || !rows.length || !defaultId || !validRows} onClick={() => void save()}>{busy ? "Saving…" : "Save workers"}</Button>
    </div>
  </section>;
}
