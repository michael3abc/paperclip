export const bindingFor = c => ({ provider: c.provider, method: c.method, mode: c.ownership === 'shared' ? 'shared' : 'delegated', connectionId: c.id, grantId: c.grantId });
export function runnerConfig(provider, model, effort) {
  if (!['claude', 'codex'].includes(provider) || !model) throw new Error('Explicit engine and model required');
  return provider === 'claude'
    ? { provider: 'acpx', acpxAgent: 'claude', model, acpxPermissionMode: 'approve-all', ...(effort ? { env: { CLAUDE_CODE_EFFORT_LEVEL: effort } } : {}) }
    : { provider: 'codex', model, codexPermissionMode: 'never', ...(effort ? { modelReasoningEffort: effort } : {}) };
}
export function catalogGroups(h, routerUrl) {
  if (h.status !== 'ok' || h.router !== 'compass-codex-kit') throw new Error('Gateway identity/health mismatch');
  return [
    ['anthropic', 'messages', 'gateway', 'CC Pocket · Compass', h.anthropic_aliases],
    ['anthropic', 'messages', 'local', 'CC Pocket · Local', h.anthropic_local_responses_aliases],
    ['openai', 'responses', 'gateway', 'CC Pocket · Codex Compass', h.compass_aliases],
    ['openai', 'responses', 'local', 'CC Pocket · Codex Local', h.local_responses_aliases],
  ].map(([provider, protocol, kind, name, entries]) => {
    if (!Array.isArray(entries)) throw new Error(`Missing catalog: ${name}`);
    const models = entries.filter(e => kind !== 'local' || e.status === 'ready').map(e => {
      if (typeof e.selector !== 'string' || !e.selector.trim()) throw new Error('Invalid gateway model selector');
      return { id: e.selector, label: `${e.model || e.selector} · ${kind === 'local' ? 'Local' : 'Compass'}` };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (!models.length || new Set(models.map(m => m.id)).size !== models.length) throw new Error(`Empty or duplicate catalog: ${name}`);
    return { provider, method: 'api_key', name, ownership: 'personal', allAgents: true, agentIds: [],
      routing: { kind, protocol, baseUrl: `${routerUrl.replace(/\/$/, '')}${protocol === 'responses' ? '/v1' : ''}`, auth: 'bearer', models } };
  });
}
