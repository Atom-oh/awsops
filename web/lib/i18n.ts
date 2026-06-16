// Lightweight i18n core (pure, no React) for the shell/nav chrome. KO default, EN toggle.
// MVP scope: shell + navigation strings only (not the inventory catalog or page bodies).

export type Lang = 'ko' | 'en';
type Dict = Record<string, string>;

const MESSAGES: Record<Lang, Dict> = {
  ko: {
    'nav.overview': '개요',
    'nav.aiDiagnosis': 'AI 진단',
    'nav.assistant': '어시스턴트',
    'nav.inventory': '인벤토리',
    'nav.more': '더보기',
    'nav.eks': 'EKS',
    'nav.jobs': '작업',
    'nav.cost': '비용',
    'nav.bedrock': 'Bedrock',
    'nav.topology': '토폴로지',
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
    'login.title': '로그인',
    'login.subtitle': 'Cloud Operations Dashboard',
    'login.email': '이메일',
    'login.password': '비밀번호',
    'login.remember': '로그인 유지',
    'login.submit': '로그인 →',
    'login.busy': '인증 중…',
    'login.secure': '보안 연결',
    'login.error.invalid_credentials': '이메일 또는 비밀번호가 올바르지 않습니다',
    'login.error.challenge': '계정 상태를 확인할 수 없습니다. 관리자에게 문의하세요',
    'login.error.unavailable': '일시적인 오류입니다. 잠시 후 다시 시도하세요',
  },
  en: {
    'nav.overview': 'Overview',
    'nav.aiDiagnosis': 'AI Diagnosis',
    'nav.assistant': 'Assistant',
    'nav.inventory': 'Inventory',
    'nav.more': 'More',
    'nav.eks': 'EKS',
    'nav.jobs': 'Jobs',
    'nav.cost': 'Cost',
    'nav.bedrock': 'Bedrock',
    'nav.topology': 'Topology',
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
    'login.title': 'Sign in',
    'login.subtitle': 'Cloud Operations Dashboard',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.remember': 'Keep me signed in',
    'login.submit': 'Sign in →',
    'login.busy': 'Authenticating…',
    'login.secure': 'Secure connection',
    'login.error.invalid_credentials': 'Invalid email or password',
    'login.error.challenge': 'Account requires attention. Contact your administrator',
    'login.error.unavailable': 'Temporary error. Try again shortly',
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
