'use client';
import { useRef, useState } from 'react';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';
import { useI18n } from '@/components/shell/LanguageProvider';
import { DATASOURCE_KINDS } from '@/lib/integrations-category';

// v1-parity Add/Edit form: multiple instances per type, a name, an explicit auth method (optional auth),
// and a Test-before-save probe. POSTs (create) / PATCHes (update) /api/datasources/manage.
const AUTH_TYPES = [
  { value: 'none', label: 'None (인증 없음)' },
  { value: 'basic', label: 'Basic (사용자/비밀번호)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'custom_header', label: 'Custom header' },
] as const;
const ORG_ID_KINDS = new Set(['loki', 'tempo', 'mimir']); // X-Scope-OrgID multi-tenancy
// Per-kind endpoint placeholder (SaaS kinds get their real API base as the hint).
const ENDPOINT_PH: Record<string, string> = {
  prometheus: 'http://prometheus.internal:9090', mimir: 'http://mimir.internal:9009',
  loki: 'http://loki.internal:3100', tempo: 'http://tempo.internal:3200',
  clickhouse: 'http://clickhouse.internal:8123', jaeger: 'http://jaeger-query.internal:16686',
  dynatrace: 'https://{env}.live.dynatrace.com', datadog: 'https://api.datadoghq.com',
};
// Auth hints: Dynatrace uses an API token (Authorization: Api-Token — pick Bearer/token here);
// Datadog needs the DD-API-KEY + DD-APPLICATION-KEY custom-header PAIR.
const AUTH_HINT: Record<string, string> = {
  dynatrace: 'Dynatrace API token을 입력하세요. 메트릭에는 metrics.read, 문제 조회에는 problems.read 권한이 필요합니다.',
  datadog: 'Datadog 사이트에 맞는 API key와 메트릭 조회 권한이 있는 Application key를 함께 입력하세요.',
};
const labelCls = 'block text-[11px] uppercase tracking-wide text-ink-400 mb-1';
const selectCls = 'w-full rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

export interface DatasourceFormValue {
  id?: number;
  name: string;
  kind: string;
  endpoint: string;
  authType: string;
  isDefault?: boolean;
  // gap L203: per-datasource connection settings (server-side sanitized; see lib/datasources.ts)
  settings?: { timeoutS?: number; database?: string };
}

export default function DatasourceForm({
  initial, onSaved, onCancel,
}: { initial?: DatasourceFormValue; onSaved: () => void; onCancel: () => void }) {
  const { tt } = useI18n();
  const editing = Boolean(initial?.id);
  const [kind, setKind] = useState(initial?.kind ?? 'prometheus');
  const [name, setName] = useState(initial?.name ?? '');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [authType, setAuthType] = useState(initial?.authType ?? (editing ? '' : 'none'));
  const [creds, setCreds] = useState<Record<string, string>>({});
  // gap L203: settings kept as strings for the inputs; settingsPayload() validates/coerces
  const [timeoutS, setTimeoutS] = useState(initial?.settings?.timeoutS != null ? String(initial.settings.timeoutS) : '');
  const [database, setDatabase] = useState(initial?.settings?.database ?? '');
  const [test, setTest] = useState<{ ok: boolean; ms?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const revision = useRef(0);

  const invalidateTest = () => { revision.current += 1; setTest(null); setErr(''); };
  const setCred = (k: string, v: string) => { invalidateTest(); setCreds((c) => ({ ...c, [k]: v })); };
  const changeKind = (value: string) => {
    invalidateTest();
    setKind(value);
    setEndpoint('');
    setDatabase('');
    setAuthType(value === 'datadog' ? 'custom_header' : value === 'dynatrace' ? 'bearer' : 'none');
    setCreds(value === 'datadog' ? { headerName: 'DD-API-KEY', headerName2: 'DD-APPLICATION-KEY' } : {});
  };
  const credPayload = () => {
    const c: Record<string, string> = {};
    if (authType === 'basic') { if (creds.username) c.username = creds.username; if (creds.password) c.password = creds.password; }
    if (authType === 'bearer' && creds.token) c.token = creds.token;
    if (authType === 'custom_header') {
      if (kind === 'datadog') {
        if (creds.headerValue) { c.headerName = 'DD-API-KEY'; c.headerValue = creds.headerValue; }
        if (creds.headerValue2) { c.headerName2 = 'DD-APPLICATION-KEY'; c.headerValue2 = creds.headerValue2; }
      } else {
        if (creds.headerName) c.headerName = creds.headerName;
        if (creds.headerValue) c.headerValue = creds.headerValue;
        if (creds.headerName2) c.headerName2 = creds.headerName2;
        if (creds.headerValue2) c.headerValue2 = creds.headerValue2;
      }
    }
    if (ORG_ID_KINDS.has(kind) && creds.org_id) c.org_id = creds.org_id;
    return c;
  };
  // An empty field clears; an OUT-OF-RANGE value is a visible validation error (round-3:
  // a typo like 999 silently clearing the stored setting is surprising — fail loud instead).
  const timeoutInvalid = timeoutS.trim() !== ''
    && !(Number.isInteger(Number(timeoutS)) && Number(timeoutS) >= 1 && Number(timeoutS) <= 60);
  const dbTrim = database.trim();
  const databaseInvalid = kind === 'clickhouse' && dbTrim !== ''
    && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbTrim) || dbTrim.length > 128
        || ['system', 'information_schema'].includes(dbTrim.toLowerCase()));
  const settingsPayload = () => {
    const out: { timeoutS?: number; database?: string } = {};
    const t = Number(timeoutS);
    if (timeoutS.trim() !== '' && Number.isInteger(t) && t >= 1 && t <= 60) out.timeoutS = t;
    if (kind === 'clickhouse' && database.trim()) out.database = database.trim();
    return out;
  };

  const runTest = async () => {
    const testedRevision = revision.current;
    setTesting(true); setTest(null); setErr('');
    try {
      const r = await fetch('/api/datasources/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: initial?.id, kind, endpoint, authType, creds: credPayload(), settings: settingsPayload() }),
      });
      const b = await r.json();
      if (revision.current !== testedRevision) return;
      if (!r.ok) { setErr(b.error || tt(`오류 ${r.status}`)); return; }
      setTest({ ok: Boolean(b.ok), ms: b.latencyMs, error: b.error });
    } catch { if (revision.current === testedRevision) setErr(tt('테스트 실패')); }
    finally { setTesting(false); }
  };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const body = editing
        ? { id: initial!.id, name, endpoint, authType, creds: credPayload(), settings: settingsPayload() }
        : { name, kind, endpoint, authType, creds: credPayload(), settings: settingsPayload() };
      const r = await fetch('/api/datasources/manage', {
        method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(b.error || tt(`저장 실패 (${r.status})`)); return; }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : tt('저장 실패')); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3" role="dialog" aria-label={editing ? tt('데이터소스 편집') : tt('데이터소스 추가')}>
      <h3 className="text-sm font-semibold text-ink-800">{editing ? tt('데이터소스 편집') : tt('데이터소스 추가')}</h3>

      <div>
        <label className={labelCls}>Type</label>
        <div className="flex items-center gap-2">
          <IntegrationIcon kind={kind} size={20} />
          <select className={selectCls} value={kind} disabled={editing || saving} onChange={(e) => changeKind(e.target.value)} aria-label="Type">
            {DATASOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>Name</label>
        <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={tt('예: prod-prometheus')} />
      </div>

      <div>
        <label className={labelCls}>Endpoint URL</label>
        <Input aria-label="Endpoint URL" value={endpoint} onChange={(e) => { invalidateTest(); setEndpoint(e.target.value); }} placeholder={ENDPOINT_PH[kind] ?? 'http://prometheus.internal:9090'} />
      </div>

      <div>
        <label className={labelCls}>Auth method</label>
        <select className={selectCls} value={authType} onChange={(e) => { invalidateTest(); setAuthType(e.target.value); setCreds(current => ({ org_id: current.org_id ?? '' })); }} aria-label="Auth method">
          {!authType && <option value="">{tt('인증 방식을 선택하세요')}</option>}
          {AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{kind === 'dynatrace' && a.value === 'bearer' ? 'Dynatrace API token' : kind === 'datadog' && a.value === 'custom_header' ? 'Datadog API + Application keys' : tt(a.label)}</option>)}
        </select>
      </div>

      {authType === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <div><label className={labelCls}>Username</label><Input value={creds.username ?? ''} onChange={(e) => setCred('username', e.target.value)} /></div>
          <div><label className={labelCls}>{tt('Password (선택)')}</label><Input type="password" value={creds.password ?? ''} onChange={(e) => setCred('password', e.target.value)} /></div>
        </div>
      )}
      {authType === 'bearer' && (
        <div><label className={labelCls}>Token</label><Input type="password" value={creds.token ?? ''} onChange={(e) => setCred('token', e.target.value)} /></div>
      )}
      {authType === 'custom_header' && kind === 'datadog' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div><label className={labelCls}>API key</label><Input aria-label="API key" type="password" value={creds.headerValue ?? ''} onChange={e => setCred('headerValue', e.target.value)} /></div>
          <div><label className={labelCls}>Application key</label><Input aria-label="Application key" type="password" value={creds.headerValue2 ?? ''} onChange={e => setCred('headerValue2', e.target.value)} /></div>
        </div>
      )}
      {authType === 'custom_header' && kind !== 'datadog' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>Header name</label><Input value={creds.headerName ?? ''} onChange={(e) => setCred('headerName', e.target.value)} placeholder={kind === 'datadog' ? 'DD-API-KEY' : 'X-API-Key'} /></div>
            <div><label className={labelCls}>Header value</label><Input type="password" value={creds.headerValue ?? ''} onChange={(e) => setCred('headerValue', e.target.value)} /></div>
          </div>
          {/* Optional SECOND header — Datadog auth is a DD-API-KEY + DD-APPLICATION-KEY pair. */}
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>{tt('Header name 2 (선택)')}</label><Input value={creds.headerName2 ?? ''} onChange={(e) => setCred('headerName2', e.target.value)} placeholder={kind === 'datadog' ? 'DD-APPLICATION-KEY' : ''} /></div>
            <div><label className={labelCls}>{tt('Header value 2 (선택)')}</label><Input type="password" value={creds.headerValue2 ?? ''} onChange={(e) => setCred('headerValue2', e.target.value)} /></div>
          </div>
        </>
      )}
      {AUTH_HINT[kind] && <p className="text-[12px] text-ink-400">{tt(AUTH_HINT[kind])}</p>}
      {editing && <p className="text-[12px] text-ink-500">{tt('기존 자격증명은 표시하지 않습니다. 같은 엔드포인트에서는 빈 인증 필드를 유지하면 저장된 값을 사용합니다. 주소를 바꾸면 자격증명을 다시 입력하세요.')}</p>}
      {ORG_ID_KINDS.has(kind) && (
        <div><label className={labelCls}>{tt('Org ID (X-Scope-OrgID, 선택)')}</label><Input value={creds.org_id ?? ''} onChange={(e) => setCred('org_id', e.target.value)} /></div>
      )}

      {/* gap L203: per-datasource connection settings (v1 Settings section parity — v1's
          result-cache TTL is deliberately not ported: the v2 query path is uncached by design) */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>{tt('Timeout (초, 1–60 · 선택)')}</label>
          <Input value={timeoutS} onChange={(e) => { invalidateTest(); setTimeoutS(e.target.value); }} placeholder={tt('기본 10')} inputMode="numeric" />
          {timeoutInvalid && <p className="mt-1 text-[11px] text-rose-600">{tt('1–60 사이의 정수를 입력하세요.')}</p>}
        </div>
        {kind === 'clickhouse' && (
          <div>
            <label className={labelCls}>{tt('Database (선택)')}</label>
            <Input value={database} onChange={(e) => { invalidateTest(); setDatabase(e.target.value); }} placeholder="default" />
            {databaseInvalid && <p className="mt-1 text-[11px] text-rose-600">{tt('영문/숫자/밑줄 식별자만 가능하며 system 계열은 사용할 수 없습니다.')}</p>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" onClick={runTest} disabled={testing || saving || !authType || !endpoint.trim() || timeoutInvalid || databaseInvalid}>
          {testing ? tt('테스트 중…') : `🧪 ${tt('연결 테스트')}`}
        </Button>
        {test && (
          <span className={`text-[13px] ${test.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
            {test.ok ? `${tt('✓ 연결 성공')}${test.ms != null ? ` (${test.ms}ms)` : ''}` : `${tt('✗ 연결 실패:')} ${test.error ?? tt('오류')}`}
          </span>
        )}
      </div>

      {err && <p className="text-[13px] text-rose-600">{err}</p>}

      <div className="flex gap-2 pt-1">
        <Button onClick={save} disabled={saving || testing || !authType || !name.trim() || !endpoint.trim() || timeoutInvalid || databaseInvalid}>{saving ? tt('저장 중…') : tt('저장')}</Button>
        <Button variant="secondary" onClick={onCancel}>{tt('취소')}</Button>
      </div>
    </div>
  );
}
