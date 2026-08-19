// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import FinopsBaselineCard from './FinopsBaselineCard';

function mockFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FinopsBaselineCard', () => {
  it('renders nothing when the feature is disabled (enabled:false)', async () => {
    vi.stubGlobal('fetch', mockFetch({ enabled: false, findings: [], lastRun: null }));
    const { container } = render(<FinopsBaselineCard />);
    await waitFor(() => expect(container.querySelector('[data-testid="finops-baseline-card"]')).toBeNull());
  });

  it('shows the never-ran empty state when enabled with no runs yet', async () => {
    vi.stubGlobal('fetch', mockFetch({ enabled: true, findings: [], lastRun: null }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-empty'));
    expect(screen.getByText('아직 배치가 실행되지 않았습니다 — 다음 일일 배치를 기다려주세요.')).toBeTruthy();
  });

  it('shows the "no waste found" empty state when a run happened but found nothing', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'succeeded', rulesEvaluated: 2, findingsCount: 0, ceApiCalls: 1, error: null },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-empty'));
    expect(screen.getByText('현재 발견된 상시 낭비 항목이 없습니다.')).toBeTruthy();
  });

  it('shows a failed-batch error instead of an empty state', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'failed', rulesEvaluated: 1, findingsCount: 0, ceApiCalls: 0, error: 'AccessDenied' },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-error'));
    expect(screen.getByText(/AccessDenied/)).toBeTruthy();
  });

  it('renders findings and shows a needs_review item\'s null savings as "산출 불가" (never $0)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 2, findingsCount: 2, ceApiCalls: 1, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'active', monthlySavingsUsd: 9.12, evidence: {}, guardHits: [], explanationKo: '연결 안 된 볼륨입니다', firstSeenAt: 'a', lastSeenAt: 'b' },
        { id: 2, ruleId: 'ec2_rightsizing', resourceId: 'arn:x', title: 'EC2 rightsizing arn:x', category: 'compute',
          status: 'needs_review', monthlySavingsUsd: null, evidence: {}, guardHits: ['protected_tag:dr'], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.getByText('$9.12/mo')).toBeTruthy();
    expect(screen.getByText('연결 안 된 볼륨입니다')).toBeTruthy();
    expect(screen.getByText('EC2 rightsizing arn:x')).toBeTruthy();
    expect(screen.getByText('금액 산출 불가')).toBeTruthy(); // NOT $0.00 for the null item
    expect(screen.getByText(/protected_tag:dr/)).toBeTruthy();
    // header total counts only the 'active' item; the needs_review item (even though it's shown
    // in the list) is excluded from both the total AND the "N건 금액 산출 불가" callout — that
    // callout is specifically about active-but-unpriced items, not guard-flagged ones.
    expect(screen.getByTestId('finops-baseline-total').textContent).toContain('9.12');
    expect(screen.queryByText(/건 금액 산출 불가/)).toBeNull();
  });

  it('does not let a needs_review finding inflate the headline total (stale/guarded amounts excluded)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 2, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'active', monthlySavingsUsd: 9.12, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
        // Stale evidence (guard-flagged) but still carries a real dollar figure from before the
        // sync went stale — this must NOT be added into the $9.12 confident total.
        { id: 2, ruleId: 'ebs_unattached', resourceId: 'vol-2', title: 'Unattached EBS vol-2', category: 'storage',
          status: 'needs_review', monthlySavingsUsd: 500.00, evidence: {}, guardHits: ['stale_inventory_data'],
          explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-2'));
    expect(screen.getByTestId('finops-baseline-total').textContent).toContain('9.12');
    expect(screen.getByTestId('finops-baseline-total').textContent).not.toContain('509');
    expect(screen.getByText(/stale_inventory_data/)).toBeTruthy();
  });

  it('hides the headline total entirely when every finding is needs_review (nothing confident)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'needs_review', monthlySavingsUsd: 42.0, evidence: {}, guardHits: ['stale_inventory_data'],
          explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.queryByTestId('finops-baseline-total')).toBeNull();
  });

  it('shows "산출 불가" instead of a fabricated $0.00 when every active finding has unknown savings', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        // 'active' (confident) but with no known amount — reduce()'s `?? 0` would otherwise sum
        // this to a misleading $0.00 "confirmed zero savings" headline.
        { id: 1, ruleId: 'ec2_rightsizing', resourceId: 'arn:x', title: 'EC2 rightsizing arn:x', category: 'compute',
          status: 'active', monthlySavingsUsd: null, evidence: {}, guardHits: [], explanationKo: null,
          firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('EC2 rightsizing arn:x'));
    const total = screen.getByTestId('finops-baseline-total');
    expect(total.textContent).not.toContain('$0.00');
    expect(total.textContent).toContain('금액 산출 불가');
  });
});
