'use client';
import { useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import { AGENT_TYPES as KNOWN_AGENT_TYPES, KNOWN_GATEWAYS } from '@/lib/skill-validation';

interface AgentRow { id: number; name: string; description: string; gateway: string; tier: string; enabled: boolean; version: number; skills: Array<{ name: string }>; agentType?: string; gateways?: string[]; }
interface SkillRow { id: number; name: string; description: string; tier: string; enabled: boolean; version: number; agentTypes?: string[]; }
interface SpaceState { enabledAgentIds: number[]; enabledSkillIds: number[]; enabledIntegrationIds: number[]; toolAllowlist: string[]; version?: number }
interface IntegrationRow { id: number; name: string; kind: string; direction: string; capability: string; enabled: boolean; tier: string; receivePath?: string | null; }

const GATEWAYS = [...KNOWN_GATEWAYS];
const AGENT_TYPES = [...KNOWN_AGENT_TYPES];
const WORKSHOP_STEPS = [
  {
    title: 'Agent Space',
    body: '계정, 외부 관측성 소스, webhook 진입점을 하나의 운영 공간으로 묶습니다.',
    tasks: ['Configure secondary cloud source', 'Connect to Agent'],
  },
  {
    title: 'Agent',
    body: 'Form 또는 Chat으로 조사 페르소나, routingKeywords, gateway 범위를 초안화합니다.',
    tasks: ['Form', 'Chat'],
  },
  {
    title: 'Skill',
    body: '팀 런북을 SKILL.md 절차로 등록하고 관련 agent type에만 적용합니다.',
    tasks: ['Create skill', 'Create skill with Chat', 'Upload skill', 'Import from repository'],
  },
  {
    title: 'MCP / Webhook',
    body: '외부 이벤트와 observability 읽기 도구를 연결하되, 조사는 read-only로 시작합니다.',
    tasks: ['Ensure data schema matches DevOps Agent requirements', 'Configure webhook authentication', 'Generate URL and credentials'],
  },
  {
    title: 'Knowledge',
    body: '항상 포함되는 지침, 선택 로드되는 skill, 기억/학습 자산의 차이를 구분합니다.',
    tasks: ['Instructions', 'Skills', 'Memories'],
  },
] as const;
const AGENT_PATHS = [
  ['Form', '이 페이지의 New Agent 폼으로 이름, persona, gateway, routingKeywords를 직접 작성합니다. 생성 후 기본값은 disabled입니다.'],
  ['Chat', '대화로 agent 초안을 만들 때의 콘솔 흐름입니다. v2에서는 초안 작성만 의미하며 AWS 리소스 변경이나 자율 실행을 켜지 않습니다.'],
] as const;
const SKILL_PATHS = [
  ['Create skill', '폼에서 SKILL.md instructions를 직접 작성합니다. description은 언제 이 skill을 쓸지 검색 가능한 증상/서비스/메트릭으로 씁니다.'],
  ['Create skill with Chat', '콘솔의 chat-assisted 작성 경로입니다. 초안을 만든 뒤 사람이 검토하고 disabled 상태로 저장하는 흐름으로 설명합니다.'],
  ['Upload skill', 'SKILL.md와 references/를 zip으로 올리는 경로입니다 — 아래 New Skill 섹션의 파일 업로드로 바로 사용 가능합니다. 실행 스크립트가 아니라 참조 문서와 절차만 다룹니다.'],
  ['Import from repository', 'GitHub 디렉터리에서 skill을 가져오는 경로입니다 — 아래 New Skill 섹션의 저장소 URL 입력으로 바로 사용 가능합니다. curated/validation-only 흐름(disabled 생성, 검토 후 활성화)입니다.'],
] as const;
const KNOWLEDGE_ASSETS = [
  ['Instructions', '항상 시스템 컨텍스트에 들어가는 전역 행동 규칙입니다. 예: 증거 우선, read-only 진단, 출력 형식.'],
  ['Skills', '관련 사건/질문에서 선택적으로 로드되는 조사 절차입니다. 예: RDS performance investigation.'],
  ['Memories', '세션에서 학습한 운영 맥락입니다. 현재 안내에서는 읽기/참조 개념으로만 다루고 자동 조치는 연결하지 않습니다.'],
] as const;
// Mirrors the actual generic-webhook contract the ingress route normalizes
// (web/lib/incident-normalize.ts → normalizeGeneric): severity critical|warning|info,
// status firing|resolved. Keeping this in sync prevents operators from misconfiguring
// severity/status. Ingress is flag-gated (INCIDENT_LIFECYCLE_ENABLED, default off).
const WEBHOOK_SCHEMA = `{
  title: string;                              // alert name
  severity: 'critical' | 'warning' | 'info';
  status: 'firing' | 'resolved';
  message?: string;                           // or "description"
  timestamp?: string;                         // ISO 8601
  labels?: {                                  // service/resource hints
    service?: string; namespace?: string;
    instance?: string; pod?: string; node?: string;
  };
  annotations?: { summary?: string };
}`;
const WEBHOOK_STEPS = [
  'Ensure data schema matches DevOps Agent requirements',
  'Configure webhook authentication',
  'Generate URL and credentials',
] as const;
// Tasks/paths advertised in the Workshop Guide that have NO wired control yet (chat-assisted drafting,
// Knowledge instructions/memories management, the IAM secondary-cloud-source wizard). Everything else
// the guide shows (Form creation, skill upload/import, webhook credential generation, enable/disable,
// Agent Space editing) is a real, wired flow — see the cards below for what backs each one.
const ROADMAP_TASKS = new Set([
  'Chat', 'Create skill with Chat', 'Instructions', 'Memories',
  'Configure secondary cloud source', 'Connect to Agent',
]);
function RoadmapBadge() {
  return <span className="ml-1 rounded bg-ink-100 px-1 py-0.5 text-[9px] font-medium text-ink-500">로드맵 · 미구현</span>;
}
const SKILL_TEMPLATE = `---
name: rds-performance-investigation
description: RDS 성능 이슈, 연결 고갈, 슬로우 쿼리, 복제 지연 조사 절차
---

# RDS Performance Investigation

## 1. 알람과 영향 범위
- DatabaseConnections, ReadLatency, WriteLatency, FreeStorageSpace 확인
- 영향 받은 DB, 애플리케이션, 시간 범위 기록

## 2. 근거 수집
- 지난 1시간 연결 수와 max_connections 근접 여부 확인
- Performance Insights에서 상위 SQL과 wait event 확인
- 최근 배포, 파라미터 변경, 스케일 이벤트 대조

## 3. 출력 형식
1. 현재 상태: healthy / degraded / critical
2. 근본 원인 가설과 메트릭 근거
3. 우선순위별 remediation proposal`;
// ADR-039 P2 — integration kinds (mirror web/lib/integration-validation.ts).
const INTEG_KINDS_EGRESS = ['grafana', 'datadog', 'splunk', 'prometheus', 'newrelic', 'notion', 'confluence', 'jira', 'servicenow', 'slack', 'github', 'gitlab', 'custom_mcp'];
const INTEG_KINDS_INGRESS = ['cloudwatch_sns', 'alertmanager', 'grafana_alert', 'pagerduty', 'datadog_monitor', 'generic_webhook'];
const INTEG_TRANSPORTS = ['sigv4', 'oauth_client_credentials', 'oauth_3lo', 'api_key'];
// NOTE: curated read connectors (Prometheus/Loki/…/Notion credential cards) moved to the Integrations
// hub (/integrations) — Datasources tab + Connectors tab. This page keeps Agents/Skills/Agent-Space +
// the advanced custom-integration registration.

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
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [integForm, setIntegForm] = useState({ direction: 'egress', name: '', kind: 'grafana', endpoint: '', transport: 'api_key', capability: 'read', authMode: 'hmac', sourceAllowlist: '', triggerTarget: 'incident' });
  // Phase 2 (W4) — one-time credential reveal per generic_webhook ingress row + the "I've saved my
  // credentials" gate before Enable is clickable (mirrors the reference console's Generate-URL step).
  const [revealedCred, setRevealedCred] = useState<Record<number, { receivePath: string; authMode: string; secret: string }>>({});
  const [savedAck, setSavedAck] = useState<Record<number, boolean>>({});
  const [githubUrl, setGithubUrl] = useState('');

  async function load() {
    const r = await fetch('/api/customization');
    if (r.status === 401 || r.status === 403) { setDenied(true); return; }
    if (r.status === 400) { setNoAurora(true); return; }
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
    if (ir.ok) setIntegrations((await ir.json()).integrations || []);
  }

  async function createIntegration() {
    const isEgress = integForm.direction === 'egress';
    const body = isEgress
      ? { name: integForm.name, kind: integForm.kind, direction: 'egress', endpoint: integForm.endpoint, transport: integForm.transport, capability: integForm.capability }
      : { name: integForm.name, kind: integForm.kind, direction: 'ingress', authMode: integForm.authMode, triggerTarget: integForm.triggerTarget, sourceAllowlist: integForm.sourceAllowlist.split(',').map((s) => s.trim()).filter(Boolean) };
    const res = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json();
    setMsg(res.ok ? `Created integration #${d.id} — disabled${d.receivePath ? `; receive URL: ${d.receivePath}` : ''}` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function toggleIntegration(id: number, enabled: boolean) {
    await fetch('/api/integrations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: enabled ? 'disable' : 'enable', id }) });
    load();
  }
  async function generateCredential(id: number) {
    const res = await fetch('/api/integrations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'generate-credential', id }) });
    const d = await res.json();
    if (!res.ok) { setMsg(`Error: ${JSON.stringify(d.error)}`); return; }
    setRevealedCred({ ...revealedCred, [id]: { receivePath: d.receivePath, authMode: d.authMode, secret: d.secret } });
    setSavedAck({ ...savedAck, [id]: false }); // regenerating resets the ack — must re-confirm before Enable
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
  async function uploadSkillZip(file: File) {
    const res = await fetch('/api/customization/skills/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: await file.arrayBuffer() });
    const d = await res.json();
    setMsg(res.ok ? `Imported skill #${d.id} from zip (${d.referenceFileCount} reference file(s)) — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function importSkillFromGithub() {
    const res = await fetch('/api/customization/skills/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'github', url: githubUrl }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Imported skill #${d.id} from repository (${d.referenceFileCount} reference file(s)) — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) { setGithubUrl(''); load(); }
  }
  async function toggle(kind: 'agent' | 'skill', id: number, enabled: boolean) {
    await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: enabled ? 'disable' : 'enable', kind, id }),
    });
    load();
  }
  async function removeItem(kind: 'agent' | 'skill', id: number, name: string) {
    if (!window.confirm(`Delete ${kind} "${name}"? This cannot be undone.`)) return;
    const res = await fetch('/api/customization', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, id }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Deleted ${kind} #${id}` : `Error: ${JSON.stringify(d.error)}`);
    if (res.ok) load();
  }
  async function removeIntegration(id: number, name: string) {
    if (!window.confirm(`Delete integration "${name}"? This cannot be undone.`)) return;
    const res = await fetch('/api/integrations', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Deleted integration #${id}` : `Error: ${JSON.stringify(d.error)}`);
    if (res.ok) load();
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
  function toggleSpaceSkill(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledSkillIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledSkillIds: [...set] });
  }

  if (denied) return <div className="p-6 text-[13px] text-ink-500">Admin access required (ADR-031).</div>;
  if (noAurora) return <div className="p-6 text-[13px] text-ink-500">Aurora is not configured — custom agents are unavailable.</div>;

  return (
    <div className="text-ink-800">
      <PageHeader title="Custom Agents & Skills" />
      <div className="space-y-6 p-6">
      {msg && <div className="text-[12px] text-brand-600">{msg}</div>}

      <section className="space-y-5 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold">DevOps Agent Workshop Guide</h2>
          <p className="max-w-5xl text-[12px] leading-5 text-ink-500">
            Customization은 Agent Space에 들어갈 조사 절차(Skill), 조사 페르소나(Agent), 외부 읽기 데이터 소스를 준비하는 곳입니다.
            현재 v2 동작 범위는 read-only 진단과 remediation proposal이며, AWS 리소스 변경이나 자율 실행은 활성화하지 않습니다.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="rounded-md border border-ink-100 bg-paper p-4">
            <h3 className="text-[13px] font-semibold">Workshop flow</h3>
            <ol className="mt-4 space-y-4">
              {WORKSHOP_STEPS.map((step, idx) => (
                <li key={step.title} className="relative grid grid-cols-[28px_minmax(0,1fr)] gap-2">
                  {idx < WORKSHOP_STEPS.length - 1 && <span className="absolute left-[11px] top-7 h-[calc(100%+8px)] w-px bg-ink-100" aria-hidden="true" />}
                  <span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full border border-brand-300 bg-paper text-[11px] font-semibold text-brand-600">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="text-[12px] font-semibold text-ink-800">{step.title}</div>
                    <p className="text-[11px] leading-4 text-ink-500">{step.body}</p>
                    <div className="flex flex-wrap gap-1">
                      {step.tasks.map((task) => (
                        <span key={task} className={`rounded border border-ink-100 bg-paper-muted px-1.5 py-0.5 text-[10px] text-ink-500 ${ROADMAP_TASKS.has(task) ? 'opacity-60' : ''}`}>
                          {task}{ROADMAP_TASKS.has(task) && <span aria-hidden="true"> 🔜</span>}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </aside>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3 rounded-md border border-ink-100 bg-paper p-4">
              <h3 className="text-[13px] font-semibold">Agent 등록 방식</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {AGENT_PATHS.map(([title, body]) => (
                  <div key={title} className={`rounded-md border border-ink-100 bg-paper-muted/60 p-3 ${ROADMAP_TASKS.has(title) ? 'opacity-60' : ''}`}>
                    <div className="text-[12px] font-semibold text-ink-800">{title}{ROADMAP_TASKS.has(title) && <RoadmapBadge />}</div>
                    <p className="mt-1 text-[11px] leading-4 text-ink-500">{body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-ink-100 bg-paper p-4">
              <h3 className="text-[13px] font-semibold">Skill 등록 방식</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {SKILL_PATHS.map(([title, body]) => (
                  <div key={title} className={`rounded-md border border-ink-100 bg-paper-muted/60 p-3 ${ROADMAP_TASKS.has(title) ? 'opacity-60' : ''}`}>
                    <div className="text-[12px] font-semibold text-ink-800">{title}{ROADMAP_TASKS.has(title) && <RoadmapBadge />}</div>
                    <p className="mt-1 text-[11px] leading-4 text-ink-500">{body}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-ink-100 bg-paper p-4">
              <h3 className="text-[13px] font-semibold">Configure Agent Space Webhook</h3>
              <ol className="space-y-2 text-[12px] leading-5 text-ink-500">
                {WEBHOOK_STEPS.map((step, idx) => (
                  <li key={step} className="flex gap-2">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[10px] font-semibold text-brand-600">{idx + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <pre className="max-h-[220px] overflow-auto rounded-md bg-ink-900 p-3 text-[11px] leading-5 text-white">
                {WEBHOOK_SCHEMA}
              </pre>
              <p className="text-[11px] leading-4 text-ink-400">
                Generic webhook contract (normalized by the ingress route). Incident ingress is
                gated by <code>INCIDENT_LIFECYCLE_ENABLED</code> and is off by default.
              </p>
              <p className="text-[11px] leading-4 text-ink-500">
                이 3단계는 아래 <b>Integrations (advanced)</b> 섹션에서 <code>generic_webhook</code> ingress
                integration을 등록하면 실제로 동작합니다 — HMAC 또는 API Key 인증 방식을 고르고 등록한 뒤,
                해당 행에서 <b>Generate URL and credentials</b>로 URL과 시크릿을 1회 발급받습니다.
              </p>
            </div>

            <div className="space-y-3 rounded-md border border-ink-100 bg-paper p-4">
              <h3 className="text-[13px] font-semibold">Knowledge assets</h3>
              <div className="space-y-2">
                {KNOWLEDGE_ASSETS.map(([title, body]) => (
                  <div key={title} className={`rounded-md border border-ink-100 bg-paper-muted/60 p-3 ${ROADMAP_TASKS.has(title) ? 'opacity-60' : ''}`}>
                    <div className="text-[12px] font-semibold text-ink-800">{title}{ROADMAP_TASKS.has(title) && <RoadmapBadge />}</div>
                    <p className="mt-1 text-[11px] leading-4 text-ink-500">{body}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] leading-4 text-ink-500">
                외부 observability는 <a href="/integrations" className="text-brand-600 underline">Integrations hub</a>에서 먼저 연결한 뒤,
                Agent Space에서 필요한 read-only 도구만 허용합니다.
              </p>
            </div>
          </div>
        </div>

        <details className="rounded-md border border-ink-100 bg-paper p-3">
          <summary className="cursor-pointer text-[12px] font-medium text-ink-700">SKILL.md inline 예시 보기</summary>
          <pre className="mt-3 max-h-[320px] overflow-auto rounded-md bg-ink-900 p-3 text-[11px] leading-5 text-white">
            {SKILL_TEMPLATE}
          </pre>
        </details>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Agent</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description" value={agentForm.description} onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })} />
        <textarea className="min-h-[220px] w-full resize-y rounded border border-ink-100 bg-paper px-2 py-1 text-[12px] leading-5" rows={9} placeholder="persona (system prompt)" value={agentForm.persona} onChange={(e) => setAgentForm({ ...agentForm, persona: e.target.value })} />
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
        <button onClick={createAgent} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create</button>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Skill</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description (≥100 chars recommended — describes when to use)" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
        <textarea className="min-h-[360px] w-full resize-y rounded border border-ink-100 bg-paper px-2 py-1 font-mono text-[12px] leading-5" rows={16} placeholder="instructions (Markdown)" value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} />
        <div className="text-[11px] text-ink-500">
          <span className="mr-2">agent types (targeting)</span>
          {AGENT_TYPES.map((t) => (
            <label key={t} className="mr-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={skillForm.agentTypes.includes(t)} onChange={() => setSkillForm({ ...skillForm, agentTypes: toggleInArray(skillForm.agentTypes, t) })} />
              {t}
            </label>
          ))}
        </div>
        <button onClick={createSkill} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create Skill</button>

        <div className="mt-3 grid gap-3 border-t border-ink-100 pt-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-ink-700">
              Upload skill (.zip with SKILL.md + references/)
              <input type="file" accept=".zip,application/zip" className="mt-1 block w-full text-[12px]"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSkillZip(f); e.target.value = ''; }} />
            </label>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-ink-700">Import from repository (GitHub directory URL)</label>
            <div className="flex gap-2">
              <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]"
                placeholder="https://github.com/org/repo/tree/main/skills/my-skill"
                value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} />
              <button onClick={importSkillFromGithub} disabled={!githubUrl.trim()} className="rounded border border-ink-200 px-3 py-1 text-[12px] font-medium disabled:opacity-50">Import</button>
            </div>
          </div>
        </div>
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
              ? <span className="flex gap-2">
                  <button onClick={() => toggle('agent', a.id, a.enabled)} className={`rounded border px-2 py-1 text-[12px] ${a.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{a.enabled ? 'Enabled' : 'Disabled'}</button>
                  <button onClick={() => removeItem('agent', a.id, a.name)} className="rounded border border-red-200 px-2 py-1 text-[12px] text-red-500">Delete</button>
                </span>
              : <span className="text-ink-400">built-in</span>}
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Skills</h2>
        {skills.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div><span className="font-semibold">{s.name}</span> <span className="text-ink-400">({s.tier}, v{s.version}{s.agentTypes && s.agentTypes.length ? `, ${s.agentTypes.join('/')}` : ''})</span><div className="text-ink-500">{s.description}</div></div>
            {s.tier === 'custom' && (
              <span className="flex gap-2">
                <button onClick={() => toggle('skill', s.id, s.enabled)} className={`rounded border px-2 py-1 text-[12px] ${s.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{s.enabled ? 'Enabled' : 'Disabled'}</button>
                <button onClick={() => removeItem('skill', s.id, s.name)} className="rounded border border-red-200 px-2 py-1 text-[12px] text-red-500">Delete</button>
              </span>
            )}
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <div>
          <h2 className="text-[13px] font-semibold">Integrations (advanced)</h2>
          <p className="text-[11px] text-ink-400">
            데이터소스(Prometheus·Loki·…)와 커넥터(Notion)는 이제 <a href="/integrations" className="text-brand-600 underline">연동 허브</a>에서 관리합니다.
            아래는 고급 — 임의 egress/ingress 통합 등록입니다.
          </p>
        </div>

        <details className="mt-2 border-t border-ink-100 pt-2">
          <summary className="cursor-pointer text-[12px] text-ink-500">Advanced — register a custom integration</summary>
          <div className="mt-2 space-y-2">
            <div className="flex gap-2 text-[12px]">
              {['egress', 'ingress'].map((d) => (
                <button key={d} onClick={() => setIntegForm({ ...integForm, direction: d, kind: d === 'egress' ? 'grafana' : 'pagerduty' })}
                  className={`rounded border px-2 py-1 ${integForm.direction === d ? 'border-brand-500 text-brand-600' : 'border-ink-100 text-ink-400'}`}>{d}</button>
              ))}
            </div>
            <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={integForm.name} onChange={(e) => setIntegForm({ ...integForm, name: e.target.value })} />
            <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.kind} onChange={(e) => setIntegForm({ ...integForm, kind: e.target.value })}>
              {(integForm.direction === 'egress' ? INTEG_KINDS_EGRESS : INTEG_KINDS_INGRESS).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {integForm.direction === 'egress' ? (
              <div className="flex flex-wrap items-center gap-2">
                <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="https endpoint" value={integForm.endpoint} onChange={(e) => setIntegForm({ ...integForm, endpoint: e.target.value })} />
                <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.transport} onChange={(e) => setIntegForm({ ...integForm, transport: e.target.value })}>
                  {INTEG_TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.capability} onChange={(e) => setIntegForm({ ...integForm, capability: e.target.value })}>
                  <option value="read">read</option><option value="read_write">read_write</option>
                </select>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {integForm.kind === 'generic_webhook' ? (
                  <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.authMode} onChange={(e) => setIntegForm({ ...integForm, authMode: e.target.value })}>
                    <option value="hmac">hmac</option>
                    <option value="api_key">api_key</option>
                  </select>
                ) : (
                  <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="auth mode (e.g. vendor_sig)" value={integForm.authMode} onChange={(e) => setIntegForm({ ...integForm, authMode: e.target.value })} />
                )}
                <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="source allowlist (comma IPs)" value={integForm.sourceAllowlist} onChange={(e) => setIntegForm({ ...integForm, sourceAllowlist: e.target.value })} />
                <span className="text-[11px] text-ink-400">trigger: incident (receive URL generated on create)</span>
              </div>
            )}
            <button onClick={createIntegration} className="rounded border border-ink-200 px-3 py-1 text-[12px] font-medium">Register integration</button>
            {integrations.map((i) => {
              const isGenericWebhook = i.direction === 'ingress' && i.kind === 'generic_webhook' && i.tier === 'custom';
              const cred = revealedCred[i.id];
              const enableBlocked = isGenericWebhook && !i.enabled && !savedAck[i.id];
              return (
                <div key={i.id} className="rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-semibold">{i.name}</span>{' '}
                      <span className="text-ink-400">({i.tier}, {i.direction}, {i.kind}, {i.capability})</span>
                      {i.direction === 'ingress' && i.receivePath && <div className="text-ink-500">{i.receivePath}</div>}
                    </div>
                    {i.tier === 'custom'
                      ? <span className="flex gap-2">
                          {isGenericWebhook && (
                            <button onClick={() => generateCredential(i.id)} className="rounded border border-ink-200 px-2 py-1 text-[12px]">Generate URL and credentials</button>
                          )}
                          <button onClick={() => toggleIntegration(i.id, i.enabled)} disabled={enableBlocked}
                            title={enableBlocked ? "Generate credentials and confirm you've saved them before enabling" : undefined}
                            className={`rounded border px-2 py-1 text-[12px] ${i.enabled ? 'border-emerald-300 text-emerald-600' : enableBlocked ? 'cursor-not-allowed border-ink-100 text-ink-300' : 'border-ink-100 text-ink-400'}`}>
                            {i.enabled ? 'Enabled' : 'Disabled'}
                          </button>
                          <button onClick={() => removeIntegration(i.id, i.name)} className="rounded border border-red-200 px-2 py-1 text-[12px] text-red-500">Delete</button>
                        </span>
                      : <span className="text-ink-400">built-in</span>}
                  </div>
                  {cred && (
                    <div className="mt-2 space-y-1 rounded border border-amber-200 bg-amber-50 p-2">
                      <div className="text-[11px] font-medium text-amber-800">
                        Save this now — it will not be shown again. Regenerating replaces it.
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="break-all rounded bg-white px-1.5 py-0.5 text-[11px]">{cred.receivePath}</code>
                        <button onClick={() => navigator.clipboard.writeText(cred.receivePath)} className="text-[11px] text-brand-600 underline">copy</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-ink-500">{cred.authMode}:</span>
                        <code className="break-all rounded bg-white px-1.5 py-0.5 text-[11px]">{cred.secret}</code>
                        <button onClick={() => navigator.clipboard.writeText(cred.secret)} className="text-[11px] text-brand-600 underline">copy</button>
                      </div>
                      <label className="flex items-center gap-1 text-[11px] text-amber-800">
                        <input type="checkbox" checked={!!savedAck[i.id]} onChange={(e) => setSavedAck({ ...savedAck, [i.id]: e.target.checked })} />
                        I&apos;ve saved and stored my URL and credentials
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
            {integrations.length === 0 && <span className="text-[12px] text-ink-400">no custom integrations yet</span>}
          </div>
        </details>
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
          <div className="mb-1 font-medium">Enabled skills (account-scoped, cap-only — empty = no cap)</div>
          {skills.filter((s) => s.tier === 'custom').map((s) => (
            <label key={s.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledSkillIds.includes(s.id)} onChange={() => toggleSpaceSkill(s.id)} />
              {s.name}
            </label>
          ))}
          {skills.filter((s) => s.tier === 'custom').length === 0 && <span className="text-ink-400">no custom skills yet</span>}
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
