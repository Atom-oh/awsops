---
sidebar_position: 1
title: 데이터소스
description: 관측성 제공업체 연결, 접근 확인, 읽기 전용 쿼리로 근거 탐색
---

# 데이터소스

**연동 → Datasources**에서 관측성 엔드포인트를 등록하고 인스턴스의 **탐색 →** 페이지를 엽니다. 같은 제공업체의 인스턴스를 여러 개 등록할 수 있습니다. 설정 저장, 연결 테스트 성공, 워크로드 정상은 서로 다른 상태입니다.

**접근 권한과 범위** 로그인한 사용자는 등록 목록 조회, Explore 사용, AI 쿼리 초안 생성을 할 수 있습니다. 관리자는 생성·편집·삭제·기본 인스턴스 선택, 자격증명 관리, 연결 테스트를 수행합니다. 엔드포인트와 설정 상세도 관리자에게만 표시됩니다. 등록은 전역 설정입니다. 사이드바 계정을 바꿔도 데이터소스 주소가 바뀌지 않으며, Explore는 선택한 인스턴스 ID로 조회합니다. 같은 종류의 첫 인스턴스가 기본값이 됩니다. 기본 표시는 선택 기준이며 연결·상태 검사 결과가 아닙니다.

## 지원 제공업체

| 제공업체 | Explore 쿼리 | 연결 테스트 |
|---|---|---|
| Prometheus | PromQL, 예: `up` | `/-/healthy` |
| Mimir | PromQL, 예: `up` | `/ready` |
| Loki | LogQL, 예: `{job="varlogs"} \|= "error"` | `/ready` |
| Tempo | TraceQL, 예: `{ duration > 500ms }` | `/ready` |
| ClickHouse | 읽기 전용 SQL; `SELECT 1`로 시작 | `/ping` |
| Jaeger | 서비스명 또는 `service=frontend&limit=20` 같은 검색 매개변수 | `/api/services` |
| Dynatrace | Metrics API v2 `metricSelector`, 예: `builtin:host.cpu.usage:avg` | `/api/v2/metrics?pageSize=1` |
| Datadog | 메트릭 쿼리, 예: `avg:system.cpu.user{*}` | `/api/v1/validate` 후 1분 범위 `/api/v1/query` |

환경에 실제 존재하는 메트릭·레이블·서비스·테이블 이름을 사용하세요. Jaeger Explore는 요약된 트레이스 검색 결과를 반환하며, 단독 Trace ID를 직접 조회 명령으로 해석하지 않습니다. Dynatrace는 Grail DQL이 아닌 Metrics API v2를 사용합니다. 별도 Problems 도구에는 `problems.read`가 필요하며 메트릭 테스트로 그 권한까지 확인하지 않습니다. Datadog 데이터소스는 메트릭 시계열을 조회하며 로그·APM 트레이스를 검색하지 않습니다.

## 연결, 테스트, 저장

1. **데이터소스 추가**에서 제공업체를 선택하고 이름과 API 기본 URL을 입력합니다. 유형별 URL 힌트를 참고하되 올바른 Datadog 사이트 또는 Dynatrace 환경을 선택하세요.
2. 인증 정보를 입력합니다. URL에 자격증명을 넣지 마세요. API 기본 URL은 사용자 정보·쿼리 매개변수·프래그먼트를 포함할 수 없습니다.
3. 모든 종류·인증 방식에서 백엔드에 필요한 **Org ID (X-Scope-OrgID)**를 입력합니다. 같은 엔드포인트의 빈 필드는 기존 테넌트를 유지하며, 주소 변경·불일치에는 자격증명과 테넌트를 다시 입력합니다. 테넌트를 제거하려면 편집 화면에서 기본 해제된 **저장된 Org ID 지우기**를 직접 선택합니다(API: `creds: { org_id: '' }`). 선택 중 Org ID 입력은 비활성화되며, 주소 변경만으로 자동 선택되지 않습니다.
4. 필요한 경우 Timeout(정수 초 1–60, 기본 10)과 ClickHouse Database(최대 128자의 식별자, `system`/`information_schema` 제외)를 설정합니다.
5. **연결 테스트**를 눌러 성공·실패를 확인합니다. 성공 시 왕복 지연 시간이 표시됩니다. Datadog은 API 키와 Application 키의 메트릭 조회 권한을 확인하며 빈 조회 결과도 테스트 성공일 수 있습니다.
6. **저장** 후 **탐색 →**에서 작은 읽기 전용 쿼리로 실제 데이터 접근을 확인합니다. 예를 들어 ClickHouse `/ping`은 도달 여부를 확인하며 쿼리 권한을 증명하지 않습니다.

테스트를 권장하지만 저장 자체가 테스트 성공을 뜻하지는 않습니다. 편집 화면에 기존 비밀값은 표시되지 않습니다. 엔드포인트와 인증 방식을 유지하고 인증 필드를 비워 두면 저장된 값을 유지합니다. 편집 중 테스트는 엔드포인트 전체가 같을 때만 해당 인스턴스의 자격증명을 재사용합니다. 호스트·스킴·포트·경로를 바꾸면 다시 입력하세요. 연결 필드를 수정하면 이전 테스트 결과가 지워집니다.

**None**은 인증 없음, **Basic**은 사용자명·비밀번호, **Bearer token**은 토큰 인증입니다. Dynatrace는 토큰 인증이 기본 선택되며 `Authorization: Api-Token`으로 전송하고 `metrics.read`가 필요합니다. **Custom header**는 최대 두 쌍의 이름·값을 지원하며 Host·Content-Length·Authorization 덮어쓰기는 차단합니다. Datadog은 **API key** / **Application key**가 기본 선택되고 `DD-API-KEY` / `DD-APPLICATION-KEY`로 전송됩니다. 자격증명은 서버 측 Secrets Manager에 저장되며 폼으로 반환되지 않습니다.

### 상태 읽기

| 상태 | 의미와 다음 단계 |
|---|---|
| 설정 저장됨 · 미검증 | 필요한 설정이 존재함; 테스트와 대표 쿼리로 확인 |
| 기본 연결 설정 · 인스턴스 저장 필요 | 기존 기본 연결 정보만 존재함; 편집에서 주소 확인·테스트 후 인스턴스 설정 저장 |
| 연결 주소 확인 필요 | 주소가 없거나 허용되지 않는 형식임; 관리자가 HTTP(S) API 기본 주소를 확인 |
| 인증 설정 필요 | 필요한 저장 자격증명이 없음; 관리자에게 보완 요청 |
| 연결 성공 (편집 화면의 테스트) | 해당 제공업체의 테스트 성공; 모든 API 권한·데이터셋·워크로드를 검증한 것은 아님 |
| 상태 확인 불가 | 설정을 읽지 못함; 빈 목록으로 단정하지 말고 재시도 또는 관리자 확인 |
| 비활성 | 행이 비활성 상태이며 AI 진단 바로가기를 제공하지 않음 |

## Explore와 쿼리 제한

인스턴스를 고르고 네이티브 쿼리를 검토한 뒤 **실행**을 누릅니다. 한 줄 쿼리 입력창에서는 Enter, 여러 줄 SQL에서는 Ctrl+Enter로 실행합니다. 쿼리 예제 칩은 즉시 실행되지만 자연어 예제 칩은 요청 문구만 채웁니다. 진단 신호 칩이 제공되는 경우 선택한 쿼리를 실행합니다. Prometheus/Mimir/Loki에서 지원하는 시간 범위를 바꾸면 현재 쿼리를 다시 실행합니다.

- Timeout 적용은 제공업체마다 다릅니다. ClickHouse 실행은 최대 55초, Prometheus/Mimir Explore는 최대 10초이며 다른 제공업체는 설정을 저장하지만 적용하지 않습니다. 연결 테스트에는 별도 시간 제한이 있습니다.
- 네이티브 쿼리는 최대 8,000자이며 ClickHouse Explore는 최대 500행을 요청합니다. ClickHouse는 변경 구문·SYSTEM/system 테이블·테이블 함수를 차단합니다. `SELECT 1` 또는 발견된 허용 사용자 테이블로 시작하세요.

## AI 쿼리 초안, 채팅, 진단

자연어 요청을 입력하고 **AI로 생성** 또는 해당 입력창의 Enter를 누릅니다. 쿼리 입력창이 채워지며 어휘·스키마 경고가 표시될 수 있습니다. **생성된 쿼리는 자동 실행되지 않습니다.** 검토 후 별도로 **실행**을 누르세요. 자연어 입력은 4,000자로 제한됩니다. 스키마 어휘가 없거나 오래되었거나 일부만 있을 수 있으므로 실행 전에 이름·범위·경고를 확인하세요.

**AI로 진단**은 Prometheus·ClickHouse·Loki·Mimir·Tempo의 활성화되고 설정된 기본 인스턴스에만 표시됩니다. `/assistant`에 Prometheus/ClickHouse는 `/observability`, Loki/Mimir/Tempo는 `/monitoring`으로 섹션을 고정한 프롬프트를 채웁니다. 검토 후 직접 보내면 새 대화가 시작됩니다. 네이티브 채팅은 기본 인스턴스를 사용하므로 다른 인스턴스의 근거는 Explore에서 확인하세요.

**Datadog·Dynatrace는 Explore와 AI 쿼리 초안을 지원하지만, 네이티브 채팅 게이트웨이 대상과 자동 진단 리포트 수집은 기본 연결되어 있지 않습니다.** Jaeger도 Explore·초안을 지원하되 네이티브 채팅 대상·자동 리포트 수집기가 없습니다. 데이터소스 등록으로 이 경로가 추가되지는 않습니다.

작업자 기반 외부 근거 수집은 현재 Prometheus·Mimir·Loki·Tempo·ClickHouse를 대상으로 하며 `datasource_diagnosis_enabled`와 AgentCore·integrations·workers 의존성이 활성화되어야 합니다. 등록만으로 수집이 활성화되지 않으며 수집 불가·불완전한 근거는 리포트에서 구분해야 합니다.

지원하는 벤더 hosted MCP 프리셋은 **Connectors**의 별도 경로로, 자격증명·배포 게이트·도구 허용 목록도 별도입니다. Datadog·Dynatrace 데이터소스 저장이 hosted MCP를 활성화하지 않습니다. v2에는 `datasource` 채팅 라우트나 실시간 Steampipe 채팅 쿼리 경로가 없습니다.

## 문제 해결과 안전한 사용

- 인증 실패나 Timeout이면 API 사이트·환경, 읽기 스코프와 커넥터에서의 도달 여부를 확인하고 쿼리·기간을 줄이세요. 메트릭 테스트는 Problems API 접근까지 검증하지 않습니다.
- HTTP(S) 사설 데이터소스를 지원하지만 메타데이터·루프백·링크로컬 및 기타 차단된 특수 주소는 허용되지 않습니다. 리다이렉트와 안전하지 않은 URL 형식도 거부됩니다. v2에는 Allowed Networks 예외 편집기가 없습니다.
- 조회·저장·삭제·기본값 변경 실패는 오류를 확인하고 재시도하세요. 잘림·부분·오래됨·미평가 또는 빈 결과는 정상의 근거가 아닙니다. 원본·시간 범위를 확인하고 요청을 좁히세요.

관련 가이드: [커스텀 에이전트와 스킬](../operations/custom-agents) · [AI 어시스턴트](../overview/assistant) · [AI 진단 리포트](../operations/ai-diagnosis)
