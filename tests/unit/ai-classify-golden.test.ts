// tests/unit/ai-classify-golden.test.ts
import { describe, it, expect } from 'vitest';
import golden from '../fixtures/golden-questions.json';
import { heuristicClassify } from '@/lib/ai-cost/heuristic-classifier';

describe('classification SLO (golden set)', () => {
  it('heuristic high-confidence hits meet the accuracy SLO (else keep Sonnet fallback)', () => {
    let decided = 0, correct = 0;
    for (const c of golden.cases) {
      const r = heuristicClassify(c.q);
      if (r && r.confidence === 'high') {
        decided++;
        if (r.routes[0] === c.route) correct++;
      }
    }
    // Of the questions the heuristic CONFIDENTLY decided, accuracy must clear the SLO.
    // A confident-but-wrong rate above (1 - SLO) means the heuristic is too aggressive
    // → tighten RULES (the LLM fallback still covers the undecided ones safely).
    const accuracy = decided === 0 ? 1 : correct / decided;
    expect(accuracy).toBeGreaterThanOrEqual(golden.sloAccuracy);
  });
});
