# Auto-Collect Agents / 자동 수집 에이전트

## 역할 / Role
알림-트리거 AI 진단(ADR-009) 파이프라인의 병렬 데이터 수집기. 각 컬렉터는 `Collector` 인터페이스(`types.ts`)를 구현하여 Steampipe, CloudWatch, K8s, Prometheus, Loki, Tempo/Jaeger, ClickHouse에서 데이터를 가져와 Bedrock 분석용 컨텍스트로 포맷한다.
(Parallel data collectors powering the alert-triggered AI diagnosis pipeline — ADR-009. Each collector implements the `Collector` interface in `types.ts`, pulling from Steampipe, CloudWatch, K8s, Prometheus, Loki, Tempo/Jaeger, and ClickHouse, then formatting context for Bedrock analysis.)

## 주요 파일 / Key Files
| 파일 | 용도 | 데이터 소스 |
|------|------|-------------|
| `types.ts` | `Collector`, `CollectorResult`, `AlertContext`, `SendFn` 공유 인터페이스 | — |
| `incident.ts` | 다중 소스 인시던트 분석 (CloudWatch 알람 + K8s 이벤트 + Pod 상태 + 로그/트레이스) | Steampipe, K8s, Prometheus, Loki, Tempo/Jaeger |
| `eks-optimize.ts` | EKS 리소스 최적화 (Prometheus 메트릭 디스커버리 + K8s 리소스 수집 + 비용) | Prometheus, Steampipe (eks-container-cost), K8s |
| `db-optimize.ts` | RDS/Aurora 최적화 (Performance Insights, Slow Query) | CloudWatch, Steampipe |
| `msk-optimize.ts` | MSK 클러스터 최적화 (파티션/브로커 메트릭) | CloudWatch, Steampipe |
| `network-flow.ts` | VPC Flow Logs top-talker + 네트워크 메트릭 | ClickHouse, CloudWatch |
| `trace-analyze.ts` | 분산 트레이스 분석 (지연/오류 span) | Tempo, Jaeger |
| `idle-scan.ts` | 유휴/저사용 리소스 스캔 | Steampipe, CloudWatch |

## 인터페이스 / Interface
```ts
interface Collector {
  collect(send: SendFn, accountId?: string, isEn?: boolean, alertContext?: AlertContext): Promise<CollectorResult>;
  formatContext(data: CollectorResult): string;
  analysisPrompt: string;
  displayName: string;
}
```

`AlertContext`가 주어지면 컬렉터는 전체 환경 스캔 대신 알림의 services/resources/namespaces로 스코프를 좁힌다. 이를 통해 무관한 알람이 Bedrock 분석을 희석시키는 것을 방지한다.
(When `AlertContext` is provided, collectors narrow their scope to alert-specific services/resources/namespaces instead of a full environment scan.)

## 규칙 / Rules
- 모든 외부 소스 호출은 **병렬** — `Promise.all([...])`
- 데이터소스 부재 시 **스킵하되 실행은 계속** — 없는 Prometheus 메트릭이 파이프라인을 중단시키지 않음
- `send(event, data)` SSE 프레임으로 진행 상황 실시간 전송 — UI에 `tool_use` / `section` 이벤트 표시
- 모든 Prometheus 쿼리는 여러 후보(`queries: [...]`)로 구성, 순서대로 시도 후 첫 성공 사용
- `alert-diagnosis.ts`가 전략 기반으로 컬렉터 선택 — 알림 종류에 따라 부분집합만 실행
- 결과 요약은 `viaSummary`에 누적 — UI `via:` 필드에 도구 사용 표시
- 새 컬렉터 추가 시 `alert-diagnosis.ts`의 `COLLECTOR_REGISTRY`에 등록

---

# Auto-Collect Agents (English summary)

Parallel data-gathering collectors for the alert-triggered AI diagnosis pipeline (ADR-009). Each file implements the `Collector` interface defined in `types.ts` and is selected by `alert-diagnosis.ts` based on incident strategy. See the Korean section above for the per-collector matrix.

Key rules:
- All external source calls run in parallel (`Promise.all`).
- Missing datasources are skipped, not fatal — the pipeline keeps going.
- Progress streams through `SendFn` (SSE) with `tool_use` / `section` events.
- Prometheus queries are candidate arrays; first success wins.
- Register new collectors in `alert-diagnosis.ts` `COLLECTOR_REGISTRY`.
