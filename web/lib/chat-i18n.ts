// v1-parity chat-path i18n (v1 src/app/api/ai/route.ts:932-953 pick(en,ko,zh)): server-issued
// guide/system strings follow the user's UI language, not hardcoded Korean. Pure data + one pick.

export type ChatLang = 'ko' | 'en' | 'zh';

export function normalizeChatLang(v: unknown): ChatLang {
  return v === 'en' || v === 'zh' ? v : 'ko';
}

type L10n = Record<ChatLang, string>;

const M = {
  unavailablePin: {
    ko: (name: string) => `🔒 선택한 에이전트 '${name}'는 이 Agent Space에서 사용할 수 없습니다(비활성화되었거나 존재하지 않음). 다른 에이전트를 선택하거나 자동 라우팅으로 다시 시도해 주세요.`,
    en: (name: string) => `🔒 The selected agent '${name}' is not available in this Agent Space (disabled or missing). Pick another agent or retry with automatic routing.`,
    zh: (name: string) => `🔒 所选智能体“${name}”在此 Agent Space 中不可用（已禁用或不存在）。请选择其他智能体，或使用自动路由重试。`,
  },
  inactiveSection: {
    ko: (label: string, alts: string) => `🔒 ${label} 에이전트는 P3에서 제공 예정입니다.` + (alts ? ` 활성 섹션(${alts}) 칩으로 다시 시도해 주세요.` : ' 활성 섹션으로 다시 시도해 주세요.'),
    en: (label: string, alts: string) => `🔒 The ${label} agent is coming in P3.` + (alts ? ` Retry with an active section chip (${alts}).` : ' Retry with an active section.'),
    zh: (label: string, alts: string) => `🔒 ${label} 智能体将在 P3 提供。` + (alts ? ` 请使用活动分区（${alts}）重试。` : ' 请使用活动分区重试。'),
  },
  allRoutesFailed: {
    ko: '모든 라우트가 실패했습니다',
    en: 'all routes failed',
    zh: '所有路由均失败',
  } as L10n,
  fallbackNotice: {
    ko: '⚠️ 실시간 에이전트 런타임에 연결하지 못해 일반 지식으로 답변합니다(계정 실데이터 미포함).\n\n',
    en: '⚠️ The live agent runtime is unreachable — answering from general knowledge (no live account data).\n\n',
    zh: '⚠️ 无法连接实时智能体运行时——以下回答基于通用知识（不含账户实时数据）。\n\n',
  } as L10n,
  codeExecHeader: {
    ko: '\n\n---\n**⚡ 실행 결과**\n',
    en: '\n\n---\n**⚡ Execution result**\n',
    zh: '\n\n---\n**⚡ 执行结果**\n',
  } as L10n,
  codeExecFailed: {
    ko: '\n\n_(샌드박스 실행에 실패해 코드만 제공합니다)_',
    en: '\n\n_(sandbox execution failed — providing the code only)_',
    zh: '\n\n_（沙箱执行失败，仅提供代码）_',
  } as L10n,
} as const;

export const chatMsg = {
  unavailablePin: (lang: ChatLang, name: string) => M.unavailablePin[lang](name),
  inactiveSection: (lang: ChatLang, label: string, alts: string) => M.inactiveSection[lang](label, alts),
  allRoutesFailed: (lang: ChatLang) => M.allRoutesFailed[lang],
  fallbackNotice: (lang: ChatLang) => M.fallbackNotice[lang],
  codeExecHeader: (lang: ChatLang) => M.codeExecHeader[lang],
  codeExecFailed: (lang: ChatLang) => M.codeExecFailed[lang],
};
