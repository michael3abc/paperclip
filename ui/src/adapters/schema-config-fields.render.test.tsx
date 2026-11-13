// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SchemaConfigFields, useConfigSchemaState, invalidateConfigSchemaCache } from './schema-config-fields';
import { TooltipProvider } from '../components/ui/tooltip';
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals(); invalidateConfigSchemaCache('ccpocket_bridge'); });
function mount() { const el = document.createElement('div'); document.body.append(el); return root = createRoot(el); }
const reply = (label: string) => new Response(JSON.stringify({ fields: [{ key: 'hostId', label, type: 'select', options: [] }] }), { status: 200 });

it('isolates company/provider schema caches and ignores an outdated response', async () => {
  const pending: { url: string; resolve: (r: Response) => void }[] = [];
  vi.stubGlobal('fetch', vi.fn(url => new Promise<Response>(resolve => pending.push({ url: String(url), resolve }))));
  function Probe({ company, provider }: { company: string; provider: string }) {
    const result = useConfigSchemaState('ccpocket_bridge', { companyId: company, hostId: company + '-host', provider });
    return <div>{result.error ?? result.schema?.fields[0]?.label ?? 'loading'}</div>;
  }
  const r = mount();
  await act(async () => r.render(<Probe company="home" provider="claude" />));
  await act(async () => r.render(<Probe company="shop" provider="codex" />));
  expect(document.body.textContent).toBe('loading');
  expect(pending[1].url).toContain('companyId=shop');
  expect(pending[1].url).toContain('provider=codex');
  await act(async () => pending[1].resolve(reply('shop-models')));
  await act(async () => pending[0].resolve(reply('home-models')));
  expect(document.body.textContent).toBe('shop-models');
  await act(async () => r.render(<Probe company="home" provider="claude" />));
  expect(document.body.textContent).toBe('home-models');
  expect(pending).toHaveLength(2);
});

it.each([true, false])('clears the dependent model in create=%s when executor changes', async isCreate => {
  const schema = { fields: [
    { key: 'provider', label: '執行器', type: 'select', meta: { resetsFields: ['model'] }, options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }] },
    { key: 'model', label: '模型', type: 'combobox', options: [] },
  ] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(schema))));
  const set = vi.fn(), mark = vi.fn();
  const config = { hostId: 'local', provider: 'claude', model: 'local/claude/opus' };
  await act(async () => mount().render(<TooltipProvider><SchemaConfigFields adapterType="ccpocket_bridge" companyId="home" isCreate={isCreate} mode={isCreate ? 'create' : 'edit'}
    section="adapter" hideModel values={{ adapterSchemaValues: config, model: config.model } as any} set={set} config={config}
    eff={(_g, _k, original) => original} mark={mark} models={[]} /></TooltipProvider>));
  const trigger = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Claude'))!;
  act(() => trigger.click());
  const option = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Codex')!;
  act(() => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  if (isCreate) expect(set).toHaveBeenLastCalledWith({ adapterSchemaValues: { ...config, provider: 'codex', model: '' }, model: '' });
  else expect(mark.mock.calls).toEqual([['adapterConfig', 'provider', 'codex'], ['adapterConfig', 'model', '']]);
});

it('surfaces schema failure without presenting another company catalog', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Company has no configured hosts' }), { status: 422 })));
  await act(async () => mount().render(<SchemaConfigFields adapterType="ccpocket_bridge" companyId="missing" isCreate={false} mode="edit" section="adapter" hideModel values={null} set={null} config={{}}
    eff={(_g, _k, original) => original} mark={() => {}} models={[]} />));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Company has no configured hosts');
});
