// Datasource query generation prompts / 외부 데이터소스 쿼리 생성 프롬프트
// Builder pattern: schema-aware, error-feedback aware.
// 빌더 패턴: 스키마 인식, 에러 피드백 인식.
import type { DatasourceType } from '@/lib/app-config';

/**
 * Context for prompt building.
 * 프롬프트 빌더 컨텍스트.
 */
export interface PromptContext {
  /** Time range like "1h", "24h" - injected into prompt as guidance / 시간 범위 힌트 */
  timeRange?: string;
  /** Per-datasource schema snippet (already formatted for prompt) / 데이터소스 스키마 스니펫 */
  schema?: string;
  /** Previous query that failed + its error - for retry / 재시도용 직전 실패 쿼리/에러 */
  recentError?: { query: string; error: string };
  /** Datasource version string if known / 알려진 버전 */
  version?: string;
}

const COMMON_RULES = `Rules:
- Return ONLY the query string, no explanation, no markdown, no code blocks, no comments.
- Output must be directly executable against the target system.`;

function buildClickHousePrompt(ctx: PromptContext): string {
  const schemaBlock = ctx.schema ? `\n\nLive schema from THIS server (use these EXACT column names and types):\n${ctx.schema}\n` : '';
  const versionBlock = ctx.version ? `\nServer version: ${ctx.version}` : '';
  return `You are a ClickHouse SQL expert. Generate a SELECT query for the user's analytics question.

${COMMON_RULES}
- Only SELECT, SHOW, or DESCRIBE statements are allowed.
- Use system tables for metadata: system.tables, system.parts, system.columns, system.metrics, system.query_log.
- Time functions: prefer toStartOfMinute()/toStartOfHour()/toStartOfDay() which accept BOTH DateTime and DateTime64.
- AVOID toStartOfSecond() and toStartOfMillisecond() — these REQUIRE DateTime64 input and fail with DateTime columns.
- system.query_log.event_time is DateTime in OSS builds <24.x and DateTime64(3)/(6) in newer; if unsure, do NOT use sub-second bucketing.
- For "slowest queries" use: ORDER BY query_duration_ms DESC LIMIT N — do not bucket by time.
- For "throughput / qps over time" bucket by toStartOfMinute(event_time) or coarser.
- Always filter by event_date = today() (or a range) on system.query_log to use the date partition index.
- WHERE clause must always restrict by an event_date / time column when scanning system.query_log or system.part_log.
- Use type = 'QueryFinish' for completed query stats; type = 'ExceptionWhileProcessing' for failures.
- Use LowCardinality-friendly filters; user column is LowCardinality(String).
- Use substring(query, 1, 200) AS query_preview to avoid returning huge query texts.
- Never use table functions (url, file, remote*, s3, mysql, postgresql, jdbc, mongo, etc.).${schemaBlock}${versionBlock}

Worked examples:
- "오늘 가장 느린 쿼리 10개" →
  SELECT query_id, user, event_time, query_duration_ms, read_rows, read_bytes, memory_usage, substring(query, 1, 200) AS query_preview FROM system.query_log WHERE event_date = today() AND type = 'QueryFinish' ORDER BY query_duration_ms DESC LIMIT 10
- "시간대별 쿼리 수 (오늘)" →
  SELECT toStartOfHour(event_time) AS hour, count() AS queries FROM system.query_log WHERE event_date = today() AND type = 'QueryFinish' GROUP BY hour ORDER BY hour
- "테이블 목록" →
  SELECT database, name, engine, total_rows, total_bytes FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY total_bytes DESC
- "디스크 사용 큰 파트" →
  SELECT database, table, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active GROUP BY database, table ORDER BY bytes DESC LIMIT 20`;
}

function buildPrometheusPrompt(ctx: PromptContext): string {
  const metricBlock = ctx.schema ? `\n\nMetrics that ACTUALLY exist on this Prometheus (subset, use these exact names when possible):\n${ctx.schema}\n` : '';
  return `You are a Prometheus PromQL expert. Generate a PromQL query for the user's metrics question.

${COMMON_RULES}
- Counter metrics MUST be wrapped in rate()/irate() with a window (e.g. [5m]) before aggregation.
- For "CPU usage %" use: 100 * (1 - avg by (instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])))
- For "memory usage %" use: 100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
- For HTTP latency p95 use: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
- Common labels: instance, job, namespace, pod, container, mode, device, cpu.
- Common metric prefixes: node_*, container_*, kube_*, http_*, up. Prefer instant query unless the user asks for "over time".
- If the user asks "top N" wrap with topk(N, ...).
- Do NOT invent metric names. If unsure, prefer up{} or a well-known node_exporter metric.${metricBlock}

Worked examples:
- "CPU 사용률 (노드별)" → 100 * (1 - avg by (instance)(rate(node_cpu_seconds_total{mode="idle"}[5m])))
- "메모리 사용량 상위 5 노드" → topk(5, 100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))
- "Pod 재시작 (1시간)" → sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h]))
- "5xx 비율" → sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`;
}

function buildLokiPrompt(ctx: PromptContext): string {
  const labelBlock = ctx.schema ? `\n\nLabels available on this Loki (use only these in stream selectors):\n${ctx.schema}\n` : '';
  return `You are a Loki LogQL expert. Generate a LogQL query for the user's log search question.

${COMMON_RULES}
- Every query MUST start with a stream selector: {label="value"}. Empty selectors are rejected.
- Filter operators on log lines: |= "text" (contains), != "text", |~ "regex", !~ "regex".
- Parsers: | json, | logfmt, | regexp \`(?P<name>...)\`.
- For metric queries wrap with rate()/count_over_time()/bytes_over_time() and a range.
- Prefer {job=~".+"} only as a last resort; pick a concrete label when possible.${labelBlock}

Worked examples:
- "에러 로그 (모든 서비스)" → {job=~".+"} |= "error" != "errorlevel"
- "nginx 5xx 로그" → {job="nginx"} | json | status >= 500
- "에러 비율" → sum(rate({job=~".+"} |= "error" [5m])) / sum(rate({job=~".+"} [5m]))
- "timeout 키워드 포함 (1h)" → count_over_time({job=~".+"} |~ "(?i)timeout" [1h])`;
}

function buildTempoPrompt(ctx: PromptContext): string {
  const tagBlock = ctx.schema ? `\n\nSpan/resource tags discovered on this Tempo:\n${ctx.schema}\n` : '';
  return `You are a Tempo TraceQL expert. Generate a TraceQL query for the user's trace search question.

${COMMON_RULES}
- Filters live inside { ... }. Resource attrs: resource.service.name. Span attrs: span.http.status_code, span.http.method, name. Intrinsics: duration, status, kind.
- Combine with && / || / parentheses.
- For "slow" requests use duration > 500ms (or larger).
- For "errors" use status = error OR span.http.status_code >= 400.${tagBlock}

Worked examples:
- "느린 요청 (1s↑)" → { duration > 1s }
- "프론트엔드 에러 트레이스" → { resource.service.name = "frontend" && status = error }
- "결제 서비스 4xx/5xx" → { resource.service.name = "payment" && span.http.status_code >= 400 }`;
}

function buildJaegerPrompt(ctx: PromptContext): string {
  const serviceBlock = ctx.schema ? `\n\nServices registered on this Jaeger:\n${ctx.schema}\n` : '';
  return `You are a Jaeger tracing expert. Generate a Jaeger search query for the user's question.

${COMMON_RULES}
- Output must be a "key=value&key=value" query string OR a single trace ID (hex).
- Parameters: service, operation, tags (JSON), lookback (e.g. 1h), limit, minDuration, maxDuration.
- tags must be JSON: tags={"error":"true","http.status_code":"500"}.${serviceBlock}

Worked examples:
- "프론트엔드 에러 트레이스" → service=frontend&tags={"error":"true"}&limit=50
- "느린 API (1s↑)" → service=api-gateway&minDuration=1s&limit=20
- "결제 서비스 최근 1시간" → service=payment&lookback=1h&limit=50`;
}

function buildDynatracePrompt(ctx: PromptContext): string {
  const metricBlock = ctx.schema ? `\n\nMetric selectors discovered on this Dynatrace tenant:\n${ctx.schema}\n` : '';
  return `You are a Dynatrace API expert. Generate a Dynatrace metric selector or entity selector for the user's question.

${COMMON_RULES}
- For metrics: builtin metric selectors (e.g. builtin:host.cpu.usage). Append aggregations like :avg, :max, :sum where needed.
- For entities: type("HOST") / type("SERVICE") with entityName(...) or tag(...).
- Common prefixes: builtin:host.*, builtin:service.*, builtin:process.*, builtin:apps.*.${metricBlock}

Worked examples:
- "호스트 CPU 사용량" → builtin:host.cpu.usage
- "서비스 응답 시간" → builtin:service.response.time:avg
- "서비스 에러 수" → builtin:service.errors.total.count:sum
- "호스트 목록" → type("HOST")`;
}

function buildDatadogPrompt(ctx: PromptContext): string {
  const metricBlock = ctx.schema ? `\n\nMetrics discovered on this Datadog account:\n${ctx.schema}\n` : '';
  return `You are a Datadog query expert. Generate a Datadog metric query or log search for the user's question.

${COMMON_RULES}
- For metrics: avg|sum|max|min : metric{tags} by {group}. Example: avg:system.cpu.user{*} by {host}.
- For log searches: free text + facets like service:web-app status:error @http.status_code:500.
- For counters with rate-like behavior use .as_rate() or .as_count().${metricBlock}

Worked examples:
- "CPU 사용률 (호스트별)" → avg:system.cpu.user{*} by {host}
- "web 서비스 에러 로그" → service:web-app status:error
- "HTTP 요청 수" → sum:trace.http.request.hits{service:web-app}.as_count()`;
}

const BUILDERS: Record<DatasourceType, (ctx: PromptContext) => string> = {
  prometheus: buildPrometheusPrompt,
  loki: buildLokiPrompt,
  tempo: buildTempoPrompt,
  clickhouse: buildClickHousePrompt,
  jaeger: buildJaegerPrompt,
  dynatrace: buildDynatracePrompt,
  datadog: buildDatadogPrompt,
};

/**
 * Build a system prompt for the given datasource type and context.
 * 데이터소스 타입과 컨텍스트로부터 시스템 프롬프트 생성.
 */
export function buildDatasourcePrompt(dsType: DatasourceType, ctx: PromptContext = {}): string {
  let prompt = BUILDERS[dsType](ctx);
  if (ctx.timeRange) {
    prompt += `\n\nTime context: the user is looking at data from the last ${ctx.timeRange}. Reflect this in time filters when relevant.`;
  }
  if (ctx.recentError) {
    prompt += `\n\nPREVIOUS ATTEMPT FAILED. You generated:\n${ctx.recentError.query}\n\nThe server rejected it with:\n${ctx.recentError.error}\n\nProduce a CORRECTED query that fixes this exact error. Do not repeat the same mistake.`;
  }
  return prompt;
}

