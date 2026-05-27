// Datasource schema introspection / 외부 데이터소스 스키마 인트로스펙션
// Discovers live tables/metrics/labels on a user's datasource so AI prompts
// can be grounded in what actually exists.
// 사용자의 데이터소스에 실제 존재하는 테이블/메트릭/라벨을 발견해 AI 프롬프트를 정확하게 만든다.
import NodeCache from 'node-cache';
import type { DatasourceConfig, DatasourceType } from './app-config';
import { buildHeaders, fetchWithTimeout } from './datasource-client';

// 10-minute TTL — schemas change rarely; refetch only on cache miss.
// 10분 TTL — 스키마는 자주 안 바뀜.
const schemaCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PROMPT_CHARS = 4000;

function cacheKey(ds: DatasourceConfig): string {
  return `schema:${ds.id}`;
}

function truncate(s: string, max = MAX_PROMPT_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '\n... (truncated)';
}

// ---------------------------------------------------------------------------
// ClickHouse — list a curated subset of system tables and their columns.
// ClickHouse: 자주 쓰는 system 테이블의 컬럼/타입을 인라인.
// ---------------------------------------------------------------------------
async function clickhouseSchema(ds: DatasourceConfig): Promise<string> {
  const baseUrl = ds.url.trim().replace(/\/$/, '');
  const headers = buildHeaders(ds);
  headers['Content-Type'] = 'text/plain';
  const params = new URLSearchParams();
  if (ds.settings?.database) params.set('database', ds.settings.database);
  params.set('default_format', 'JSON');

  const target = `${baseUrl}/?${params}`;

  // Curated tables: the ones AI prompts will most likely target.
  // 자주 쓰일 시스템 테이블만 화이트리스트.
  const tables = [
    'query_log',
    'parts',
    'tables',
    'columns',
    'metrics',
    'asynchronous_metrics',
    'part_log',
    'mutations',
    'replicas',
    'merges',
  ];
  const inList = tables.map(t => `'${t}'`).join(',');
  const sql = `SELECT database, table, name, type FROM system.columns WHERE database = 'system' AND table IN (${inList}) ORDER BY table, position`;

  try {
    const resp = await fetchWithTimeout(target, { method: 'POST', headers, body: sql }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) return '';
    const data = await resp.json();
    const rows: Array<{ table: string; name: string; type: string }> = data.data || [];
    if (!rows.length) return '';
    const grouped: Record<string, string[]> = {};
    for (const r of rows) {
      const k = `system.${r.table}`;
      (grouped[k] ||= []).push(`${r.name}:${r.type}`);
    }
    const lines = Object.entries(grouped).map(([t, cols]) => `${t}(${cols.join(', ')})`);
    return truncate(lines.join('\n'));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Prometheus — top-N metric names.
// Prometheus: 메트릭 이름 상위 N개.
// ---------------------------------------------------------------------------
async function prometheusSchema(ds: DatasourceConfig): Promise<string> {
  const baseUrl = ds.url.trim().replace(/\/$/, '');
  const headers = buildHeaders(ds);
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/api/v1/label/__name__/values`, { headers }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) return '';
    const data = await resp.json();
    const names: string[] = (data.data || []) as string[];
    if (!names.length) return '';
    // Prioritize well-known prefixes the prompt already references.
    // prompt에서 이미 언급한 prefix 우선.
    const priority = ['up', 'node_', 'container_', 'kube_', 'http_', 'process_', 'go_', 'apiserver_', 'etcd_', 'kubelet_'];
    const score = (n: string) => priority.findIndex(p => n === p || n.startsWith(p));
    const ranked = names
      .map(n => ({ n, s: score(n) }))
      .sort((a, b) => (a.s === -1 ? 999 : a.s) - (b.s === -1 ? 999 : b.s))
      .map(x => x.n)
      .slice(0, 80);
    return truncate(ranked.join(', '));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Loki — labels available on streams.
// Loki: 사용 가능한 라벨.
// ---------------------------------------------------------------------------
async function lokiSchema(ds: DatasourceConfig): Promise<string> {
  const baseUrl = ds.url.trim().replace(/\/$/, '');
  const headers = buildHeaders(ds);
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/loki/api/v1/labels`, { headers }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) return '';
    const data = await resp.json();
    const labels: string[] = (data.data || []) as string[];
    if (!labels.length) return '';
    // Sample values for the most useful labels (job, namespace, app, service, level).
    // 가장 유용한 라벨의 값을 샘플링.
    const priority = ['job', 'namespace', 'app', 'service', 'level', 'container', 'pod'];
    const valueLookups = priority.filter(p => labels.includes(p)).slice(0, 4);
    const sampleParts: string[] = [];
    for (const lbl of valueLookups) {
      try {
        const vr = await fetchWithTimeout(
          `${baseUrl}/loki/api/v1/label/${encodeURIComponent(lbl)}/values`,
          { headers },
          DEFAULT_TIMEOUT_MS,
        );
        if (!vr.ok) continue;
        const vd = await vr.json();
        const vals: string[] = (vd.data || []).slice(0, 20);
        sampleParts.push(`${lbl}: [${vals.join(', ')}]`);
      } catch { /* ignore individual label failures */ }
    }
    const lines = [`labels: ${labels.slice(0, 40).join(', ')}`, ...sampleParts];
    return truncate(lines.join('\n'));
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tempo — tag namespaces.
// Tempo: 태그 namespace.
// ---------------------------------------------------------------------------
async function tempoSchema(ds: DatasourceConfig): Promise<string> {
  const baseUrl = ds.url.trim().replace(/\/$/, '');
  const headers = buildHeaders(ds);
  // Tempo exposes /api/search/tag/<scope>/values; the simplest discovery is /api/search/tags
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/api/search/tags`, { headers }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) return '';
    const data = await resp.json();
    const tags: string[] = (data.tagNames || data.tags || []) as string[];
    if (!tags.length) return '';
    return truncate(`tags: ${tags.slice(0, 60).join(', ')}`);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Jaeger — registered services.
// Jaeger: 등록된 서비스.
// ---------------------------------------------------------------------------
async function jaegerSchema(ds: DatasourceConfig): Promise<string> {
  const baseUrl = ds.url.trim().replace(/\/$/, '');
  const headers = buildHeaders(ds);
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/api/services`, { headers }, DEFAULT_TIMEOUT_MS);
    if (!resp.ok) return '';
    const data = await resp.json();
    const services: string[] = (data.data || []) as string[];
    if (!services.length) return '';
    return truncate(`services: ${services.slice(0, 40).join(', ')}`);
  } catch {
    return '';
  }
}

// Dynatrace and Datadog often need API keys + paginated endpoints — defer to Phase 3.
// Dynatrace/Datadog는 API 키 + 페이지네이션 필요 — Phase 3로 미룸.

const FETCHERS: Partial<Record<DatasourceType, (ds: DatasourceConfig) => Promise<string>>> = {
  clickhouse: clickhouseSchema,
  prometheus: prometheusSchema,
  loki: lokiSchema,
  tempo: tempoSchema,
  jaeger: jaegerSchema,
};

/**
 * Fetch (and cache) a textual schema/label summary for a datasource.
 * Returns empty string if introspection isn't implemented or fails — caller
 * should treat empty as "no schema hint" rather than an error.
 *
 * 데이터소스의 스키마/라벨 요약을 가져오고 캐시한다. 미구현/실패 시 빈 문자열.
 */
export async function getDatasourceSchema(ds: DatasourceConfig): Promise<string> {
  const key = cacheKey(ds);
  const cached = schemaCache.get<string>(key);
  if (cached !== undefined) return cached;
  const fetcher = FETCHERS[ds.type];
  if (!fetcher) {
    schemaCache.set(key, '', 600);
    return '';
  }
  try {
    const schema = await fetcher(ds);
    schemaCache.set(key, schema);
    return schema;
  } catch (err: any) {
    console.warn(`[datasource-schema] ${ds.type}/${ds.id} introspection failed: ${err?.message || err}`);
    // Cache empty result for a shorter window so transient failures aren't sticky.
    // 일시 실패는 짧은 TTL로 캐시.
    schemaCache.set(key, '', 60);
    return '';
  }
}

/**
 * Invalidate the cached schema for a datasource — call after deletion / config edit.
 * 데이터소스 삭제/수정 후 호출.
 */
export function invalidateDatasourceSchema(dsId: string): void {
  schemaCache.del(`schema:${dsId}`);
}
