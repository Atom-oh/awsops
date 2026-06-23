import { sectionByKey, activeSections } from './sections';

// MVP keyword heuristics per section (KO + EN). First match wins, in this order.
const RULES: { key: string; re: RegExp }[] = [
  { key: 'cost', re: /비용|요금|예산|절감|billing|cost|budget|forecast|spend/i },
  { key: 'security', re: /보안|권한|역할|정책|iam|policy|role|denied|permission|public|노출/i },
  { key: 'network', re: /통신|연결|네트워크|포트|라우트|reachab|network|connectivity|security ?group|\bsg\b|nacl|tgw|vpn|peering|flow ?log/i },
  { key: 'container', re: /파드|컨테이너|eks|ecs|kubernetes|k8s|pod|istio|namespace|sidecar/i },
  { key: 'data', re: /쿼리|데이터베이스|rds|aurora|dynamo|elasticache|redis|msk|kafka|database|slow query|throttl/i },
  { key: 'cost', re: /\$\d/i },
  { key: 'monitoring', re: /알람|지표|로그변경|cloudwatch|cloudtrail|alarm|metric|who changed|audit/i },
  { key: 'iac', re: /드리프트|스택|terraform|cloudformation|\bcdk\b|drift|stack|iac/i },
  // ops = inventory_read MCP home: topology, unused/orphan resources, and the load-balancer /
  // target-group / CloudFront *listing* tools live here (network only does connectivity).
  { key: 'ops', re: /미사용|안 ?쓰는|놀고 ?있는|orphan|고아|unused|인벤토리|inventory|리소스 ?(현황|목록|정리)|정리하|leftover|미연결|unattached|미할당|토폴로지|topology|origin|\btg\b|로드 ?밸런서|load ?balancer|\belb\b|\balb\b|\bnlb\b|타겟 ?그룹|대상 ?그룹|target ?group|cloudfront|클라우드프론트|리스너|listener/i },
  { key: 'observability', re: /레이턴시|트레이스|p99|에러율|error ?rate|latency|trace|promql|prometheus|clickhouse|클릭하우스|메트릭|metric|loki|tempo|mimir|grafana/i },
];

/** Choose the agent gateway. A valid pin always wins; otherwise keyword-match; else 'ops'. */
export function pickGateway(prompt: string, pinned?: string): string {
  if (pinned && sectionByKey(pinned)) return pinned;
  for (const r of RULES) {
    if (r.re.test(prompt)) return r.key;
  }
  return 'ops';
}

// ── ADR-038 hybrid routing ───────────────────────────────────────────────────

export interface RankedEntry { key: string; score: number; active: boolean }
export interface RouteResult {
  primary: string;
  ranked: RankedEntry[];
  method: 'pin' | 'regex' | 'llm' | 'fallback';
  // ADR-044: cross-domain auto-synthesis signal. `selected` = the active routes the chat
  // handler may fan out over (≤3); `multiDomain` true ⇒ ≥2 selected ⇒ ADR-025 fan-out+synthesis.
  // pin/regex/fallback are always single. NOTE: the Agent-Space/active filter later in
  // chat/route.ts may shrink `selected` — the handler MUST recompute multiDomain after filtering.
  multiDomain: boolean;
  selected: RankedEntry[];
}
export interface ClassifyOpts {
  llmEnabled?: boolean;
  classify?: (prompt: string) => Promise<{ key: string; score: number }[]>;
  /** ADR-044: min classifier score for a route to join the multi-domain fan-out set. */
  minScore?: number;
}

/** ADR-044 default multi-route inclusion threshold (env-overridable, golden-set-tuned). */
export const MULTI_ROUTE_MIN_SCORE = Number(process.env.MULTI_ROUTE_MIN_SCORE || 0.3);

/** Active routes (score ≥ minScore), best-first, capped at 3 — the fan-out candidate set (ADR-044). */
export function selectMultiRoute(ranked: RankedEntry[], minScore = MULTI_ROUTE_MIN_SCORE): RankedEntry[] {
  return ranked.filter((r) => r.active && r.score >= minScore).slice(0, 3);
}

/** Catch-all fallback MUST be an active section — inactive 'ops' would block chat (spec §2.3). */
export const ACTIVE_FALLBACK = activeSections()[0]?.key ?? 'ops';

/** Distinct section keys matched by the keyword RULES (duplicate-rule keys counted once). */
export function matchedSections(prompt: string): string[] {
  const keys: string[] = [];
  for (const r of RULES) {
    if (r.re.test(prompt) && !keys.includes(r.key)) keys.push(r.key);
  }
  return keys;
}

function entry(key: string, score: number): RankedEntry {
  return { key, score, active: sectionByKey(key)?.active === true };
}

/**
 * Hybrid route decision: pin → regex (exactly 1 distinct match) → LLM (ambiguous/no-match)
 * → graceful fallback. Never throws; never blocks chat (spec §2, §6).
 */
export async function classifyRoute(prompt: string, pinned?: string, opts: ClassifyOpts = {}): Promise<RouteResult> {
  // Single-route result: selected = [the one entry], never multi-domain (ADR-044).
  const single = (primary: string, ranked: RankedEntry[], method: RouteResult['method']): RouteResult =>
    ({ primary, ranked, method, multiDomain: false, selected: [ranked[0]] });

  if (pinned && sectionByKey(pinned)) {
    return single(pinned, [entry(pinned, 1)], 'pin');
  }
  const matched = matchedSections(prompt);
  if (matched.length === 1) {
    return single(matched[0], [entry(matched[0], 1)], 'regex');
  }
  if (opts.llmEnabled && opts.classify) {
    try {
      const ranked = (await opts.classify(prompt)).map((r) => entry(r.key, r.score));
      if (ranked.length > 0) {
        // ADR-044: ≥2 active routes above threshold ⇒ candidate for cross-domain auto-synthesis.
        const selected = selectMultiRoute(ranked, opts.minScore);
        const multiDomain = selected.length >= 2;
        return { primary: ranked[0].key, ranked, method: 'llm', multiDomain, selected: multiDomain ? selected : [ranked[0]] };
      }
    } catch { /* classifier must never block chat — fall through */ }
  }
  // LLM off/empty/failed: legacy first-match if any rule hit, else fallback.
  if (matched.length > 0) {
    return single(matched[0], [entry(matched[0], 1)], 'regex');
  }
  const fallbackKey = opts.llmEnabled ? ACTIVE_FALLBACK : 'ops'; // flag off = exact legacy behavior
  return single(fallbackKey, [entry(fallbackKey, 0)], opts.llmEnabled ? 'fallback' : 'regex');
}
