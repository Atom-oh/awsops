// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEMES, DEFAULT_THEME, THEME_LABELS, isTheme,
  getStoredTheme, setStoredTheme, applyTheme, STORAGE_KEY,
} from './theme';

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme model', () => {
  it('exposes the three themes and a teal default', () => {
    expect(THEMES).toEqual(['teal', 'azure', 'teal-console']);
    expect(DEFAULT_THEME).toBe('teal');
    expect(THEME_LABELS['teal-console']).toBe('Console');
  });

  it('isTheme validates membership', () => {
    expect(isTheme('azure')).toBe(true);
    expect(isTheme('nope')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('getStoredTheme returns default when unset or invalid', () => {
    expect(getStoredTheme()).toBe('teal');
    localStorage.setItem(STORAGE_KEY, 'bogus');
    expect(getStoredTheme()).toBe('teal');
  });

  it('setStoredTheme + getStoredTheme round-trips', () => {
    setStoredTheme('azure');
    expect(getStoredTheme()).toBe('azure');
  });

  it('applyTheme sets the data-theme attribute on <html>', () => {
    applyTheme('teal-console');
    expect(document.documentElement.getAttribute('data-theme')).toBe('teal-console');
  });
});
