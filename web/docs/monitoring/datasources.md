---
sidebar_position: 7
title: 데이터소스
description: 외부 데이터소스 연동 관리 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
---

import Screenshot from '@site/src/components/Screenshot';
import DatasourceFlow from '@site/src/components/diagrams/DatasourceFlow';

# 데이터소스

외부 모니터링 및 관측성 시스템을 AWSops에 연동하여 통합 관리할 수 있는 Grafana 스타일의 데이터소스 관리 페이지입니다.

<Screenshot src="/screenshots/monitoring/datasources.png" alt="Datasources" />

## 개요

AWSops 데이터소스 기능은 외부 관측성 플랫폼을 중앙에서 관리합니다. 데이터소스를 등록하면 대시보드에서 쿼리를 실행하거나, AI 어시스턴트가 분석에 활용할 수 있습니다.

<DatasourceFlow />

주요 특징:
- **7종 데이터소스** 지원 (Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog)
- **CRUD 관리**: 데이터소스 추가, 수정, 삭제 (관리자 전용)
- **연결 테스트**: 원클릭 연결 확인 및 응답 시간 측정
- **쿼리 실행**: 각 데이터소스 고유 쿼리 언어 지원
- **보안**: SSRF 방지, 자격 증명 마스킹

## 지원 데이터소스

| 데이터소스 | 쿼리 언어 | 기본 포트 | 주요 기능 |
|-----------|----------|----------|----------|
| **Prometheus** | PromQL | 9090 | 메트릭 수집, 알림, 시계열 데이터 |
| **Loki** | LogQL | 3100 | 로그 집계, 레이블 기반 검색 |
| **Tempo** | TraceQL | 3200 | 분산 트레이싱, 스팬 검색 |
| **ClickHouse** | SQL | 8123 | 컬럼 기반 분석, 대량 데이터 처리 |
| **Jaeger** | Trace ID | 16686 | 분산 트레이싱, 서비스 의존성 |
| **Dynatrace** | DQL | 443 | 풀스택 모니터링, AI 기반 분석 |
| **Datadog** | Query | 443 | 인프라 모니터링, APM, 로그 |

## 데이터소스 추가

:::info 관리자 전용
데이터소스 생성, 수정, 삭제는 관리자 역할이 필요합니다. 관리자는 `data/config.json`의 `adminEmails`에 등록된 사용자입니다.
:::

### 설정 필드

| 필드 | 필수 | 설명 |
|------|------|------|
| **Name** | O | 데이터소스 식별 이름 |
| **Type** | O | 데이터소스 유형 (7종 중 선택) |
| **URL** | O | 엔드포인트 URL (예: `http://prometheus:9090`) |
| **Authentication** | - | 인증 방식 (None, Basic, Bearer Token, Custom Header) |
| **Timeout** | - | 요청 타임아웃 (기본값: 30초) |
| **Cache TTL** | - | 캐시 유효 시간 (기본값: 5분) |
| **Database** | - | 데이터베이스 이름 (ClickHouse 전용) |

### 추가 절차

1. **Datasources** 페이지에서 **Add Datasource** 버튼 클릭
2. 데이터소스 유형 선택
3. 이름, URL, 인증 정보 입력
4. **Test Connection**으로 연결 확인
5. **Save**로 저장

## 연결 테스트

**Test Connection** 버튼을 클릭하면 데이터소스별로 다음을 확인합니다:

| 데이터소스 | 테스트 엔드포인트 | 확인 내용 |
|-----------|-----------------|----------|
| Prometheus | `/-/healthy` | 서버 상태, 응답 시간 |
| Loki | `/ready` | 서버 준비 상태, 응답 시간 |
| Tempo | `/ready` | 서버 준비 상태, 응답 시간 |
| ClickHouse | `SELECT 1` | 쿼리 실행 가능 여부, 응답 시간 |
| Jaeger | `/api/services` | 서비스 목록 조회, 응답 시간 |
| Dynatrace | `/api/v2/entities` | API 접근 가능 여부, 응답 시간 |
| Datadog | `/api/v1/validate` | API 키 유효성, 응답 시간 |

테스트 결과에는 연결 성공/실패 상태와 응답 지연 시간(ms)이 표시됩니다.

## 쿼리 실행

각 데이터소스의 고유 쿼리 언어를 사용하여 직접 쿼리를 실행할 수 있습니다.

### PromQL (Prometheus)

```promql
rate(http_requests_total{job="api-server"}[5m])
```

CPU 사용률, 요청률, 에러율 등 메트릭 데이터를 시계열로 조회합니다.

### LogQL (Loki)

```logql
{namespace="production"} |= "error" | json | line_format "{{.message}}"
```

레이블 기반 로그 검색과 파이프라인 필터링을 지원합니다.

### TraceQL (Tempo)

```
{span.http.status_code >= 500 && resource.service.name = "api"}
```

분산 트레이스를 조건 기반으로 검색합니다.

### ClickHouse SQL

```sql
SELECT toStartOfHour(timestamp) AS hour, count() AS events
FROM logs
WHERE timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour
```

대량 데이터에 대한 빠른 분석 쿼리를 실행합니다.

### Jaeger

서비스 이름 또는 Trace ID로 분산 트레이스를 검색합니다.

### Dynatrace (DQL)

```
fetch logs | filter contains(content, "error") | limit 100
```

### Datadog

메트릭 쿼리 또는 로그 검색 구문을 사용합니다.

## 인증 설정

데이터소스 연결 시 4가지 인증 방식을 지원합니다:

| 인증 방식 | 설명 | 사용 예시 |
|----------|------|----------|
| **None** | 인증 없음 | 내부 네트워크의 Prometheus/Loki |
| **Basic** | 사용자명/비밀번호 | ClickHouse, 인증이 설정된 Prometheus |
| **Bearer Token** | API 토큰 | Dynatrace, Datadog, Tempo |
| **Custom Header** | 사용자 정의 헤더 | 커스텀 프록시, API 게이트웨이 |

:::tip 자격 증명 마스킹
저장된 비밀번호와 토큰은 UI에서 마스킹 처리됩니다. 수정 시에만 새 값을 입력할 수 있습니다.
:::

## 보안

### SSRF 방지

데이터소스 URL에 대해 다음 보안 검사가 적용됩니다:

- **프라이빗 IP 차단**: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.0.0.1` 등 내부 IP 차단
- **메타데이터 엔드포인트 차단**: `169.254.169.254` (EC2 인스턴스 메타데이터) 접근 차단
- **링크-로컬 주소 차단**: `169.254.x.x` 대역 차단
- **프로토콜 제한**: `http://`와 `https://`만 허용

:::caution SSRF 보호
외부 데이터소스 URL은 서버에서 요청을 전송하므로 SSRF(Server-Side Request Forgery) 공격을 방지하기 위해 내부 네트워크 접근이 차단됩니다.
:::

### ClickHouse SQL 인젝션 방지

ClickHouse 쿼리 실행 시 위험한 SQL 구문(DROP, ALTER, INSERT, UPDATE, DELETE, TRUNCATE 등)이 차단됩니다. 읽기 전용 쿼리(SELECT)만 허용됩니다.

## AI 연동

AI 어시스턴트는 등록된 데이터소스를 활용하여 분석을 수행할 수 있습니다.

### 사용 예시

- "Prometheus에서 지난 1시간 CPU 사용률 추이를 보여줘"
- "Loki에서 production 네임스페이스의 에러 로그를 검색해줘"
- "ClickHouse에서 오늘 이벤트 수를 시간대별로 집계해줘"

### 동작 방식

1. AI 어시스턴트가 질문을 분석하여 적절한 데이터소스를 선택
2. 데이터소스 유형에 맞는 쿼리를 자동 생성
3. 쿼리 결과를 기반으로 분석 및 인사이트 제공

:::tip aws-data 라우트 연동
데이터소스 관련 질문은 `aws-data` 라우트를 통해 처리됩니다. AI가 Steampipe 데이터와 외부 데이터소스를 함께 분석할 수 있습니다.
:::

## 설정 참조

### 공통 설정

| 설정 | 기본값 | 설명 |
|------|--------|------|
| **timeout** | 30초 | 요청 타임아웃 (최대 120초) |
| **cacheTTL** | 300초 (5분) | 쿼리 결과 캐시 유효 시간 |

### ClickHouse 전용

| 설정 | 기본값 | 설명 |
|------|--------|------|
| **database** | `default` | 대상 데이터베이스 이름 |

### 제한사항

- 최대 등록 가능 데이터소스 수: 제한 없음
- 쿼리 결과 최대 행 수: 1,000행
- ClickHouse: SELECT 쿼리만 허용 (DDL/DML 차단)
- URL: 프라이빗 IP 및 메타데이터 엔드포인트 차단

## 관련 페이지

- [모니터링 대시보드](./monitoring.md) - 시스템 모니터링 현황
- [CloudWatch](./cloudwatch) - AWS CloudWatch 메트릭
- [AI 어시스턴트](../overview/ai-assistant) - AI 분석 기능
