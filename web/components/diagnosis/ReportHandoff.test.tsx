// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReportHandoff from './ReportHandoff';
import type { ReportHandoffData } from '@/lib/report-handoff';
let uiLang = 'en';
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: uiLang }) }));

const data: ReportHandoffData = {
  notices: ['Review before manual transfer.'],
  drafts: ['notion', 'slack', 'wiki', 'devops', 'security', 'finops'].map(target => ({
    target, label: target, text: `Draft for ${target}`, filename: `${target}.md`,
  })),
};
const writeText = vi.fn();
const click = vi.fn();
beforeEach(() => {
  uiLang = 'en';
  writeText.mockReset().mockResolvedValue(undefined);
  click.mockReset();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network allowed'); }));
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:local-draft'), revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ReportHandoff', () => {
  it('previews six formats without copying, downloading or invoking anything automatically', async () => {
    render(<ReportHandoff handoff={data} />);
    expect(screen.getAllByRole('option')).toHaveLength(6);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Draft for notion');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'security' } });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Draft for security');
    expect(writeText).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Copy draft/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Draft for security'));
    expect((await screen.findByRole('status')).textContent).toMatch(/Copied/i);
  });
  it('downloads only on explicit click, using a local blob', () => {
    render(<ReportHandoff handoff={data} />);
    fireEvent.click(screen.getByRole('button', { name: /Download draft/i }));
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports clipboard rejection and clears stale feedback when the report changes', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const { rerender } = render(<ReportHandoff handoff={data} />);
    fireEvent.click(screen.getByRole('button', { name: /Copy draft/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Copy failed/i);
    rerender(<ReportHandoff handoff={{ ...data, drafts: [{ ...data.drafts[0], text: 'Next report' }] }} />);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Next report');
  });
  it('explains missing draft evidence without export controls', () => {
    render(<ReportHandoff handoff={null} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });
  it.each([['ko', '초안 복사'], ['zh', '复制草稿'], ['ja', '下書きをコピー']])('localizes controls in %s', (lang, copyLabel) => {
    uiLang = lang;
    render(<ReportHandoff handoff={data} />);
    expect(screen.getByRole('button', { name: copyLabel })).toBeTruthy();
  });
});
