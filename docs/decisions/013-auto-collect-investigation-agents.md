# ADR-013: Auto-Collect Investigation Agents / 자동 수집 조사 에이전트

## Status: Accepted (2026-04-22) / 상태: 채택됨 (2026-04-22)

## Context / 컨텍스트

AWSops needs to assemble multi-source evidence (Steampipe, CloudWatch, Kubernetes, Prometheus, Loki, Tempo, Jaeger, ClickHouse) and hand it to Bedrock for root-cause analysis. This evidence-gathering stage is shared across several flows: the alert-triggered diagnosis pipeline (ADR-009), the AI Assistant's on-demand investigations, and the 15-section diagnosis report. A single monolithic analyzer would couple source-specific query logic to every caller and make it difficult to add new sources (ClickHouse flow logs, distributed traces) without patching the orchestrator on every change.

AWSops는 여러 소스(Steampipe, CloudWatch, Kubernetes, Prometheus, Loki, Tempo, Jaeger, ClickHouse)에서 증거를 수집하여 Bedrock 근본 원인 분석에 전달해야 한다. 이 수집 단계는 알림 트리거 진단 파이프라인(ADR-009), AI 어시스턴트의 온디맨드 조사, 15섹션 진단 리포트 등 여러 흐름에서 공유된다. 단일 모놀리식 분석기는 소스별 쿼리 로직을 모든 호출자와 결합시키고, 오케스트레이터를 매번 패치하지 않고는 새 소스(ClickHouse Flow Logs, 분산 트레이스)를 추가하기 어렵게 만든다.

Separately, ADR-009 describes the *alert pipeline* (webhook → correlation → investigation → notification). This ADR documents the *collector pattern itself* — why the investigation stage is structured as pluggable collectors, how they are uniformly invoked, and how source-specific knowledge is encapsulated.

별개로, ADR-009는 *알림 파이프라인*(webhook → 상관 분석 → 조사 → 알림)을 설명한다. 본 ADR은 *컬렉터 패턴 자체*를 다룬다 — 왜 조사 단계가 플러그형 컬렉터로 구성되는지, 어떻게 일관된 방식으로 호출되는지, 소스별 지식이 어떻게 캡슐화되는지.

## Decision / 결정

Implement a uniform `Collector` interface (`src/lib/collectors/types.ts`) and register one collector per investigation domain. Each collector owns its source access, SSE progress reporting, Bedrock context formatting, and analysis prompt. The orchestrator (`alert-diagnosis.ts`) selects a subset of collectors based on alert context and runs them in parallel — it never touches Prometheus, CloudWatch, or K8s directly.

`src/lib/collectors/types.ts`에 공통 `Collector` 인터페이스를 정의하고, 조사 도메인별로 하나의 컬렉터를 등록한다. 각 컬렉터는 자체 소스 접근, SSE 진행률 보고, Bedrock 컨텍스트 포맷팅, 분석 프롬프트를 책임진다. 오케스트레이터(`alert-diagnosis.ts`)는 알림 컨텍스트에 따라 컬렉터 하위집합을 선택해 병렬 실행하며, Prometheus·CloudWatch·K8s를 직접 호출하지 않는다.

### Interface / 인터페이스

```ts
interface Collector {
  collect(send: SendFn, accountId?: string, isEn?: boolean, alertContext?: AlertContext): Promise<CollectorResult>;
  formatContext(data: CollectorResult): string;
  analysisPrompt: string;
  displayName: string;
}

interface AlertContext {
  services?: string[];
  resources?: string[];
  alertNames?: string[];
  namespaces?: string[];
  since?: string;
}
```

### Registered Collectors / 등록된 컬렉터

| Collector | File | Investigation Domain | Primary Sources |
|-----------|------|---------------------|-----------------|
| `incident` | `src/lib/collectors/incident.ts` | Multi-source incident analysis | CloudWatch Alarms, K8s Events, Pod status, Loki, Tempo |
| `eks-optimize` | `src/lib/collectors/eks-optimize.ts` | EKS resource optimization | Prometheus (metric discovery), K8s resources, cost |
| `db-optimize` | `src/lib/collectors/db-optimize.ts` | RDS / Aurora optimization | CloudWatch, Performance Insights, Steampipe |
| `msk-optimize` | `src/lib/collectors/msk-optimize.ts` | MSK cluster optimization | CloudWatch broker/partition metrics, Steampipe |
| `network-flow` | `src/lib/collectors/network-flow.ts` | VPC Flow Logs top-talker | ClickHouse, CloudWatch |
| `trace-analyze` | `src/lib/collectors/trace-analyze.ts` | Distributed trace analysis | Tempo, Jaeger |
| `idle-scan` | `src/lib/collectors/idle-scan.ts` | Idle / low-utilization scan | Steampipe, CloudWatch |

### Execution Model / 실행 모델

Every collector issues `Promise.all([...])` across its sources internally, then `alert-diagnosis.ts` runs the selected collectors themselves in parallel. Missing datasources (e.g., Prometheus not configured for this account) are skipped — a collector returns partial sections and logs the skip rather than throwing.

각 컬렉터는 내부에서 소스들을 `Promise.all([...])`로 병렬 호출하고, `alert-diagnosis.ts`는 선택된 컬렉터들 자체를 병렬 실행한다. 누락된 데이터소스(예: Prometheus 미설정)는 스킵되며, 컬렉터는 부분 섹션을 반환하고 예외를 던지지 않는다.

## Rationale / 근거

### Uniform interface / 공통 인터페이스
A single `Collector` shape lets `alert-diagnosis.ts` select collectors from a registry (`COLLECTOR_REGISTRY`) based on incident type and invoke them identically. No case-by-case wiring, no per-source branches in the orchestrator. Adding a new collector is a file plus one registry entry.

단일 `Collector` 형태로 `alert-diagnosis.ts`는 레지스트리(`COLLECTOR_REGISTRY`)에서 인시던트 유형에 따라 컬렉터를 선택해 동일한 방식으로 호출한다. 케이스별 분기가 없고, 새 컬렉터 추가는 파일 하나 + 레지스트리 항목 하나로 끝난다.

### Parallel source access inside each collector / 컬렉터 내부 병렬 소스 접근
Each collector issues `Promise.all([...])` across Steampipe, CloudWatch, K8s, Prometheus, Loki, and Tempo. A missing or unavailable datasource is skipped — not fatal — so the pipeline keeps going with whatever evidence is reachable. This degrades gracefully in multi-account environments where not every source is configured per account.

각 컬렉터는 Steampipe·CloudWatch·K8s·Prometheus·Loki·Tempo를 `Promise.all([...])`로 병렬 호출한다. 누락/비가용 데이터소스는 치명적이지 않고 스킵되므로, 파이프라인은 도달 가능한 증거만으로 계속 진행된다. 계정별로 모든 소스가 구성되지 않는 멀티 계정 환경에서 우아하게 축퇴한다.

### AlertContext narrowing / AlertContext 스코프 축소
Without `AlertContext`, a collector does a full-environment scan and dilutes Bedrock analysis with unrelated alarms and events. With it, collectors filter by `services`, `resources`, `namespaces`, `alertNames`, and a `since` timestamp, returning only evidence tied to the firing incident.

`AlertContext`가 없으면 컬렉터는 전체 환경 스캔으로 무관한 알람·이벤트가 Bedrock 분석을 희석시킨다. 제공되면 `services`, `resources`, `namespaces`, `alertNames`, `since` 시각으로 필터링하여 실제 발생한 인시던트 관련 증거만 반환한다.

### Candidate-array Prometheus queries / Prometheus 후보 배열 쿼리
Different Prometheus installs use different label conventions (`container` vs `container_name`, `pod` vs `pod_name`, `namespace` label presence). Each metric is expressed as an array of candidate queries tried in order — first success wins, the rest are skipped. Collectors stay portable across kube-prometheus-stack, Amazon Managed Prometheus, and self-hosted installs without configuration.

Prometheus 설치마다 레이블 관례가 다르다(`container` vs `container_name`, `pod` vs `pod_name`, `namespace` 존재 여부). 각 메트릭은 후보 쿼리 배열로 표현되어 순서대로 시도되며, 첫 성공이 채택되고 나머지는 스킵된다. kube-prometheus-stack·Amazon Managed Prometheus·자체 설치 간에 설정 변경 없이 포팅된다.

### SSE progress via SendFn / SendFn 기반 SSE 진행률
Collectors emit `tool_use` and `section` events through `SendFn`, so the UI shows which source is being queried in real time instead of a blank spinner. The same collectors power the alert pipeline and the AI Assistant's diagnostic flows — both get uniform progress UX for free.

컬렉터는 `SendFn`을 통해 `tool_use`·`section` 이벤트를 내보내어 UI가 어느 소스를 조회 중인지 실시간으로 표시한다. 알림 파이프라인과 AI 어시스턴트 진단 흐름이 같은 컬렉터를 사용하므로 일관된 진행률 UX를 공짜로 얻는다.

### formatContext + analysisPrompt on the collector / 컬렉터 내부의 formatContext + analysisPrompt
Each collector owns how its data serializes to Bedrock and which system prompt drives analysis. The orchestrator just concatenates formatted contexts and dispatches to Bedrock — it knows nothing about trace span formats or VPC Flow Log aggregation. This keeps source-specific formatting changes isolated to their collector.

각 컬렉터가 Bedrock 전달용 직렬화 방식과 분석 시스템 프롬프트를 소유한다. 오케스트레이터는 포맷된 컨텍스트를 이어붙여 Bedrock에 전달할 뿐이며, 트레이스 span 형식이나 VPC Flow Log 집계를 알 필요가 없다. 소스별 포맷 변경은 해당 컬렉터에 고립된다.

## Consequences / 결과

### Positive / 긍정적
- **Add-a-source = add-a-file**: New investigation source is one collector file plus a `COLLECTOR_REGISTRY` entry — no orchestrator patch.
- **Uniform UI progress**: Alert pipeline and AI Assistant share the same `SendFn` SSE contract; users see identical investigation progress wherever collectors run.
- **Independent testability**: Each collector can be unit-tested in isolation with mock `SendFn` and stubbed source clients.
- **Reuse across flows**: The same `incident` collector powers alert-triggered diagnosis (ADR-009), AI Assistant deep-dive, and the 15-section report data-gathering phase.
- **Graceful degradation**: Missing datasources are skipped — Prometheus-less accounts still get CloudWatch + Steampipe evidence.
- **Scope control via AlertContext**: Alert pipeline invocations stay focused on firing services; manual invocations do full-environment scans when `alertContext` is omitted.

- **소스 추가 = 파일 추가**: 새 조사 소스는 컬렉터 파일 하나 + `COLLECTOR_REGISTRY` 항목 하나로 충분 — 오케스트레이터 패치 불필요.
- **일관된 UI 진행률**: 알림 파이프라인과 AI 어시스턴트가 동일 `SendFn` SSE 계약을 공유하여 어디서든 동일한 조사 진행률 표시.
- **독립 테스트 가능**: 각 컬렉터는 `SendFn` mock과 소스 클라이언트 stub으로 단위 테스트 가능.
- **흐름 간 재사용**: 동일한 `incident` 컬렉터가 알림 트리거 진단(ADR-009), AI 어시스턴트 심층 분석, 15섹션 리포트 데이터 수집에 모두 사용됨.
- **우아한 축퇴**: 누락 데이터소스는 스킵 — Prometheus 미사용 계정도 CloudWatch + Steampipe 증거 확보.
- **AlertContext 기반 스코프 제어**: 알림 파이프라인 호출은 발생 서비스에 집중, 수동 호출은 `alertContext` 생략 시 전체 환경 스캔.

### Negative / 부정적
- **Worst-case latency = slowest source**: `Promise.all` means one slow Prometheus query stalls the whole collector run. Mitigated by per-source timeouts (30s) and skip-on-error, but a slow source still dominates.
- **Prompt sprawl risk**: Each collector owns its `analysisPrompt`. Without discipline, prompts drift in tone/structure. Mitigated by keeping prompts under 100 lines each and reviewing via ADR-009 diagnosis-format guidelines.
- **Over-fetching without AlertContext**: Manual invocations (no `alertContext`) do full-environment scans that can be expensive. Callers must pass `AlertContext` when scope is known; default fallback is wide.
- **Dual-touch for new source**: Adding a collector requires updating both the collector file and `alert-diagnosis.ts` `COLLECTOR_REGISTRY`. Forgetting the registry entry silently disables the new collector from the alert pipeline.

- **최악 지연 = 가장 느린 소스**: `Promise.all`로 인해 느린 Prometheus 쿼리 하나가 컬렉터 실행 전체를 지연시킴. 소스별 타임아웃(30초) + 오류 스킵으로 완화하나, 느린 소스가 여전히 지배.
- **프롬프트 산개 위험**: 각 컬렉터가 `analysisPrompt`를 소유. 규율 없으면 톤/구조가 드리프트. 프롬프트당 100라인 미만 유지 + ADR-009 진단 포맷 가이드라인 검토로 완화.
- **AlertContext 없을 때 과조회**: 수동 호출(`alertContext` 없음)은 비싼 전체 환경 스캔 수행. 스코프가 명확하면 호출자가 `AlertContext` 전달 필수, 기본값은 광범위.
- **새 소스 추가 시 이중 수정**: 컬렉터 파일 + `alert-diagnosis.ts` `COLLECTOR_REGISTRY` 양쪽을 수정해야 함. 레지스트리 항목 누락 시 알림 파이프라인에서 조용히 비활성화됨.

## References / 참고 자료

### Internal
- `src/lib/collectors/types.ts` — `Collector`, `CollectorResult`, `AlertContext`, `SendFn` interfaces
- `src/lib/collectors/CLAUDE.md` — Per-collector matrix and rules
- `src/lib/collectors/incident.ts` — Multi-source incident analyzer
- `src/lib/collectors/eks-optimize.ts` — EKS resource optimization
- `src/lib/collectors/db-optimize.ts` — RDS / Aurora optimization
- `src/lib/collectors/msk-optimize.ts` — MSK cluster optimization
- `src/lib/collectors/network-flow.ts` — VPC Flow Logs top-talker (ClickHouse)
- `src/lib/collectors/trace-analyze.ts` — Distributed trace analysis (Tempo / Jaeger)
- `src/lib/collectors/idle-scan.ts` — Idle / low-utilization resource scan
- [ADR-009](009-alert-triggered-ai-diagnosis.md): Alert-triggered AI diagnosis pipeline — the primary consumer of collectors via `COLLECTOR_REGISTRY` in `alert-diagnosis.ts`
- [ADR-011](011-external-datasource-integration.md): External datasource integration — provides the Prometheus / Loki / Tempo / ClickHouse / Jaeger data that collectors query
