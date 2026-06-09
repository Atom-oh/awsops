// src/lib/ai-cost/heuristic-classifier.ts
// Deterministic, LLM-free pre-filter for the AI router (ADR-033 Phase 1).
// Returns a confident route ONLY when exactly one domain matches; otherwise null
// (caller falls back to the LLM classifier). Never guesses on ambiguity.
export type Confidence = 'high' | 'low';
export interface HeuristicResult { routes: string[]; confidence: Confidence; }

// Keyword → route. Listing/status verbs route to aws-data; domain nouns to gateways.
// Kept intentionally small + high-precision; recall gaps fall through to the LLM.
// NOTE: ASCII \b word boundaries break on Korean (non-ASCII) keywords in JS regex
// (e.g. /\b비용\b/ never matches), so these rules use unanchored alternations.
const RULES: Array<{ route: string; any: RegExp }> = [
  { route: 'cost',     any: /(비용|cost|요금|billing|예산|budget|savings|finops)/i },
  { route: 'security', any: /(보안|security|iam|취약|cve|컴플라이언스|compliance|mfa)/i },
  { route: 'network',  any: /(reachability|flow ?log|tgw|transit gateway|vpn|방화벽|firewall)/i },
  { route: 'container',any: /(istio|kubectl|kubelet|crashloop|oomkill|파드 장애|eks 트러블)/i },
  { route: 'cost',     any: /(rightsizing|유휴 리소스|idle)/i },
];
// Listing/status → aws-data (Steampipe). High precision verbs only.
const AWS_DATA = /(목록|리스트|몇\s*개|현황|status|list|보여줘|조회)/i;

export function heuristicClassify(text: string): HeuristicResult | null {
  if (!text || text.trim().length < 2) return null;
  const matched = new Set<string>();
  for (const r of RULES) if (r.any.test(text)) matched.add(r.route);
  if (matched.size > 1) return null;             // ambiguous → defer to LLM
  if (matched.size === 1) return { routes: Array.from(matched), confidence: 'high' };
  if (AWS_DATA.test(text)) return { routes: ['aws-data'], confidence: 'high' };
  return null;                                    // no confident match → defer to LLM
}
