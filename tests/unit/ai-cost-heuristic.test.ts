// tests/unit/ai-cost-heuristic.test.ts
import { describe, it, expect } from 'vitest';
import { heuristicClassify } from '@/lib/ai-cost/heuristic-classifier';

describe('heuristicClassify', () => {
  it('classifies a clear listing question to aws-data with high confidence', () => {
    expect(heuristicClassify('EC2 인스턴스 목록 보여줘')).toEqual({ routes: ['aws-data'], confidence: 'high' });
  });
  it('classifies an obvious cost question to cost', () => {
    expect(heuristicClassify('이번 달 비용 분석해줘')).toEqual({ routes: ['cost'], confidence: 'high' });
  });
  it('returns null (defer to LLM) when no confident keyword match', () => {
    expect(heuristicClassify('이거 좀 이상한데 왜 그럴까')).toBeNull();
  });
  it('returns null (defer to LLM) when two domains both match — ambiguous', () => {
    // both network and cost keywords present → not safe to decide heuristically
    expect(heuristicClassify('VPC 보안그룹과 비용을 같이 분석')).toBeNull();
  });
});
