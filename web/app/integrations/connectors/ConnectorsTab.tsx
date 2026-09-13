'use client';
import { useCallback, useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';
import { useI18n } from '@/components/shell/LanguageProvider';
import { MCP_PRESETS } from '@/lib/mcp-presets';
import Link from 'next/link';

// Connectors tab: external SERVICE integrations — distinct from observability Datasources and from
// Skills. Read + GOVERNED write (write is propose-only / flag-OFF per ADR-040/041 — surfaced as a
// disabled note here). ADR-017 — the catalog is curated official-vendor MCP presets (Datadog/
// ClickHouse/Tempo/Jaeger/Grafana/Dynatrace/Splunk/New Relic) plus Notion (pre-existing, hosted MCP
// is OAuth-only so it stays on the direct token path). Connect = paste one token; the same PUT
// writes it to the shared credentials secret provision.py reads for the ADR-017 gateway targets.
const CONNECTORS = MCP_PRESETS;

export default function ConnectorsTab({ canManage = false, onShowDatasources }: { canManage?: boolean; onShowDatasources?: () => void }) {
  const { tt } = useI18n();
  // Two distinct sets (round-2 review MAJOR, 2026-07-31): `configured` = plain-slug
  // datasource-mirror credentials; `mcpConfigured` = ADR-017 namespaced "mcp:<slug>" credentials,
  // the ONLY key provision.py reads for official-MCP presets. A preset row must check the one
  // that actually matters for its activation path — merging them made the UI lie either way.
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [mcpConfigured, setMcpConfigured] = useState<Set<string>>(new Set());
  const [token, setToken] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'unknown'>(canManage ? 'loading' : 'unknown');
  const [saveError, setSaveError] = useState(false);
  const [notionTest, setNotionTest] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      const r = await fetch('/api/integrations/credential');
      const body = await r.json();
      if (!r.ok || body.available === false) throw new Error('unavailable');
      setConfigured(new Set((body.configured ?? []) as string[]));
      setMcpConfigured(new Set((body.mcpConfigured ?? []) as string[]));
      setLoadState('ready');
    } catch { setLoadState('unknown'); }
  }, [canManage]);
  useEffect(() => { load(); }, [load]);

  // A preset row's activation credential lives under the namespaced key when it's an official
  // MCP preset (provision.py reads mcp:<slug> exclusively), else the plain slug (legacy connectors).
  const isConfigured = (c: { slug: string; official: boolean }) =>
    (c.official ? mcpConfigured : configured).has(c.slug);

  const connect = async (slug: string, official: boolean) => {
    const t = (token[slug] ?? '').trim();
    if (!t) return;
    setBusy(slug); setMsg(''); setSaveError(false);
    if (slug === 'notion') setNotionTest(null);
    try {
      const r = await fetch('/api/integrations/credential', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        // official=true (all ADR-017 presets except Notion) stores under the namespaced "mcp:"
        // key so it can never clobber the plain-slug datasource-connector kind-mirror that 5 of
        // these slugs (clickhouse/tempo/jaeger/dynatrace/datadog) also own.
        body: JSON.stringify({ slug, secret: { token: t }, official }),
      });
      if (!r.ok) throw new Error('save failed');
      setToken((s) => ({ ...s, [slug]: '' })); // never keep the secret in state
      setMsg(tt('저장되었습니다.'));
      await load();
    } catch { setSaveError(true); setMsg(tt('자격증명을 저장하지 못했습니다. 관리자 권한과 연결 상태를 확인하고 다시 시도하세요.')); }
    finally { setBusy(null); }
  };
  const testNotion = async () => {
    setBusy('notion'); setNotionTest(null);
    try {
      const response = await fetch('/api/integrations/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'notion' }),
      });
      setNotionTest(response.ok && (await response.json()).ok === true);
    } catch { setNotionTest(false); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-500">
        {tt('외부 서비스 커넥터 (Notion 등). 자격증명은 Secrets Manager에 암호화 저장되며 다시 표시되지 않습니다.')}{' '}
        {tt('쓰기(노트/티켓 생성)는 거버넌스 하에 제안 전용 · 기본 비활성입니다.')}{' '}
        {tt('ClickHouse·Prometheus·Loki·Tempo·Mimir·Jaeger 등 관측성 데이터소스는 Datasources 탭에서 등록합니다(엔드포인트+자격증명).')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {CONNECTORS.map((c) => (
          <Card key={c.slug} className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 font-medium text-ink-800"><IntegrationIcon kind={c.slug} /> {c.label}</span>
              <span className={`text-[12px] ${isConfigured(c) ? 'text-emerald-600' : 'text-ink-400'}`}>
                {!canManage ? tt('상태 확인은 관리자 전용')
                  : loadState === 'loading' ? tt('불러오는 중…')
                  : loadState === 'unknown' ? tt('상태 확인 불가')
                  : isConfigured(c) ? tt('● 자격증명 저장됨') : tt('○ 자격증명 없음')}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {c.official && <span className="inline-block text-[11px] text-sky-700 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5">{tt('공식 MCP (hosted)')}</span>}
              {c.official && <span className="inline-block text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tt('게이트됨 — 토큰 사전 등록만')}</span>}
              {c.preview && <span className="inline-block text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tt('벤더 preview')}</span>}
            </div>
            <p className="text-[12px] text-ink-400">
              {tt(c.help)}{' '}
              <a href={c.docsUrl} target="_blank" rel="noreferrer" className="underline">{tt('문서')}</a>
            </p>
            {c.official && (
              <p className="text-[11px] text-ink-400">
                {tt('실제 활성화는 official_mcp_enabled 플래그와 이 프리셋의 엔드포인트 설정(terraform)이 추가로 필요합니다.')}
              </p>
            )}
            {['datadog', 'dynatrace'].includes(c.slug) && (
              <Link href="/integrations?tab=datasources" onClick={event => {
                if (onShowDatasources && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault(); onShowDatasources();
                }
              }} className="block text-[12px] text-brand-600 hover:underline">{tt('메트릭 조회용 API 연결은 Datasources에서 등록 →')}</Link>
            )}
            {c.slug === 'dynatrace' && (
              <p className="text-[12px] text-amber-700">{tt('이 MCP 프리셋은 검증된 읽기 도구가 아직 없어 토큰 저장만으로 조회할 수 없습니다.')}</p>
            )}
            {canManage ? (
              <div className="flex gap-2">
                <Input type="password" disabled={busy !== null} value={token[c.slug] ?? ''} onChange={(e) => setToken((s) => ({ ...s, [c.slug]: e.target.value }))} placeholder={isConfigured(c) ? tt('토큰 교체…') : tt('토큰 붙여넣기')} />
                <Button onClick={() => connect(c.slug, c.official)} disabled={busy !== null || !(token[c.slug] ?? '').trim()}>
                  {isConfigured(c) ? tt('교체') : tt('연결')}
                </Button>
              </div>
            ) : (
              <p className="text-[12px] text-ink-400">{tt('연결 관리는 관리자 전용입니다.')}</p>
            )}
            {c.slug === 'notion' && canManage && isConfigured(c) && (
              <div className="space-y-2">
                <Button variant="secondary" onClick={testNotion} disabled={busy !== null}>{tt('저장된 토큰 인증 확인')}</Button>
                {notionTest !== null && <p role="status" className="text-[12px] text-ink-600">{tt(notionTest
                  ? '인증을 확인했습니다. 조회할 페이지의 공유 권한은 별도로 확인하세요.'
                  : '인증을 확인하지 못했습니다. 토큰과 커넥터 배포 상태를 확인하세요.')}</p>}
                <Link href={`/assistant?q=${encodeURIComponent('/observability Notion에서 운영 런북을 검색하고 관련 문서를 요약해줘')}`} className="block text-[12px] text-brand-600 hover:underline">{tt('Notion 지식 검색 →')}</Link>
              </div>
            )}
            <span className="inline-block text-[11px] text-ink-400 border border-ink-200 rounded px-1.5 py-0.5">{tt(`읽기 전용(${c.readOnlyNote}) · 쓰기 제안전용(비활성)`)}</span>
          </Card>
        ))}
      </div>
      {canManage && loadState === 'unknown' && <Button variant="secondary" onClick={load}>{tt('상태 다시 확인')}</Button>}
      {msg && <p role={saveError ? 'alert' : 'status'} className="text-[13px] text-ink-500">{msg}</p>}
    </div>
  );
}
