// Lightweight i18n core (pure, no React) for the shell/nav chrome. KO default, EN toggle.
// MVP scope: shell + navigation strings only (not the inventory catalog or page bodies).

export type Lang = 'ko' | 'en';
type Dict = Record<string, string>;

const MESSAGES: Record<Lang, Dict> = {
  ko: {
    'nav.overview': '개요',
    'nav.aiDiagnosis': 'AI 진단',
    'nav.assistant': '어시스턴트',
    'nav.eks': 'EKS',
    'nav.jobs': '작업',
    'nav.cost': '비용',
    'nav.bedrock': 'Bedrock',
    'nav.topology': '토폴로지',
    'nav.opencost': 'OpenCost',
    'nav.customAgents': '커스텀 에이전트',
    'sidebar.tagline': '클라우드 운영',
    'sidebar.admin': '관리자',
    'sidebar.signOut': '로그아웃',
    'sidebar.online': '온라인',
    'sidebar.statusLine': 'ap-northeast-2 · {status}',
    'palette.aria': '명령 팔레트',
    'palette.placeholder': '페이지 또는 리소스 검색…',
    'palette.noResults': '결과 없음',
    'lang.toggle': 'EN',
    'lang.toggleTitle': 'English',
  },
  en: {
    'nav.overview': 'Overview',
    'nav.aiDiagnosis': 'AI Diagnosis',
    'nav.assistant': 'Assistant',
    'nav.eks': 'EKS',
    'nav.jobs': 'Jobs',
    'nav.cost': 'Cost',
    'nav.bedrock': 'Bedrock',
    'nav.topology': 'Topology',
    'nav.opencost': 'OpenCost',
    'nav.customAgents': 'Custom Agents',
    'sidebar.tagline': 'Cloud Operations',
    'sidebar.admin': 'Admin',
    'sidebar.signOut': 'Sign out',
    'sidebar.online': 'Online',
    'sidebar.statusLine': 'ap-northeast-2 · {status}',
    'palette.aria': 'Command palette',
    'palette.placeholder': 'Search pages or resources…',
    'palette.noResults': 'No results',
    'lang.toggle': '한',
    'lang.toggleTitle': '한국어',
  },
};

/** Resolve a key for a language: lang → EN fallback → the key itself. Supports {param} interpolation. */
export function translate(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const raw = MESSAGES[lang]?.[key] ?? MESSAGES.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

/** Bind a translator to a language. */
export function makeT(lang: Lang) {
  return (key: string, params?: Record<string, string | number>) => translate(lang, key, params);
}

export const MESSAGE_KEYS = Object.keys(MESSAGES.en);
export { MESSAGES };
