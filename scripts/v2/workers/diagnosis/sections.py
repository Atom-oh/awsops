"""AWSops v2 — AI Diagnosis MVP section catalog (8 infra sections, fixed order).
Each section: key, title, sources[] (collector keys it consumes), prompt (Korean-first,
read-only diagnosis framing). Deep-tier 15-section Opus catalog is fast-follow."""

SECTIONS = [
    {"key": "executive_summary", "title": "Executive Summary",
     "sources": ["inventory", "cost", "posture", "what_changed"],
     "prompt": "아래 AWS 계정 데이터로 운영 상태를 3~5문장으로 요약하라. 가장 큰 리스크 3가지를 우선순위와 함께 제시. 추측 금지 — 데이터에 근거."},
    {"key": "security_posture", "title": "Security Posture",
     "sources": ["posture", "inventory"],
     "prompt": "Security Hub 심각도 분포와 인벤토리를 근거로 보안 포스처를 진단하라. 퍼블릭 노출/미암호화/과다권한 신호를 짚고, 각 발견에 근거(소스)를 명시."},
    {"key": "network_architecture", "title": "Network Architecture",
     "sources": ["service_map", "inventory"],
     "prompt": "X-Ray 서비스맵 엣지(호출량/에러율)와 VPC/SG 인벤토리로 네트워크/트래픽 흐름을 진단하라. 비정상 에러율 엣지와 의심스러운 통신 경로를 지적."},
    {"key": "compute_infrastructure", "title": "Compute Infrastructure",
     "sources": ["inventory", "cw_metrics", "cost"],
     "prompt": "EC2/Lambda/ECS/EKS 인벤토리와 CloudWatch CPU 사용률, 비용을 근거로 컴퓨트 구성을 진단하라. 과다/유휴 신호, 노후 런타임 가능성을 짚어라."},
    {"key": "database_storage", "title": "Database & Storage",
     "sources": ["inventory", "cw_metrics", "cost"],
     "prompt": "RDS/DynamoDB/S3/EBS/ElastiCache/OpenSearch 인벤토리와 사용률, 비용으로 데이터 계층을 진단하라. 암호화/백업/크기 이상 신호를 짚어라."},
    {"key": "cost_overview", "title": "Cost Overview",
     "sources": ["cost"],
     "prompt": "Cost Explorer MTD 서비스별 비용으로 지출 구조를 진단하라. 상위 비용 서비스와 절감 후보를 제시(실행은 권고만, 자동변경 금지)."},
    {"key": "recent_changes", "title": "Recent Changes",
     "sources": ["what_changed"],
     "prompt": "최근 24시간 CloudTrail 변경 이벤트로 '무엇이 바뀌었나'를 요약하라. 리스크 가능성이 있는 변경을 강조."},
    {"key": "recommendations", "title": "Recommendations",
     "sources": ["inventory", "cost", "posture", "service_map", "what_changed"],
     "prompt": "위 모든 데이터를 종합해 우선순위가 매겨진 read-only 권고 목록을 작성하라. 각 권고에 근거와 예상 효과를 명시. 자동 실행/변경 제안 금지."},
]

# Plan 2 — intended-vs-actual drift section. Kept SEPARATE from the 8 base SECTIONS (which are the
# native-source sections) and appended by report.generate, because this section consumes ONLY the
# deterministic verdict list (passed/severity/observed) — never raw service-map edge text. The
# evaluator (invariants.py) already decided pass/fail; the LLM only narrates the drift.
INTENDED_VS_ACTUAL_SECTION = {
    "key": "intended_vs_actual", "title": "Intended vs Actual",
    "sources": ["intended_vs_actual"],
    "prompt": "아래는 운영자가 확정한 불변식(intended)을 실제 상태(actual)와 비교한 '판정(verdict)' 목록이다. "
              "passed=false 인 항목(드리프트)을 심각도순으로 정리하고 각 항목의 observed 근거를 명시하라. "
              "데이터(verdict)에만 근거하라 — 추측/자동변경 제안 금지. 활성 불변식이 없으면 그렇게 보고하라.",
}

# Deep-tier catalog: the 8 base SECTIONS + 6 deep-only sections (14; report.generate appends
# INTENDED_VS_ACTUAL_SECTION → 15 total). Every deep section consumes ALREADY-COLLECTED sources
# (inventory/cw_metrics/cost/service_map/posture/what_changed) — no new collectors, no new IAM.
# Read-only diagnosis framing: evidence-required, no mutation / auto-change suggestions.
_DEEP_ONLY = [
    {"key": "identity_access", "title": "IAM & 자격 증명 심층",
     "sources": ["posture", "inventory"],
     "prompt": "인벤토리(IAM 사용자/역할/정책)와 Security Hub posture를 근거로 자격 증명 위험을 진단하라. "
               "과다 권한·미사용 자격·관리자 분산·키/MFA 위생 신호를 짚고 각 발견에 근거(소스)를 명시. "
               "데이터에만 근거하라 — 추측·자동변경 제안 금지. posture 미구독이면 인벤토리 신호만으로 한정 보고."},
    {"key": "data_protection", "title": "데이터 보호 & 암호화",
     "sources": ["inventory", "posture"],
     "prompt": "인벤토리와 posture를 근거로 저장·전송 데이터 보호 상태를 진단하라. 미암호화 리소스(RDS/EBS/S3 등)·"
               "백업/스냅샷 부재·공개 접근 신호를 짚고 각 발견에 근거를 명시. 데이터에만 근거하라 — 추측·자동변경 제안 금지."},
    {"key": "network_exposure", "title": "네트워크 보안 / 노출",
     "sources": ["inventory", "service_map"],
     "prompt": "인벤토리(SG/서브넷/LB)와 서비스맵을 근거로 외부 노출면을 진단하라. 0.0.0.0/0 인그레스·퍼블릭 서브넷·"
               "퍼블릭 엔드포인트·과대 노출 신호를 짚고 각 발견에 근거를 명시. 데이터에만 근거하라 — 추측·자동변경 제안 금지."},
    {"key": "reliability_ha", "title": "신뢰성 & 고가용성",
     "sources": ["inventory", "cw_metrics"],
     "prompt": "인벤토리와 CloudWatch 지표를 근거로 신뢰성/HA를 진단하라. 멀티-AZ 미적용·단일 장애점·백업/복구 부재·"
               "스케일링 부재 신호를 짚고 각 발견에 근거를 명시. 데이터에만 근거하라 — 추측·자동변경 제안 금지."},
    {"key": "observability_coverage", "title": "관측성 & 알람 커버리지",
     "sources": ["cw_metrics", "inventory"],
     "prompt": "CloudWatch 지표/알람과 인벤토리를 근거로 관측성 커버리지를 진단하라. 알람 미설정 고비용/핵심 리소스·"
               "지표 공백·로그 보존 신호를 짚고 각 발견에 근거를 명시. 데이터에만 근거하라 — 추측·자동변경 제안 금지."},
    {"key": "cost_optimization", "title": "비용 최적화 심층",
     "sources": ["cost", "inventory", "cw_metrics"],
     "prompt": "비용(MTD/서비스별)·인벤토리·CloudWatch 사용률을 근거로 비용 최적화 기회를 진단하라. 유휴/과대 프로비저닝·"
               "구형 세대·미사용 리소스 신호를 짚고 각 권고에 근거를 명시. 데이터에만 근거하라 — 추측·자동변경(실제 변경) 금지, 권고만."},
]

DEEP_SECTIONS = list(SECTIONS) + _DEEP_ONLY
