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
  { key: 'observability', re: /레이턴시|트레이스|p99|latency|trace|loki|tempo|prometheus|jaeger|grafana/i },
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
}
export interface ClassifyOpts {
  llmEnabled?: boolean;
  classify?: (prompt: string) => Promise<{ key: string; score: number }[]>;
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
  if (pinned && sectionByKey(pinned)) {
    return { primary: pinned, ranked: [entry(pinned, 1)], method: 'pin' };
  }
  const matched = matchedSections(prompt);
  if (matched.length === 1) {
    return { primary: matched[0], ranked: [entry(matched[0], 1)], method: 'regex' };
  }
  if (opts.llmEnabled && opts.classify) {
    try {
      const ranked = (await opts.classify(prompt)).map((r) => entry(r.key, r.score));
      if (ranked.length > 0) return { primary: ranked[0].key, ranked, method: 'llm' };
    } catch { /* classifier must never block chat — fall through */ }
  }
  // LLM off/empty/failed: legacy first-match if any rule hit, else fallback.
  if (matched.length > 0) {
    return { primary: matched[0], ranked: [entry(matched[0], 1)], method: 'regex' };
  }
  const fallbackKey = opts.llmEnabled ? ACTIVE_FALLBACK : 'ops'; // flag off = exact legacy behavior
  return { primary: fallbackKey, ranked: [entry(fallbackKey, 0)], method: opts.llmEnabled ? 'fallback' : 'regex' };
}
