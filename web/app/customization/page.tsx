'use client';
import { useEffect, useState } from 'react';

interface AgentRow { id: number; name: string; description: string; gateway: string; tier: string; enabled: boolean; version: number; skills: Array<{ name: string }>; agentType?: string; gateways?: string[]; }
interface SkillRow { id: number; name: string; description: string; tier: string; enabled: boolean; version: number; agentTypes?: string[]; }
interface SpaceState { enabledAgentIds: number[]; enabledSkillIds: number[]; toolAllowlist: string[]; version?: number }

const GATEWAYS = ['network', 'container', 'iac', 'data', 'security', 'monitoring', 'cost', 'ops'];
// ADR-039 agent-type lifecycle roles (mirrors web/lib/skill-validation.ts AGENT_TYPES).
const AGENT_TYPES = ['generic', 'on_demand', 'triage', 'rca', 'mitigation', 'evaluation'];

export default function CustomizationPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [denied, setDenied] = useState(false);
  const [noAurora, setNoAurora] = useState(false);
  const [msg, setMsg] = useState('');
  const [agentForm, setAgentForm] = useState({ name: '', description: '', persona: '', gateway: 'ops', routingKeywords: '', agentType: 'generic', model: '', responseLanguage: '', gateways: [] as string[] });
  const [skillForm, setSkillForm] = useState({ name: '', description: '', instructions: '', agentTypes: ['generic'] as string[] });
  const [accountId, setAccountId] = useState('self');
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [allowlistText, setAllowlistText] = useState('');

  async function load() {
    const r = await fetch('/api/customization');
    if (r.status === 401 || r.status === 403) { setDenied(true); return; }
    if (r.status === 400) { setNoAurora(true); return; }
    const d = await r.json();
    setAgents(d.agents || []); setSkills(d.skills || []);
    setAccountId(d.accountId || 'self');
    setSpace(d.space ? {
      enabledAgentIds: d.space.enabledAgentIds || [], enabledSkillIds: d.space.enabledSkillIds || [],
      toolAllowlist: d.space.toolAllowlist || [], version: d.space.version,
    } : null);
    setAllowlistText((d.space?.toolAllowlist || []).join(', '));
  }
  useEffect(() => { load(); }, []);

  async function createAgent() {
    const res = await fetch('/api/customization', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'agent', name: agentForm.name, description: agentForm.description, persona: agentForm.persona,
        gateway: agentForm.gateway, agentType: agentForm.agentType,
        model: agentForm.model || undefined, responseLanguage: agentForm.responseLanguage || undefined,
        gateways: agentForm.gateways.length ? agentForm.gateways : undefined,
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
        toolAllowlist: [], agentTypes: skillForm.agentTypes,
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Created skill #${d.id} — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  function toggleInArray(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
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
    const toolAllowlist = allowlistText.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'space', enabledAgentIds, enabledSkillIds, toolAllowlist }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Agent Space saved (v${data.version}) for ${accountId}` : `Error: ${JSON.stringify(data.error)}`);
    if (res.ok) load();
  }
  function toggleSpaceAgent(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledAgentIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledAgentIds: [...set] });
  }

  if (denied) return <div className="p-6 text-[13px] text-ink-500">Admin access required (ADR-031).</div>;
  if (noAurora) return <div className="p-6 text-[13px] text-ink-500">Aurora is not configured — custom agents are unavailable.</div>;

  return (
    <div className="space-y-6 p-6 text-ink-800">
      <h1 className="text-lg font-semibold">Custom Agents &amp; Skills</h1>
      {msg && <div className="text-[12px] text-claude-600">{msg}</div>}

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Agent</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description" value={agentForm.description} onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="persona (system prompt)" value={agentForm.persona} onChange={(e) => setAgentForm({ ...agentForm, persona: e.target.value })} />
        <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={agentForm.gateway} onChange={(e) => setAgentForm({ ...agentForm, gateway: e.target.value })}>
          {GATEWAYS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="routing keywords (comma-separated)" value={agentForm.routingKeywords} onChange={(e) => setAgentForm({ ...agentForm, routingKeywords: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-ink-500">agent type</label>
          <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={agentForm.agentType} onChange={(e) => setAgentForm({ ...agentForm, agentType: e.target.value })}>
            {AGENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="model (optional)" value={agentForm.model} onChange={(e) => setAgentForm({ ...agentForm, model: e.target.value })} />
          <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="response language (optional)" value={agentForm.responseLanguage} onChange={(e) => setAgentForm({ ...agentForm, responseLanguage: e.target.value })} />
        </div>
        <div className="text-[11px] text-ink-500">
          <span className="mr-2">gateways (multi — defaults to the primary above)</span>
          {GATEWAYS.map((g) => (
            <label key={g} className="mr-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={agentForm.gateways.includes(g)} onChange={() => setAgentForm({ ...agentForm, gateways: toggleInArray(agentForm.gateways, g) })} />
              {g}
            </label>
          ))}
        </div>
        <button onClick={createAgent} className="rounded bg-claude-500 px-3 py-1 text-[12px] font-medium text-white">Create</button>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Skill</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description (≥100 chars recommended — describes when to use)" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" rows={4} placeholder="instructions (Markdown)" value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} />
        <div className="text-[11px] text-ink-500">
          <span className="mr-2">agent types (targeting)</span>
          {AGENT_TYPES.map((t) => (
            <label key={t} className="mr-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={skillForm.agentTypes.includes(t)} onChange={() => setSkillForm({ ...skillForm, agentTypes: toggleInArray(skillForm.agentTypes, t) })} />
              {t}
            </label>
          ))}
        </div>
        <button onClick={createSkill} className="rounded bg-claude-500 px-3 py-1 text-[12px] font-medium text-white">Create Skill</button>
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        {agents.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div>
              <span className="font-semibold">{a.name}</span>{' '}
              <span className="text-ink-400">({a.tier}, {a.agentType || 'generic'}, gw={(a.gateways && a.gateways.length ? a.gateways.join('+') : a.gateway)}, v{a.version}, skills={a.skills.length})</span>
              <div className="text-ink-500">{a.description}</div>
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
          <div className="mb-1 font-medium">Tool allowlist (account cap, comma-separated)</div>
          <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]"
                 placeholder="e.g. simulate_principal_policy, get_account_authorization_details"
                 value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} />
          <div className="mt-1 text-ink-400">Empty = no account cap (Phase-1 advisory). A non-empty list can only REMOVE tools a skill declared — it never grants new tools.</div>
        </div>
        <button onClick={saveSpace} className="rounded bg-claude-500 px-3 py-1 text-[12px] font-medium text-white">Save Agent Space</button>
      </section>
    </div>
  );
}
