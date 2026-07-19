import { describe, it, expect } from 'vitest';
import { translate, makeT, MESSAGES, HTML_LANG, LANGUAGE_OPTIONS, LOCALES, isLang } from './i18n';

describe('translate', () => {
  it('looks up all four supported languages', () => {
    expect(translate('ko', 'sidebar.signOut')).toBe('로그아웃');
    expect(translate('en', 'sidebar.signOut')).toBe('Sign out');
    expect(translate('zh', 'sidebar.signOut')).toBe('退出登录');
    expect(translate('ja', 'sidebar.signOut')).toBe('ログアウト');
  });

  it('has the Integrations hub nav key in every locale', () => {
    expect(translate('ko', 'nav.integrations')).toBe('연동');
    expect(translate('en', 'nav.integrations')).toBe('Integrations');
    expect(translate('zh', 'nav.integrations')).toBe('集成');
    expect(translate('ja', 'nav.integrations')).toBe('連携');
  });
  it('falls back to en for a key missing in ko, then to the key itself', () => {
    // every key exists in both today, so simulate via a definitely-absent key
    expect(translate('ko', 'definitely.absent.key')).toBe('definitely.absent.key');
    expect(translate('en', 'definitely.absent.key')).toBe('definitely.absent.key');
  });
  it('interpolates {param} and leaves unknown placeholders intact', () => {
    expect(translate('en', 'sidebar.statusLine', { status: 'Online' })).toBe('ap-northeast-2 · Online');
    expect(translate('ko', 'sidebar.statusLine', { status: '온라인' })).toBe('ap-northeast-2 · 온라인');
    expect(translate('en', 'sidebar.statusLine')).toBe('ap-northeast-2 · {status}'); // no params → raw
  });
});

describe('makeT', () => {
  it('binds a language', () => {
    const t = makeT('en');
    expect(t('nav.topology')).toBe('Topology');
    expect(makeT('ko')('nav.topology')).toBe('토폴로지');
  });
});

describe('keyset parity (regression guard)', () => {
  it('ko, zh and ja define the exact same keys as en', () => {
    const expected = Object.keys(MESSAGES.en).sort();
    expect(Object.keys(MESSAGES.ko).sort()).toEqual(expected);
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(expected);
    expect(Object.keys(MESSAGES.ja).sort()).toEqual(expected);
  });

  it('nav.datasources exists in every locale (Explore page)', () => {
    expect(translate('ko', 'nav.datasources')).toBe('데이터소스');
    expect(translate('en', 'nav.datasources')).toBe('Datasources');
    expect(translate('zh', 'nav.datasources')).toBe('数据源');
    expect(translate('ja', 'nav.datasources')).toBe('データソース');
  });
});

describe('language metadata', () => {
  it('defines selector and Intl metadata for exactly four languages', () => {
    expect(LANGUAGE_OPTIONS.map((x) => x.code)).toEqual(['ko', 'en', 'zh', 'ja']);
    expect(HTML_LANG).toEqual({ ko: 'ko', en: 'en', zh: 'zh-CN', ja: 'ja' });
    expect(LOCALES.ja).toBe('ja-JP');
  });

  it('validates only supported language values', () => {
    for (const code of ['ko', 'en', 'zh', 'ja']) expect(isLang(code)).toBe(true);
    expect(isLang('fr')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

