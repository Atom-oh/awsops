import type { Lang } from '@/lib/i18n';

interface CustomizationCopy {
  agentHint: string;
  reservedAgentName: string;
  catalogUnavailable: string;
  skillHint: string;
  skills: string;
  skillFor: string;
  selectSkill: string;
  attach: string;
  attachTo: string;
  attached: string;
  attachmentFailed: string;
  attachmentForbidden: string;
  attachmentMissing: string;
  skillDisabled: string;
}

export const CUSTOMIZATION_COPY: Record<Lang, CustomizationCopy> = {
  ko: {
    catalogUnavailable: '에이전트 카탈로그를 일시적으로 불러올 수 없습니다. 페이지를 새로고침하여 다시 시도하세요.',
    reservedAgentName: '기본 채팅 라우팅에 예약된 이름입니다. 다른 이름을 선택하세요.',
    agentHint: '기본 게이트웨이 하나와 라우팅 키워드를 지정하세요. 채팅은 서버 모델과 선택한 UI 언어를 사용합니다.',
    skillHint: '스킬을 생성하고 활성화한 뒤 아래 커스텀 에이전트에 연결하세요. 연결한 스킬은 해당 에이전트가 활성화된 모든 계정에 적용됩니다.',
    skills: '스킬',
    skillFor: '{agent}에 연결할 스킬',
    selectSkill: '활성화된 스킬 선택',
    attach: '스킬 연결',
    attachTo: '{agent}에 스킬 연결',
    attached: '{agent}에 스킬을 연결했습니다.',
    attachmentFailed: '오류: 스킬을 연결하지 못했습니다. 다시 시도하세요.',
    attachmentForbidden: '오류: 관리자 권한과 커스텀 에이전트가 필요합니다.',
    attachmentMissing: '오류: 에이전트 또는 스킬을 찾을 수 없습니다. 페이지를 새로고침하세요.',
    skillDisabled: '오류: 스킬이 비활성 상태입니다. 먼저 스킬을 활성화하세요.',
  },
  en: {
    catalogUnavailable: 'Agent catalog is temporarily unavailable. Refresh the page to retry.',
    reservedAgentName: 'This name is reserved for built-in chat routing. Choose another name.',
    agentHint: 'Use one primary gateway and routing keywords. Chat uses the server model and your selected UI language.',
    skillHint: 'Create and enable the skill, then attach it to a custom agent below. Attached skills apply wherever that agent is enabled.',
    skills: 'Skills',
    skillFor: 'Skill for {agent}',
    selectSkill: 'Select an enabled skill',
    attach: 'Attach skill',
    attachTo: 'Attach skill to {agent}',
    attached: 'Skill attached to {agent}.',
    attachmentFailed: 'Error: Could not attach skill. Try again.',
    attachmentForbidden: 'Error: Admin access and a custom agent are required.',
    attachmentMissing: 'Error: Agent or skill not found. Refresh the page.',
    skillDisabled: 'Error: Skill is disabled. Enable it first.',
  },
  zh: {
    catalogUnavailable: '暂时无法加载代理目录。请刷新页面重试。',
    reservedAgentName: '此名称已保留用于内置聊天路由。请选择其他名称。',
    agentHint: '请选择一个主网关并设置路由关键词。聊天使用服务器模型和所选界面语言。',
    skillHint: '创建并启用技能，然后将其关联到下方的自定义代理。关联的技能适用于启用了该代理的所有账户。',
    skills: '技能',
    skillFor: '用于 {agent} 的技能',
    selectSkill: '选择已启用的技能',
    attach: '关联技能',
    attachTo: '将技能关联到 {agent}',
    attached: '已将技能关联到 {agent}。',
    attachmentFailed: '错误：无法关联技能。请重试。',
    attachmentForbidden: '错误：需要管理员权限，且目标必须是自定义代理。',
    attachmentMissing: '错误：找不到代理或技能。请刷新页面。',
    skillDisabled: '错误：技能已停用。请先启用技能。',
  },
  ja: {
    catalogUnavailable: 'エージェントカタログを一時的に読み込めません。ページを再読み込みして再試行してください。',
    reservedAgentName: 'この名前は組み込みチャットルーティング用に予約されています。別の名前を選んでください。',
    agentHint: 'プライマリゲートウェイを1つ選び、ルーティングキーワードを指定してください。チャットはサーバーのモデルと選択したUI言語を使用します。',
    skillHint: 'スキルを作成して有効にし、下のカスタムエージェントに関連付けてください。関連付けたスキルは、そのエージェントが有効なすべてのアカウントに適用されます。',
    skills: 'スキル',
    skillFor: '{agent} に関連付けるスキル',
    selectSkill: '有効なスキルを選択',
    attach: 'スキルを関連付ける',
    attachTo: '{agent} にスキルを関連付ける',
    attached: '{agent} にスキルを関連付けました。',
    attachmentFailed: 'エラー：スキルを関連付けられませんでした。再試行してください。',
    attachmentForbidden: 'エラー：管理者権限とカスタムエージェントが必要です。',
    attachmentMissing: 'エラー：エージェントまたはスキルが見つかりません。ページを再読み込みしてください。',
    skillDisabled: 'エラー：スキルは無効です。先に有効にしてください。',
  },
};
