import type { Lang } from '@/lib/i18n';
// Each row keeps ko/en/zh/ja translations together; the public typed locale map is unchanged.
const TEXT = {
  toolCapHint: ["선택한 모든 에이전트에 같은 목록을 적용합니다. 게이트웨이 도구는 해당 게이트웨이 안의 고유한 별칭도 허용하지만 통합 도구는 노출된 이름과 정확히 일치해야 합니다. 빈 입력은 추가 상한이 없다는 뜻이며, 입력한 목록과 일치하는 도구가 없으면 차단합니다. 정책 허용은 실제 접속 성공을 뜻하지 않습니다.", "This list applies to every selected agent. Gateway tools accept unambiguous aliases within their gateway; integration tools require exact exposed names. Empty means no additional cap; a list with no matching tools denies them all. Policy eligibility does not prove connectivity.", "此列表适用于所有选定代理。网关工具支持网关内无歧义的别名；集成工具须与暴露名称完全匹配。留空表示无额外上限；列表没有匹配工具时全部拒绝。策略允许不代表连接成功。", "同じリストを選択した全エージェントに適用します。ゲートウェイ内で一意なツール別名は使用できますが、連携ツールは公開名と完全一致が必要です。空欄は追加上限なし、入力したリストに一致がなければ全ツールを拒否します。ポリシー上の許可は接続成功を意味しません。"],
  integrationHint: ["지원하는 egress/ingress 유형만 등록합니다. 새 항목은 비활성이며 자격증명·도구 노출·실행 게이트 설정은 별도입니다. custom_mcp는 폐기되었습니다.", "Register supported egress/ingress kinds only. New rows are disabled; credentials, exposed tools and runtime gates require separate configuration. custom_mcp is retired.", "仅注册支持的 egress/ingress 类型。新记录默认禁用；凭证、工具暴露和运行开关须另外配置。custom_mcp 已退役。", "対応する egress/ingress 種類のみ登録します。新規行は無効で、認証情報・ツール公開・実行ゲートは別途設定が必要です。custom_mcp は廃止されています。"],
  catalogUnavailable: ["에이전트 카탈로그를 일시적으로 불러올 수 없습니다. 페이지를 새로고침하여 다시 시도하세요.", "Agent catalog is temporarily unavailable. Refresh the page to retry.", "暂时无法加载代理目录。请刷新页面重试。", "エージェントカタログを一時的に読み込めません。ページを再読み込みして再試行してください。"],
  reservedAgentName: ["기본 채팅 라우팅에 예약된 이름입니다. 다른 이름을 선택하세요.", "This name is reserved for built-in chat routing. Choose another name.", "此名称已保留用于内置聊天路由。请选择其他名称。", "この名前は組み込みチャットルーティング用に予約されています。別の名前を選んでください。"],
  agentHint: ["기본 게이트웨이 하나와 라우팅 키워드를 지정하세요. 채팅은 서버 모델과 선택한 UI 언어를 사용합니다.", "Use one primary gateway and routing keywords. Chat uses the server model and your selected UI language.", "请选择一个主网关并设置路由关键词。聊天使用服务器模型和所选界面语言。", "プライマリゲートウェイを1つ選び、ルーティングキーワードを指定してください。チャットはサーバーのモデルと選択したUI言語を使用します。"],
  skillHint: ["스킬을 생성하고 활성화한 뒤 아래 커스텀 에이전트에 연결하세요. 연결한 스킬은 해당 에이전트가 활성화된 모든 계정에 적용됩니다. 선언이나 유지된 제한이 없는 스킬은 기존 게이트웨이 읽기 도구를 사용하며 계정 상한은 이를 좁힙니다. 선언·철회된 제한의 교집합이 비면 도구를 허용하지 않습니다. 정책상 0개이면 채팅에 안내하며 실제 도구 검색·배포 상태와는 구분합니다.", "Create and enable the skill, then attach it to a custom agent below. Attached skills apply wherever that agent is enabled. Without declarations or a retained restriction, skills use existing gateway read tools; the account cap narrows them. Empty declared/revoked intersections deny all tools. Chat discloses a policy zero; it is not a live discovery or deployment count.", "创建并启用技能，然后将其关联到下方的自定义代理。关联的技能适用于启用了该代理的所有账户。 没有工具声明或保留限制时，技能使用现有网关只读工具，账户上限进一步缩小范围。已声明或已撤销限制的交集为空时拒绝所有工具。聊天会说明策略允许零工具；这不是实时发现或部署数量。", "スキルを作成して有効にし、下のカスタムエージェントに関連付けてください。関連付けたスキルは、そのエージェントが有効なすべてのアカウントに適用されます。 宣言や保持された制限がなければ既存ゲートウェイの読取ツールを使い、アカウント上限で絞ります。宣言・失効した制限との積集合が空なら全ツールを拒否します。ポリシー上0件の場合はチャットで案内し、ライブ検出・デプロイ数とは区別します。"],
  skills: ["스킬", "Skills", "技能", "スキル"],
  skillFor: ["{agent}에 연결할 스킬", "Skill for {agent}", "用于 {agent} 的技能", "{agent} に関連付けるスキル"],
  selectSkill: ["활성화된 스킬 선택", "Select an enabled skill", "选择已启用的技能", "有効なスキルを選択"],
  attach: ["스킬 연결", "Attach skill", "关联技能", "スキルを関連付ける"],
  attachTo: ["{agent}에 스킬 연결", "Attach skill to {agent}", "将技能关联到 {agent}", "{agent} にスキルを関連付ける"],
  attached: ["{agent}에 스킬을 연결했습니다.", "Skill attached to {agent}.", "已将技能关联到 {agent}。", "{agent} にスキルを関連付けました。"],
  attachedRefreshFailed: ["{agent}에 스킬을 연결했습니다. 일부 정보를 새로고침하지 못했습니다. 페이지를 다시 불러오세요.", "Skill attached to {agent}. Some details could not be refreshed; reload the page.", "已将技能关联到 {agent}。部分信息未能刷新，请重新加载页面。", "{agent} にスキルを関連付けました。一部の情報を更新できなかったため、ページを再読み込みしてください。"],
  attachmentFailed: ["오류: 스킬을 연결하지 못했습니다. 다시 시도하세요.", "Error: Could not attach skill. Try again.", "错误：无法关联技能。请重试。", "エラー：スキルを関連付けられませんでした。再試行してください。"],
  attachmentForbidden: ["오류: 관리자 권한과 커스텀 에이전트가 필요합니다.", "Error: Admin access and a custom agent are required.", "错误：需要管理员权限，且目标必须是自定义代理。", "エラー：管理者権限とカスタムエージェントが必要です。"],
  attachmentMissing: ["오류: 에이전트 또는 스킬을 찾을 수 없습니다. 페이지를 새로고침하세요.", "Error: Agent or skill not found. Refresh the page.", "错误：找不到代理或技能。请刷新页面。", "エラー：エージェントまたはスキルが見つかりません。ページを再読み込みしてください。"],
  skillDisabled: ["오류: 스킬이 비활성 상태입니다. 먼저 스킬을 활성화하세요.", "Error: Skill is disabled. Enable it first.", "错误：技能已停用。请先启用技能。", "エラー：スキルは無効です。先に有効にしてください。"],
} satisfies Record<string, [string, string, string, string]>;
type CustomizationCopy = Record<keyof typeof TEXT, string>;
const locale = (index: number) => Object.fromEntries(Object.entries(TEXT).map(([key, values]) => [key, values[index]])) as CustomizationCopy;
export const CUSTOMIZATION_COPY: Record<Lang, CustomizationCopy> = {
  ko: locale(0), en: locale(1), zh: locale(2), ja: locale(3),
};
