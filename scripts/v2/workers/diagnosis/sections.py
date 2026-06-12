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
