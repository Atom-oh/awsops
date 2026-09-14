// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/components/shell/LanguageProvider';
import { normalizeEvidence } from '@/lib/chat-evidence';
import EvidenceStatus from './EvidenceStatus';
afterEach(() => { cleanup(); localStorage.clear(); });
it.each([
  ['en', 'Some evidence omitted', ['Available', 'No results', 'Incomplete', 'Unavailable', 'Failed', 'Unknown']],
  ['ko', '일부 근거 생략', ['사용 가능', '결과 없음', '불완전', '사용 불가', '실패', '알 수 없음']],
])('localizes %s source statuses and receipt-local omission after restore', (lang, omitted, states) => {
  localStorage.setItem('awsops-lang', lang as string);
  const raw = { version: 1, status: 'success', domains: [{ gateway: 'network', status: 'success',
    completion: { version: 1, receiptCount: 1 }, receipts: [{ version: 1, callId: 'a', tool: 'inspect',
      observedAt: 1000, terminalObservedAt: 2000, outcome: 'success', quality: { collection: {
        status: 'ok', sources: ['ok', 'empty', 'partial', 'unavailable', 'error', 'unknown', 'ok', 'ok', 'error']
          .map((status, i) => ({ sourceId: `source_${i}`, status })),
      } },
    }] }] };
  const evidence = normalizeEvidence(normalizeEvidence(raw));
  render(<LanguageProvider><EvidenceStatus evidence={evidence} /></LanguageProvider>);
  expect(screen.getByText(omitted as string)).toBeTruthy();
  for (let i = 0; i < 6; i++) expect(screen.getByText(new RegExp(`source_${i} \\(${states[i]};`))).toBeTruthy();
  expect(screen.queryByText(/source_8/)).toBeNull();
});
