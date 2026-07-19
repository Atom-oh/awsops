// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider, useI18n } from './LanguageProvider';
import LanguageToggle from './LanguageToggle';

function Probe() {
  const { t } = useI18n();
  return <span>{t('nav.overview')}</span>;
}

function renderLanguageUi() {
  return render(
    <LanguageProvider>
      <LanguageToggle />
      <Probe />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'ko';
});
afterEach(cleanup);

describe('LanguageProvider and LanguageToggle', () => {
  it('offers Korean, English, Chinese and Japanese', () => {
    renderLanguageUi();
    const select = screen.getByRole('combobox', { name: '언어' }) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['ko', 'en', 'zh', 'ja']);
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(['KO', 'EN', '中文', '日本語']);
  });

  it('changes translated copy, persists the choice and updates html lang', () => {
    renderLanguageUi();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'zh' } });

    expect(screen.getByText('概览')).toBeTruthy();
    expect(localStorage.getItem('awsops-lang')).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('restores a saved Japanese preference after mount', async () => {
    localStorage.setItem('awsops-lang', 'ja');
    renderLanguageUi();

    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('ja'));
    expect(screen.getByText('概要')).toBeTruthy();
    expect(document.documentElement.lang).toBe('ja');
  });
});
