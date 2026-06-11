export interface Section {
  key: string;
  label: string;
  icon: string;
  color: string; // navy-theme accent (hex)
  active: boolean; // wired to a real gateway/tool today
  presets: string[]; // frequently-used starter questions
}

// Order = section-picker order. Colors from the v2 navy palette accents.
export const SECTIONS: Section[] = [
  { key: 'network', label: 'Network', icon: '🌐', color: '#00d4ff', active: true, presets: [
    '두 리소스 간 통신이 안 되는 원인 (Reachability)',
    'SG/NACL에서 막힌 포트 찾기',
    'TGW/피어링 라우트 점검',
    '비정상 Flow Log 트래픽',
  ] },
  { key: 'container', label: 'Container', icon: '📦', color: '#00ff88', active: false, presets: [
    '파드가 Pending/CrashLoop인 이유',
    'ECS 태스크 반복 재시작 진단',
    '네임스페이스 리소스 상태',
    'Istio 트래픽/사이드카 문제',
  ] },
  { key: 'data', label: 'Data', icon: '🗄️', color: '#a855f7', active: true, presets: [
    'RDS 느린 쿼리 진단',
    'DynamoDB 스로틀링 원인',
    'ElastiCache Evictions/메모리',
    'MSK 컨슈머 랙',
  ] },
  { key: 'security', label: 'Security', icon: '🔒', color: '#ef4444', active: true, presets: [
    '이 IAM 역할의 과다권한 점검',
    '특정 액션이 거부되는 이유 (정책 시뮬)',
    '퍼블릭 노출된 리소스 찾기',
    '최근 90일 미사용 역할/키',
  ] },
  { key: 'cost', label: 'Cost', icon: '💰', color: '#f59e0b', active: true, presets: [
    '이번 달 비용 추세와 가장 많이 오른 서비스',
    '다음 달 비용 예측',
    'RDS·EKS 절감 제안 (Top 5)',
    '계정/태그별 비용 분해',
  ] },
  { key: 'monitoring', label: 'Monitoring', icon: '📊', color: '#00d4ff', active: true, presets: [
    '최근 알람 요약',
    '특정 리소스 지표 이상 탐지',
    '누가 이 리소스를 변경했나 (CloudTrail)',
    '오류 급증 구간',
  ] },
  { key: 'iac', label: 'IaC', icon: '🏗️', color: '#a855f7', active: false, presets: [
    '드리프트 난 스택 찾기',
    '이 스택의 최근 변경 이력',
    '삭제보호/위험 리소스 점검',
    '미관리(IaC 밖) 리소스',
  ] },
  { key: 'ops', label: 'Ops', icon: '⚙️', color: '#00d4ff', active: false, presets: [
    '오늘 운영 이슈 요약',
    '리소스 인벤토리 현황',
    '태그 누락 리소스',
    '만료 임박 인증서/시크릿',
  ] },
  { key: 'observability', label: 'Observability', icon: '🔭', color: '#00ff88', active: false, presets: [
    '서비스 p99 레이턴시',
    '에러율 급증 분석',
    '최근 로그 에러 패턴 (Loki)',
    '트레이스로 느린 구간 (Tempo)',
  ] },
];

export const AUTO_PRESETS: string[] = [
  '이번 달 비용 추세와 가장 많이 오른 서비스',
  '두 리소스 간 통신이 안 되는 원인',
  '이 IAM 역할의 과다권한 점검',
  '최근 알람 요약',
];

export function sectionByKey(key: string): Section | undefined {
  return SECTIONS.find((s) => s.key === key);
}

export function activeSections(): Section[] {
  return SECTIONS.filter((s) => s.active);
}
