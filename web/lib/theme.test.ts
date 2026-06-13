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
  it('exposes the three themes and a cobalt default', () => {
    expect(THEMES).toEqual(['teal', 'cobalt', 'teal-console']);
    expect(DEFAULT_THEME).toBe('cobalt');
    expect(THEME_LABELS['teal-console']).toBe('Console');
  });

  it('isTheme validates membership', () => {
    expect(isTheme('cobalt')).toBe(true);
    expect(isTheme('nope')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('getStoredTheme returns default when unset or invalid', () => {
    expect(getStoredTheme()).toBe('cobalt');
    localStorage.setItem(STORAGE_KEY, 'bogus');
    expect(getStoredTheme()).toBe('cobalt');
  });

  it('setStoredTheme + getStoredTheme round-trips', () => {
    setStoredTheme('cobalt');
    expect(getStoredTheme()).toBe('cobalt');
  });

  it('applyTheme sets the data-theme attribute on <html>', () => {
    applyTheme('teal-console');
    expect(document.documentElement.getAttribute('data-theme')).toBe('teal-console');
  });
});
