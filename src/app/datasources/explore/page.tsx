'use client';

import { useState, useEffect, useCallback } from 'react';
import Header from '@/components/layout/Header';
import DataTable from '@/components/table/DataTable';
import LineChartCard from '@/components/charts/LineChartCard';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import { Play, Clock, Database, Activity, FileText, Waypoints, ChevronDown } from 'lucide-react';

// --- Types / 타입 정의 ---

interface Datasource {
  id: string;
  name: string;
  type: 'prometheus' | 'loki' | 'tempo' | 'clickhouse';
  url: string;
  isDefault?: boolean;
}

interface QueryResultMetadata {
  datasource: string;
  type: string;
  queryLanguage: string;
  executionTimeMs: number;
  resultType?: string;
  totalRows?: number;
}

interface QueryResult {
  columns: string[];
  rows: any[];
  metadata: QueryResultMetadata;
}

// --- Constants / 상수 ---

// Time range presets / 시간 범위 프리셋
const TIME_RANGES = [
  { label: '15m', value: '15m', step: '15s' },
  { label: '1h', value: '1h', step: '60s' },
  { label: '6h', value: '6h', step: '300s' },
  { label: '24h', value: '24h', step: '900s' },
  { label: '7d', value: '7d', step: '3600s' },
  { label: '30d', value: '30d', step: '14400s' },
];

// Example queries per datasource type / 데이터소스 타입별 예제 쿼리
const EXAMPLE_QUERIES: Record<string, string[]> = {
  prometheus: [
    'up',
    'rate(node_cpu_seconds_total{mode="idle"}[5m])',
    'node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes * 100',
    'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))',
  ],
  loki: [
    '{job="varlogs"}',
    '{namespace="default"} |= "error"',
    'rate({job="nginx"}[5m])',
    '{app="frontend"} | json | level="error" | line_format "{{.message}}"',
  ],
  tempo: [
    '{ resource.service.name = "frontend" }',
    '{ span.http.status_code >= 400 }',
    '{ duration > 500ms }',
    '{ resource.service.name = "api" && status = error }',
  ],
  clickhouse: [
    'SELECT count() FROM system.tables',
    'SELECT database, name, engine FROM system.tables ORDER BY database, name',
    "SELECT * FROM system.metrics WHERE metric LIKE '%Query%'",
    'SELECT toStartOfHour(event_time) AS hour, count() AS queries FROM system.query_log WHERE event_date = today() GROUP BY hour ORDER BY hour',
  ],
};

// Placeholder text per datasource type / 데이터소스 타입별 플레이스홀더
const PLACEHOLDERS: Record<string, string> = {
  prometheus: 'Enter PromQL query... e.g. up, rate(node_cpu_seconds_total[5m])',
  loki: 'Enter LogQL query... e.g. {job="varlogs"} |= "error"',
  tempo: 'Enter TraceQL query or trace ID... e.g. { duration > 500ms }',
  clickhouse: 'Enter SQL query... e.g. SELECT count() FROM system.tables',
};

// Icon map for datasource types / 데이터소스 타입별 아이콘 매핑
const TYPE_ICONS: Record<string, React.ReactNode> = {
  prometheus: <Activity size={14} className="text-accent-orange" />,
  loki: <FileText size={14} className="text-accent-green" />,
  tempo: <Waypoints size={14} className="text-accent-cyan" />,
  clickhouse: <Database size={14} className="text-accent-purple" />,
};

// Color map for datasource types / 데이터소스 타입별 색상 매핑
const TYPE_COLORS: Record<string, string> = {
  prometheus: '#f59e0b',
  loki: '#00ff88',
  tempo: '#00d4ff',
  clickhouse: '#a855f7',
};

// --- Component / 컴포넌트 ---

export default function DatasourceExplorePage() {
  const { t } = useLanguage();

  // State / 상태
  const [datasources, setDatasources] = useState<Datasource[]>([]);
  const [selectedDs, setSelectedDs] = useState<Datasource | null>(null);
  const [query, setQuery] = useState('');
  const [timeRange, setTimeRange] = useState(TIME_RANGES[1]); // default 1h
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dsDropdownOpen, setDsDropdownOpen] = useState(false);
  const [timeDropdownOpen, setTimeDropdownOpen] = useState(false);
  const [dsLoading, setDsLoading] = useState(true);

  // Fetch datasource list / 데이터소스 목록 조회
  const fetchDatasources = useCallback(async () => {
    setDsLoading(true);
    try {
      const res = await fetch('/awsops/api/datasources?action=list');
      if (!res.ok) throw new Error(`Failed to fetch datasources: ${res.status}`);
      const data = await res.json();
      const list: Datasource[] = data.datasources || [];
      setDatasources(list);
      // Auto-select first datasource / 첫 번째 데이터소스 자동 선택
      if (list.length > 0 && !selectedDs) {
        setSelectedDs(list[0]);
      }
    } catch (err: any) {
      console.error('Failed to load datasources:', err);
    } finally {
      setDsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDatasources();
  }, [fetchDatasources]);

  // Run query / 쿼리 실행
  const runQuery = useCallback(async () => {
    if (!selectedDs || !query.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/awsops/api/datasources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'query',
          datasourceId: selectedDs.id,
          query: query.trim(),
          options: {
            start: timeRange.value,
            step: timeRange.step,
            limit: 1000,
          },
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errData.error || `Query failed with status ${res.status}`);
      }

      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Query execution failed');
    } finally {
      setLoading(false);
    }
  }, [selectedDs, query, timeRange]);

  // Keyboard shortcut: Ctrl/Cmd + Enter to run query / 단축키: Ctrl/Cmd + Enter로 쿼리 실행
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
  }, [runQuery]);

  // Close dropdowns on outside click / 외부 클릭 시 드롭다운 닫기
  useEffect(() => {
    const handleClick = () => {
      setDsDropdownOpen(false);
      setTimeDropdownOpen(false);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  // --- Render helpers / 렌더 헬퍼 ---

  // Prometheus chart data transformation / Prometheus 차트 데이터 변환
  const chartData = (() => {
    if (!result || result.metadata.type !== 'prometheus') return null;
    if (result.metadata.resultType !== 'matrix' || result.rows.length === 0) return null;

    // Group by metric and build time series / 메트릭별 그룹화 및 시계열 생성
    const metricsMap = new Map<string, Map<string, number>>();
    const allTimestamps = new Set<string>();

    for (const row of result.rows) {
      const ts = new Date(row.timestamp).toLocaleTimeString();
      allTimestamps.add(ts);
      if (!metricsMap.has(row.metric)) metricsMap.set(row.metric, new Map());
      metricsMap.get(row.metric)!.set(ts, parseFloat(row.value));
    }

    // If only one metric series, use simple LineChartCard format
    if (metricsMap.size <= 1) {
      return result.rows.map((r: any) => ({
        name: new Date(r.timestamp).toLocaleTimeString(),
        value: parseFloat(r.value),
      }));
    }

    return null; // Multi-series not supported by simple LineChartCard
  })();

  // Max duration for Tempo bar rendering / Tempo 막대 렌더링용 최대 duration
  const maxDuration = (() => {
    if (!result || result.metadata.type !== 'tempo') return 0;
    return Math.max(...result.rows.map((r: any) => r.durationMs || 0), 1);
  })();

  // Build DataTable columns from result / 결과에서 DataTable 컬럼 생성
  const tableColumns = (() => {
    if (!result) return [];

    // Tempo: custom duration column with bar / Tempo: 막대가 있는 duration 컬럼
    if (result.metadata.type === 'tempo') {
      return result.columns.map(col => ({
        key: col,
        label: col,
        render: col === 'durationMs'
          ? (value: any) => (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-navy-700 rounded-full overflow-hidden max-w-[120px]">
                  <div
                    className="h-full bg-accent-cyan rounded-full"
                    style={{ width: `${Math.max((value / maxDuration) * 100, 2)}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-gray-300 whitespace-nowrap">
                  {typeof value === 'number' ? `${value.toFixed(1)}ms` : value}
                </span>
              </div>
            )
          : undefined,
      }));
    }

    return result.columns.map(col => ({ key: col, label: col }));
  })();

  // --- Empty state: no datasources configured / 빈 상태: 데이터소스 미설정 ---
  if (!dsLoading && datasources.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <Header
          title={t('datasources.exploreTitle')}
          subtitle={t('datasources.exploreSubtitle')}
        />
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <Database size={48} className="mx-auto text-gray-600 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">
              {t('datasources.noConfigured')}
            </h2>
            <p className="text-gray-400 mb-6">
              {t('datasources.noConfiguredDesc')}
            </p>
            <a
              href="/awsops/datasources"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/30 hover:bg-accent-cyan/20 transition-colors"
            >
              <Database size={16} />
              {t('datasources.goToManagement')}
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Header
        title={t('datasources.exploreTitle')}
        subtitle={t('datasources.exploreSubtitle')}
        onRefresh={fetchDatasources}
      />

      {/* Toolbar / 도구 모음 */}
      <div className="sticky top-0 z-20 bg-navy-800 border-b border-navy-600 p-4">
        <div className="flex items-center gap-3 flex-wrap">

          {/* Datasource selector / 데이터소스 선택기 */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setDsDropdownOpen(!dsDropdownOpen); setTimeDropdownOpen(false); }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-sm text-gray-200 hover:border-accent-cyan/50 transition-colors min-w-[200px]"
            >
              {selectedDs ? (
                <>
                  {TYPE_ICONS[selectedDs.type]}
                  <span className="truncate">{selectedDs.name}</span>
                </>
              ) : (
                <>
                  <Database size={14} className="text-gray-500" />
                  <span className="text-gray-500">Select datasource...</span>
                </>
              )}
              <ChevronDown size={14} className="ml-auto text-gray-500" />
            </button>

            {dsDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-72 bg-navy-800 border border-navy-600 rounded-lg shadow-xl overflow-hidden z-30">
                {datasources.map(ds => (
                  <button
                    key={ds.id}
                    onClick={() => {
                      setSelectedDs(ds);
                      setDsDropdownOpen(false);
                      setResult(null);
                      setError(null);
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                      selectedDs?.id === ds.id
                        ? 'bg-accent-cyan/10 text-accent-cyan'
                        : 'text-gray-300 hover:bg-navy-700'
                    }`}
                  >
                    {TYPE_ICONS[ds.type]}
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{ds.name}</div>
                      <div className="text-xs text-gray-500 truncate">{ds.url}</div>
                    </div>
                    {ds.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">
                        default
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Time range selector / 시간 범위 선택기 */}
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => { setTimeDropdownOpen(!timeDropdownOpen); setDsDropdownOpen(false); }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-navy-900 border border-navy-600 text-sm text-gray-200 hover:border-accent-cyan/50 transition-colors"
            >
              <Clock size={14} className="text-gray-400" />
              <span>Last {timeRange.label}</span>
              <ChevronDown size={14} className="text-gray-500" />
            </button>

            {timeDropdownOpen && (
              <div className="absolute top-full left-0 mt-1 w-36 bg-navy-800 border border-navy-600 rounded-lg shadow-xl overflow-hidden z-30">
                {TIME_RANGES.map(tr => (
                  <button
                    key={tr.value}
                    onClick={() => { setTimeRange(tr); setTimeDropdownOpen(false); }}
                    className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                      timeRange.value === tr.value
                        ? 'bg-accent-cyan/10 text-accent-cyan'
                        : 'text-gray-300 hover:bg-navy-700'
                    }`}
                  >
                    Last {tr.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Run Query button / 쿼리 실행 버튼 */}
          <button
            onClick={runQuery}
            disabled={loading || !selectedDs || !query.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-cyan text-navy-900 font-semibold text-sm hover:bg-accent-cyan/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-navy-900/30 border-t-navy-900 rounded-full animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Run Query
          </button>

          {/* Keyboard shortcut hint / 단축키 힌트 */}
          <span className="text-xs text-gray-600 hidden sm:inline">
            Ctrl+Enter
          </span>
        </div>
      </div>

      {/* Main content area / 메인 콘텐츠 영역 */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">

        {/* Query Editor / 쿼리 에디터 */}
        <div className="bg-navy-800 rounded-lg border border-navy-600 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {selectedDs ? `${selectedDs.type.toUpperCase()} Query` : 'Query'}
            </span>
            {selectedDs && (
              <span className="text-xs text-gray-500">
                {PLACEHOLDERS[selectedDs.type]?.split('...')[0]}
              </span>
            )}
          </div>

          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedDs ? PLACEHOLDERS[selectedDs.type] : 'Select a datasource to start querying...'}
            className="w-full bg-navy-900 border border-navy-600 rounded-lg p-3 text-sm font-mono text-gray-200 placeholder-gray-600 resize-y focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/20 transition-colors"
            rows={3}
          />

          {/* Example queries / 예제 쿼리 */}
          {selectedDs && (
            <div className="mt-3">
              <span className="text-xs text-gray-500 mr-2">Examples:</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {(EXAMPLE_QUERIES[selectedDs.type] || []).map((ex, i) => (
                  <button
                    key={i}
                    onClick={() => setQuery(ex)}
                    className="px-2.5 py-1 rounded-md text-xs font-mono bg-navy-700 border border-navy-600 text-gray-400 hover:text-accent-cyan hover:border-accent-cyan/30 transition-colors truncate max-w-[300px]"
                    title={ex}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Status bar / 상태 바 */}
        {loading && selectedDs && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-navy-800 border border-navy-600">
            <div className="w-3 h-3 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
            <span className="text-sm text-gray-400">
              Querying {selectedDs.name}...
            </span>
          </div>
        )}

        {/* Error display / 에러 표시 */}
        {error && (
          <div className="px-4 py-3 rounded-lg bg-accent-red/10 border border-accent-red/30 text-sm text-accent-red">
            <span className="font-semibold">Error: </span>{error}
          </div>
        )}

        {/* Result metadata bar / 결과 메타데이터 바 */}
        {result && !loading && (
          <div className="flex items-center gap-4 px-4 py-2 rounded-lg bg-navy-800 border border-navy-600 text-xs text-gray-400">
            <span>
              <span className="text-white font-semibold">{result.metadata.totalRows ?? result.rows.length}</span> rows returned
            </span>
            <span>
              in <span className="text-accent-cyan font-mono">{result.metadata.executionTimeMs}ms</span>
            </span>
            <span className="text-gray-600">|</span>
            <span>{result.metadata.queryLanguage}</span>
            {result.metadata.resultType && (
              <>
                <span className="text-gray-600">|</span>
                <span>type: {result.metadata.resultType}</span>
              </>
            )}
          </div>
        )}

        {/* Results: Prometheus chart / 결과: Prometheus 차트 */}
        {result && result.metadata.type === 'prometheus' && chartData && (
          <LineChartCard
            title={`${result.metadata.datasource} - ${result.metadata.resultType}`}
            data={chartData}
            color={TYPE_COLORS.prometheus}
          />
        )}

        {/* Results: Loki log viewer / 결과: Loki 로그 뷰어 */}
        {result && result.metadata.type === 'loki' && result.metadata.resultType === 'streams' && (
          <div className="bg-navy-800 rounded-lg border border-navy-600 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-navy-600 bg-navy-700">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <FileText size={14} className="text-accent-green" />
                Log Streams
                <span className="text-xs font-normal text-gray-400">
                  ({result.rows.length} lines)
                </span>
              </h3>
            </div>
            <div className="max-h-[500px] overflow-y-auto">
              {result.rows.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  No log lines found
                </div>
              ) : (
                result.rows.map((row: any, i: number) => {
                  // Parse labels for colored badges / 라벨 파싱하여 색상 배지 생성
                  let labelEntries: [string, string][] = [];
                  try {
                    const parsed = JSON.parse(row.labels);
                    labelEntries = Object.entries(parsed) as [string, string][];
                  } catch {}

                  return (
                    <div
                      key={i}
                      className={`flex gap-3 px-4 py-1.5 border-b border-navy-700/50 hover:bg-navy-700/50 transition-colors ${
                        i % 2 === 0 ? 'bg-navy-800' : 'bg-navy-700/30'
                      }`}
                    >
                      {/* Timestamp / 타임스탬프 */}
                      <span className="text-xs font-mono text-gray-500 whitespace-nowrap shrink-0 pt-0.5">
                        {new Date(row.timestamp).toLocaleTimeString()}
                      </span>

                      {/* Labels / 라벨 */}
                      <div className="flex flex-wrap gap-1 shrink-0 pt-0.5">
                        {labelEntries.slice(0, 3).map(([k, v]) => (
                          <span
                            key={k}
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-accent-green/10 text-accent-green/80 border border-accent-green/20"
                          >
                            {k}={v}
                          </span>
                        ))}
                      </div>

                      {/* Log line / 로그 라인 */}
                      <span className="text-sm text-gray-200 font-mono break-all">
                        {row.line}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Results: Loki metric (matrix) / 결과: Loki 메트릭 (matrix) */}
        {result && result.metadata.type === 'loki' && result.metadata.resultType === 'matrix' && (
          <DataTable
            columns={result.columns.map(col => ({ key: col, label: col }))}
            data={result.rows}
          />
        )}

        {/* Results: Tempo traces / 결과: Tempo 트레이스 */}
        {result && result.metadata.type === 'tempo' && (
          <div className="bg-navy-800 rounded-lg border border-navy-600 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-navy-600 bg-navy-700">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Waypoints size={14} className="text-accent-cyan" />
                Traces
                <span className="text-xs font-normal text-gray-400">
                  ({result.rows.length} results)
                </span>
              </h3>
            </div>
            <DataTable
              columns={tableColumns}
              data={result.rows}
            />
          </div>
        )}

        {/* Results: ClickHouse tabular / 결과: ClickHouse 테이블 */}
        {result && result.metadata.type === 'clickhouse' && (
          <DataTable
            columns={tableColumns}
            data={result.rows}
          />
        )}

        {/* Results: Prometheus table (vector or fallback) / 결과: Prometheus 테이블 (vector 또는 폴백) */}
        {result && result.metadata.type === 'prometheus' && (
          <DataTable
            columns={tableColumns}
            data={result.rows}
          />
        )}

        {/* Initial empty state / 초기 빈 상태 */}
        {!result && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <Activity size={40} className="mb-4 text-gray-600" />
            <p className="text-lg font-medium text-gray-400 mb-1">
              {t('datasources.exploreEmpty')}
            </p>
            <p className="text-sm text-gray-600">
              {t('datasources.exploreEmptyDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
