'use client';
import { useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import { useI18n } from '@/components/shell/LanguageProvider';
import { KNOWN_GATEWAYS, isReservedAgentName } from '@/lib/skill-validation';
import { CUSTOMIZATION_COPY } from './copy';

interface AgentRow { id: number; name: string; description: string; gateway: string; tier: string; enabled: boolean; version: number; skills: Array<{ name: string; ord: number }>; agentType?: string; gateways?: string[]; }
interface SkillRow { id: number; name: string; description: string; tier: string; enabled: boolean; version: number; agentTypes?: string[]; }
interface SpaceState { enabledAgentIds: number[]; enabledSkillIds: number[]; enabledIntegrationIds: number[]; toolAllowlist: string[]; version?: number }
interface IntegrationRow { id: number; name: string; kind: string; }

export default function CustomizationPage() {
  const { lang } = useI18n();
  const copy = CUSTOMIZATION_COPY[lang];
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [denied, setDenied] = useState(false);
  const [noAurora, setNoAurora] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState('');
  const [agentForm, setAgentForm] = useState({ name: '', description: '', persona: '', gateway: 'ops', routingKeywords: '' });
  const [skillForm, setSkillForm] = useState({ name: '', description: '', instructions: '' });
  const [selectedSkills, setSelectedSkills] = useState<Record<number, string>>({});
  const [attaching, setAttaching] = useState<number | null>(null);
  const [accountId, setAccountId] = useState('self');
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [allowlistText, setAllowlistText] = useState('');
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);

  async function load() {
    const r = await fetch('/api/customization');
    if (r.status === 401 || r.status === 403) { setDenied(true); return; }
    if (r.status === 400) { setNoAurora(true); return; }
    if (!r.ok) { setLoadError(true); return; }
    setLoadError(false);
    const d = await r.json();
    setAgents(d.agents || []); setSkills(d.skills || []);
    setAccountId(d.accountId || 'self');
    setSpace(d.space ? {
      enabledAgentIds: d.space.enabledAgentIds || [], enabledSkillIds: d.space.enabledSkillIds || [],
      enabledIntegrationIds: d.space.enabledIntegrationIds || [],
      toolAllowlist: d.space.toolAllowlist || [], version: d.space.version,
    } : null);
    setAllowlistText((d.space?.toolAllowlist || []).join(', '));
    const ir = await fetch('/api/integrations');
    if (ir.ok) setIntegrations(((await ir.json()).integrations || []).filter((i: IntegrationRow) => i.kind !== 'custom_mcp'));
  }
  useEffect(() => { load(); }, []);

  async function createAgent() {
    if (isReservedAgentName(agentForm.name)) { setMsg(copy.reservedAgentName); return; }
    const res = await fetch('/api/customization', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'agent', name: agentForm.name, description: agentForm.description, persona: agentForm.persona,
        gateway: agentForm.gateway,
        routingKeywords: agentForm.routingKeywords.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Created agent #${d.id} — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function createSkill() {
    const res = await fetch('/api/customization', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'skill', name: skillForm.name, description: skillForm.description, instructions: skillForm.instructions,
        toolAllowlist: [],
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Created skill #${d.id} — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function attachSkill(agent: AgentRow) {
    const skillId = Number(selectedSkills[agent.id]);
    if (!skillId || attaching !== null) return;
    setAttaching(agent.id);
    try {
      const ord = Math.max(-1, ...agent.skills.map((s) => s.ord)) + 1;
      const res = await fetch('/api/customization', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'attach', agentId: agent.id, skillId, ord }),
      });
      if (!res.ok) {
        setMsg(res.status === 409 ? copy.skillDisabled : res.status === 403 ? copy.attachmentForbidden :
          res.status === 404 ? copy.attachmentMissing : copy.attachmentFailed);
        return;
      }
      setSelectedSkills((current) => ({ ...current, [agent.id]: '' }));
      setMsg(copy.attached.replace('{agent}', agent.name));
      await load();
    } catch { setMsg(copy.attachmentFailed); }
    finally { setAttaching(null); }
  }
  async function toggle(kind: 'agent' | 'skill', id: number, enabled: boolean) {
    await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: enabled ? 'disable' : 'enable', kind, id }),
    });
    load();
  }
  async function saveSpace() {
    const enabledAgentIds = space?.enabledAgentIds ?? [];
    const enabledSkillIds = space?.enabledSkillIds ?? [];
    const enabledIntegrationIds = space?.enabledIntegrationIds ?? [];
    const toolAllowlist = allowlistText.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'space', enabledAgentIds, enabledSkillIds, enabledIntegrationIds, toolAllowlist }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Agent Space saved (v${data.version}) for ${accountId}` : `Error: ${JSON.stringify(data.error)}`);
    if (res.ok) load();
  }
  function toggleSpaceAgent(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledAgentIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledAgentIds: [...set] });
  }
  function toggleSpaceIntegration(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledIntegrationIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledIntegrationIds: [...set] });
  }

  if (denied) return <div className="p-6 text-[13px] text-ink-500">Admin access required (ADR-031).</div>;
  if (noAurora) return <div className="p-6 text-[13px] text-ink-500">Aurora is not configured — custom agents are unavailable.</div>;
  if (loadError) return <div className="p-6 text-[13px] text-ink-500">{copy.catalogUnavailable}</div>;

  return (
    <div className="text-ink-800">
      <PageHeader title="Custom Agents & Skills" />
      <div className="space-y-6 p-6">
      {msg && <div className="text-[12px] text-brand-600">{msg}</div>}

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Agent</h2>
        <p className="text-[12px] text-ink-500">{copy.agentHint}</p>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description" value={agentForm.description} onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="persona (system prompt)" value={agentForm.persona} onChange={(e) => setAgentForm({ ...agentForm, persona: e.target.value })} />
        <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={agentForm.gateway} onChange={(e) => setAgentForm({ ...agentForm, gateway: e.target.value })}>
          {KNOWN_GATEWAYS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="routing keywords (comma-separated)" value={agentForm.routingKeywords} onChange={(e) => setAgentForm({ ...agentForm, routingKeywords: e.target.value })} />
        <button onClick={createAgent} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create</button>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Skill</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description (≥100 chars recommended — describes when to use)" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" rows={4} placeholder="instructions (Markdown)" value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} />
        <p className="text-[12px] text-ink-500">{copy.skillHint}</p>
        <button onClick={createSkill} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create Skill</button>
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        {agents.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div>
              <span className="font-semibold">{a.name}</span>{' '}
              <span className="text-ink-400">({a.tier}, gw={a.gateway}, v{a.version}, skills={a.skills.length})</span>
              <div className="text-ink-500">{a.description}</div>
              <div className="text-ink-500">{copy.skills}: {a.skills.map((s) => s.name).join(', ') || '—'}</div>
              {a.tier === 'custom' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <select aria-label={copy.skillFor.replace('{agent}', a.name)} className="max-w-full rounded border border-ink-100 bg-paper px-2 py-1"
                    value={selectedSkills[a.id] || ''} onChange={(e) => setSelectedSkills((current) => ({ ...current, [a.id]: e.target.value }))}>
                    <option value="">{copy.selectSkill}</option>
                    {skills.filter((s) => s.enabled && !a.skills.some((attached) => attached.name === s.name)).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <button aria-label={copy.attachTo.replace('{agent}', a.name)} disabled={!selectedSkills[a.id] || attaching !== null}
                    onClick={() => attachSkill(a)} className="rounded border border-ink-100 px-2 py-1 disabled:opacity-40">{copy.attach}</button>
                </div>
              )}
            </div>
            {a.tier === 'custom'
              ? <button onClick={() => toggle('agent', a.id, a.enabled)} className={`rounded border px-2 py-1 text-[12px] ${a.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{a.enabled ? 'Enabled' : 'Disabled'}</button>
              : <span className="text-ink-400">built-in</span>}
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Skills</h2>
        {skills.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div><span className="font-semibold">{s.name}</span> <span className="text-ink-400">({s.tier}, v{s.version}{s.agentTypes && s.agentTypes.length ? `, ${s.agentTypes.join('/')}` : ''})</span><div className="text-ink-500">{s.description}</div></div>
            {s.tier === 'custom' && <button onClick={() => toggle('skill', s.id, s.enabled)} className={`rounded border px-2 py-1 text-[12px] ${s.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{s.enabled ? 'Enabled' : 'Disabled'}</button>}
          </div>
        ))}
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">Agent Space — account {accountId}</h2>
        {!space && (
          <div className="text-[12px] text-ink-500">
            Global (Phase-1) mode — all globally-enabled custom agents are available for this account.
            Saving below creates an Agent Space and scopes this account.
          </div>
        )}
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Enabled custom agents (account-scoped)</div>
          {agents.filter((a) => a.tier === 'custom').map((a) => (
            <label key={a.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledAgentIds.includes(a.id)} onChange={() => toggleSpaceAgent(a.id)} />
              {a.name}
            </label>
          ))}
          {agents.filter((a) => a.tier === 'custom').length === 0 && <span className="text-ink-400">no custom agents yet</span>}
        </div>
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Enabled integrations (account-scoped)</div>
          {integrations.map((i) => (
            <label key={i.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledIntegrationIds.includes(i.id)} onChange={() => toggleSpaceIntegration(i.id)} />
              {i.name}
            </label>
          ))}
          {integrations.length === 0 && <span className="text-ink-400">no integrations yet</span>}
        </div>
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Tool allowlist (account cap, comma-separated)</div>
          <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]"
                 placeholder="e.g. simulate_principal_policy, get_account_authorization_details"
                 value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} />
          <div className="mt-1 text-ink-400">Empty = no account cap (Phase-1 advisory). A non-empty list can only REMOVE tools a skill declared — it never grants new tools.</div>
        </div>
        <button onClick={saveSpace} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Save Agent Space</button>
      </section>
      </div>
    </div>
  );
}
