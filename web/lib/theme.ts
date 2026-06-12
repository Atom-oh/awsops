export const THEMES = ['teal', 'cobalt', 'teal-console'] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = 'teal';
export const STORAGE_KEY = 'awsops-theme';
export const THEME_EVENT = 'awsops:themechange';

export const THEME_LABELS: Record<Theme, string> = {
  teal: 'Teal',
  cobalt: 'Cobalt',
  'teal-console': 'Console',
};

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore (private mode / SSR) */
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  if (typeof window !== 'undefined') {
    try { window.dispatchEvent(new Event(THEME_EVENT)); } catch { /* no-op */ }
  }
}
