// src/lib/ai-cost/model-tier.ts
// Confidence-based model + synthesis policy (ADR-033 Phase 1).
import type { HeuristicResult } from './heuristic-classifier';

export type ClassifierModelKey = 'haiku-4.5' | 'sonnet-4.6';

// When the heuristic is uncertain (low) we still avoid Sonnet: Haiku is ~cheap
// and good enough to confirm/repair a single-domain guess. Only the hardest
// case — no heuristic signal at all — escalates to Sonnet.
export function pickClassifierModel(heuristic: HeuristicResult | null): ClassifierModelKey {
  if (heuristic && heuristic.confidence === 'low') return 'haiku-4.5';
  return 'sonnet-4.6';
}

// Multi-route synthesis (ADR-025) is the expensive extra Bedrock call. A single
// high-confidence route never needs synthesis.
export function shouldSkipSynthesis(routes: string[], confidence: 'high' | 'low'): boolean {
  return routes.length === 1 && confidence === 'high';
}
