// Pure normalizer: connector-Lambda query bodies → a render-ready shape for the Explore page.
// No I/O. Never throws — malformed input degrades to { shape: 'empty', note }.
// Connector return contracts (unwrapped by invokeConnectorTool from { statusCode, body }):
//   prometheus/mimir : { truncated?, resultType: 'matrix'|'vector', result: [...] }
//   loki             : { truncated?, resultType: 'streams', result: [{ stream, values:[[ns,line]] }] }
//   tempo            : { truncated?, traces: [{ traceID, rootServiceName, rootTraceName, durationMs }] }
//   clickhouse       : { rowCount, rows: [{col:val}], meta: [{name,type}] }

export interface Column { key: string; label: string }
export interface NormalizedResult {
  shape: 'series' | 'table' | 'logs' | 'traces' | 'empty';
  columns?: Column[];
  rows?: Record<string, unknown>[];
  series?: Record<string, unknown>[];
  seriesXKey?: string;
  seriesYKey?: string;
  truncated?: boolean;
  note?: string;
}

const cols = (keys: string[]): Column[] => keys.map((k) => ({ key: k, label: k }));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Prometheus metric object → "name{label="v",...}" for display. */
function labelStr(metric: unknown): string {
  if (!isObj(metric)) return '';
  const name = typeof metric.__name__ === 'string' ? metric.__name__ : '';
  const rest = Object.entries(metric)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}="${String(v)}"`)
    .join(',');
  return rest ? `${name}{${rest}}` : name;
}

function prom(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  if (!result.length) return { shape: 'empty', truncated, note: '결과 없음' };

  if (body.resultType === 'matrix') {
    // first series → chart; all series → a summary table
    const first = result[0] as Record<string, unknown>;
    const values = Array.isArray(first.values) ? (first.values as unknown[][]) : [];
    const series = values.map((p) => ({ t: new Date(num(p[0]) * 1000).toISOString(), value: num(p[1]) }));
    const rows = result.map((s) => {
      const so = s as Record<string, unknown>;
      const pts = Array.isArray(so.values) ? (so.values as unknown[]).length : 0;
      return { metric: labelStr(so.metric), points: pts };
    });
    if (!series.length) return { shape: 'empty', truncated, note: '시계열 포인트 없음' };
    return { shape: 'series', series, seriesXKey: 't', seriesYKey: 'value', rows, columns: cols(['metric', 'points']), truncated };
  }
  // vector (instant)
  const rows = result.map((e) => {
    const eo = e as Record<string, unknown>;
    const val = Array.isArray(eo.value) ? (eo.value as unknown[]) : [];
    return { metric: labelStr(eo.metric), value: num(val[1]), timestamp: new Date(num(val[0]) * 1000).toISOString() };
  });
  return { shape: 'table', rows, columns: cols(['metric', 'value', 'timestamp']), truncated };
}

function loki(body: Record<string, unknown>): NormalizedResult {
  const result = Array.isArray(body.result) ? body.result : [];
  const truncated = body.truncated === true;
  const rows: Record<string, unknown>[] = [];
  for (const stream of result) {
    const so = stream as Record<string, unknown>;
    const labels = labelStr(so.stream);
    const values = Array.isArray(so.values) ? (so.values as unknown[][]) : [];
    for (const pair of values) {
      const ns = num(pair[0]);
      rows.push({ timestamp: new Date(ns / 1e6).toISOString(), line: String(pair[1] ?? ''), labels });
    }
  }
  if (!rows.length) return { shape: 'empty', truncated, note: '로그 없음' };
  return { shape: 'logs', rows, columns: cols(['timestamp', 'line', 'labels']), truncated };
}

function tempo(body: Record<string, unknown>): NormalizedResult {
  const traces = Array.isArray(body.traces) ? body.traces : [];
  const truncated = body.truncated === true;
  if (!traces.length) return { shape: 'empty', truncated, note: '트레이스 없음' };
  const rows = traces.map((t) => {
    const to = t as Record<string, unknown>;
    return {
      traceID: to.traceID ?? to.traceId ?? '',
      rootServiceName: to.rootServiceName ?? '',
      rootTraceName: to.rootTraceName ?? '',
      durationMs: to.durationMs ?? to.durationMms ?? '',
    };
  });
  return { shape: 'traces', rows, columns: cols(['traceID', 'rootServiceName', 'rootTraceName', 'durationMs']), truncated };
}

function clickhouse(body: Record<string, unknown>): NormalizedResult {
  const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : [];
  const truncated = body.truncated === true;
  if (!rows.length) return { shape: 'empty', truncated, note: '행 없음' };
  const meta = Array.isArray(body.meta) ? body.meta : [];
  const keys = meta.length
    ? meta.map((m) => String((m as Record<string, unknown>).name))
    : Object.keys(rows[0] ?? {});
  return { shape: 'table', rows, columns: cols(keys), truncated };
}

export function normalizeResult(kind: string, _tool: string, body: unknown): NormalizedResult {
  if (!isObj(body)) return { shape: 'empty', note: '응답 없음' };
  try {
    switch (kind) {
      case 'prometheus':
      case 'mimir':
        return prom(body);
      case 'loki':
        return loki(body);
      case 'tempo':
        return tempo(body);
      case 'clickhouse':
        return clickhouse(body);
      default:
        return { shape: 'empty', note: `지원하지 않는 데이터소스: ${kind}` };
    }
  } catch (e) {
    return { shape: 'empty', note: `결과 파싱 실패: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}
