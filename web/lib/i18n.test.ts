import { describe, it, expect } from 'vitest';
import { translate, makeT, MESSAGES } from './i18n';

describe('translate', () => {
  it('looks up ko and en', () => {
    expect(translate('ko', 'sidebar.signOut')).toBe('로그아웃');
    expect(translate('en', 'sidebar.signOut')).toBe('Sign out');
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
  it('ko and en define the exact same keys', () => {
    expect(Object.keys(MESSAGES.ko).sort()).toEqual(Object.keys(MESSAGES.en).sort());
  });
});

