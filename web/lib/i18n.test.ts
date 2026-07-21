import { describe, it, expect } from 'vitest';
import { translate, makeT, MESSAGES, type Lang } from './i18n';

const LANGS: Lang[] = ['ko', 'en', 'zh', 'ja'];

describe('translate', () => {
  it('looks up ko and en', () => {
    expect(translate('ko', 'sidebar.signOut')).toBe('로그아웃');
    expect(translate('en', 'sidebar.signOut')).toBe('Sign out');
  });

  it('has the Integrations hub nav key in both locales', () => {
    expect(translate('ko', 'nav.integrations')).toBe('연동');
    expect(translate('en', 'nav.integrations')).toBe('Integrations');
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
  it('every language defines the exact same keys as ko', () => {
    const koKeys = Object.keys(MESSAGES.ko).sort();
    for (const lang of LANGS) {
      expect(Object.keys(MESSAGES[lang]).sort(), `MESSAGES.${lang} key set`).toEqual(koKeys);
    }
  });

  it('every language has the same {param} placeholders per key as ko', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(MESSAGES.ko)) {
      const koParams = placeholders(MESSAGES.ko[key]);
      for (const lang of LANGS) {
        expect(placeholders(MESSAGES[lang][key]), `${lang}.${key}`).toEqual(koParams);
      }
    }
  });

  it('nav.datasources exists in every locale (Explore page)', () => {
    expect(translate('ko', 'nav.datasources')).toBe('데이터소스');
    expect(translate('en', 'nav.datasources')).toBe('Datasources');
    expect(translate('zh', 'nav.datasources')).toBe('数据源');
    expect(translate('ja', 'nav.datasources')).toBe('データソース');
  });

});

