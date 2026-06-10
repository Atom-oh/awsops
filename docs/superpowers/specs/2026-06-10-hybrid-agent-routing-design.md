# 설계: 하이브리드 에이전트 라우팅 + 프롬프트 캐싱 (→ ADR-037)

> 작성 2026-06-10 · 브랜치 `feat/v2-architecture-design` · 멀티AI 의사결정(Kiro·Codex·Gemini) 반영
> 후속: 이 스펙은 **ADR-037**로 정식화 예정. 구현 계획은 writing-plans로.

## 1. 목적 / Decision

`.reference` AIOps 자료 검토 + 코드 대조에서 도출한 **두 개선점의 첫 번째**(라우팅 정확도)를 v2에 적용한다.

- **주목적 — 라우팅 정확도(accuracy).** 현재 `web/lib/route.ts`의 `pickGateway`는 9개 섹션에 대한 **first-match 정규식**으로, 매 챗 턴 정확히 한 게이트웨이만 고른다. 실패 모드:
  - 다중도메인 질의("EKS 파드가 RDS 연결 안 돼")가 첫 매칭(container)으로 빠져 실제 원인(network/data)을 놓침.
  - 키워드 무매칭 → 범용 `ops`로 강등.
  - 교차도메인("왜 비용이 늘었나" = cost+data+container)을 단일 게이트웨이로 못 담음.
- **부수 — 비용·결정성.** `agent.py`의 `BedrockModel`에 프롬프트 캐싱·`temperature=0`이 없다. 멀티AI 패널(Kiro·Codex·Gemini)이 **만장일치로 "캐싱+temperature=0 = 지금 당장 할 #1 ROI"**로 지목.

### 명시적 연기 결정 (ADR에 박는다)
**AgentCore Gateway 시맨틱 툴 검색**(`searchType=SEMANTIC`, BFF 라우팅 제거 + 단일 교차-게이트웨이 에이전트)은 **P4 인시던트 오케스트레이터에서 채택**한다. 지금이 아닌 이유(패널 만장일치):
1. 9개 중 2개만 라이브 → 교차-게이트웨이 라우팅 결정 자체가 *지금은 발생 불가*.
2. 단일 통합 에이전트는 섹션별 `SKILL_BASE` 전문가 프롬프트를 희석/붕괴.
3. 대부분 비어있는 게이트웨이에 시맨틱 검색 → 무관 질의에 최근접 툴 **유령매칭(환각)**.
4. 게이트웨이당 ~20툴 수준 → 시맨틱 인덱싱은 50+툴 전엔 과잉(Gemini).
5. P4가 이미 교차-게이트웨이를 계획 → 전 게이트웨이 라이브 + 본 ADR이 적재한 오라우팅 로그가 P4 시맨틱 설계의 입력이 됨.

## 2. 라우팅 메커니즘 (옵션 A — 하이브리드, 단일-게이트웨이/턴 유지)

```
classifyRoute(prompt, pinned) -> RouteResult:
  1) pinned 유효(sectionByKey)        -> { primary: pinned, method: 'pin' }
  2) 정규식이 정확히 1개 섹션 매칭     -> { primary: <sec>, method: 'regex' }   # Haiku 생략(고신뢰·무료)
  3) 그 외(무매칭 OR 2개+ 매칭)        -> Haiku 분류기
        -> 9섹션 랭킹 + 신뢰도, top-3   -> { primary, ranked[3], method: 'llm' }

RouteResult = {
  primary: string,                       # top-1 섹션 키
  ranked:  { key, score, active }[],     # 최대 3개 (pin/regex는 primary 1개만)
  method:  'pin' | 'regex' | 'llm',
}
```

- **Top-1 자동 라우팅 + 2·3위 전환칩.** UI는 top-1으로 즉시 답변을 시작하고, 2·3위를 "→ Data로 재실행" 칩으로 노출(클릭 시 해당 섹션을 `pinned`로 재전송).
- **비활성 섹션 정직 처리.** 분류는 9개 *전체*로 수행(의도 정확 판정). top-1이 `active:false`(미라이브)면 **에이전트를 호출하지 않고**, "🔒 *Data* 에이전트는 P3 예정입니다" 안내 + `active:true` 대안(현재 network·security) 칩을 반환. → 유령매칭 0.
- **결정성/폴백.** Haiku 호출 실패·타임아웃(>1s)이면 정규식 결과 또는 `ops`로 폴백하고 **챗을 절대 막지 않는다**(로그만 남김).

## 3. 컴포넌트 / 경계

| 파일 | 변경 | 책임 |
|---|---|---|
| `web/lib/classifier.ts` | **신규** | Haiku(`claude-haiku-4-5`) Bedrock 호출 → 구조화 JSON `{ranked:[{key,score}]}`. 순수 함수, Bedrock 클라이언트 주입으로 모킹테스트 가능 |
| `web/lib/route.ts` | 수정 | `pickGateway`(정규식 코어) 유지 + `classifyRoute()` 추가: pin → regex(단일매칭) → llm 폴백, `active` 판정(sections.ts), top-3 조립 |
| `web/lib/sections.ts` | 무변경(소비) | `active` 플래그가 비활성 처리의 단일 소스 |
| `web/app/api/chat/route.ts` | 수정 | `pickGateway` → `await classifyRoute()`. top-1 비활성 시 단락 응답. `event: meta` 페이로드를 `{ gateway, ranked, method }`로 확장 |
| `web/components/chat/ChatDrawer.tsx` | 수정 | meta의 `ranked` → 전환칩 렌더. 칩 클릭 시 해당 섹션 `pinned`로 재전송. 비활성 안내 표시 |
| `agent/agent.py` | 수정 | `BedrockModel`에 `temperature=0` + 프롬프트 캐싱(아래 §4) |
| `terraform/v2/foundation/workload.tf` | 수정 | web task role에 Bedrock `InvokeModel`(Haiku 모델 ARN 한정) 권한 추가 |

**경계 원칙**: `classifier.ts`는 "질의 → 랭킹"만 안다(Bedrock 의존, 순수). `route.ts`는 정책(pin/regex/llm 우선순위 + active)을 안다. `chat/route.ts`는 전송·단락·SSE만. UI는 렌더·재전송만. 각 단위 독립 테스트 가능.

## 4. 프롬프트 캐싱 + temperature=0 (부가 — ADR-033 확장)

- **ADR-033과의 관계.** ADR-033은 프롬프트 캐싱을 이미 *결정*했으나 정정 노트 *"게이트웨이 호출은 불투명"*을 달았다 — 이는 **v1(`src/`)의 게이트웨이 경유 호출**에서 `cache_control`을 제어할 수 없다는 의미. **v2에서는 `agent.py`의 Strands `BedrockModel`이 우리가 Bedrock을 직접 호출하는 지점**이므로 캐싱이 제어 가능하다. 본 ADR-037은 ADR-033의 캐싱 결정을 **v2의 실제 호출 경로로 확장**한다.
- **적용.** `BedrockModel(...)`에:
  - `temperature=0` — 툴 선택/오케스트레이션 결정성 (패널 지지: "non-deterministic flapping이 복잡 환경 에이전트 실패 #1 원인" — Gemini).
  - 시스템 프롬프트(섹션별 `SKILL_BASE`) + 툴 스키마에 캐시 적용 (Strands `cache_prompt`/`cache_tools` 계열 파라미터 — **정확한 파라미터명은 우리 Strands 버전에서 구현 시 검증**, 미지원이면 graceful no-op).
- **검증.** ADR-033 토큰 기록으로 캐시 히트 전후 *입력 토큰*을 비교(반복 질의에서 system+tools 토큰 감소 확인).

## 5. 측정 / SLO

- **라우팅 정확도 골든셋.** 라벨링된 `(질의 → 기대 섹션)` 코퍼스(KO+EN, 섹션별 ≥5, 다중도메인 케이스 포함)를 두고 **라우팅 정확도 %**를 SLO로 둔다(ADR-033 골든셋 분류 SLO 패턴 재사용). regex-only 기준선 대비 하이브리드 정확도 향상을 수치화.
- **오라우팅 로깅.** `method='llm'`이고 사용자가 전환칩으로 섹션을 바꾼 경우를 "misroute 후보"로 적재 → 골든셋 보강 + **P4 시맨틱 라우팅 설계 입력**.

## 6. 에러 처리

| 상황 | 처리 |
|---|---|
| Haiku 호출 실패/타임아웃(>1s) | 정규식 결과 사용, 없으면 `ops`. 로그 경고. 챗 비차단 |
| Haiku JSON 파싱 실패 | 동일 폴백 |
| 분류 결과가 알 수 없는 섹션 키 | 무시하고 차순위, 전부 무효면 `ops` |
| top-1 비활성 | 에이전트 미호출, 안내 + 활성 대안 칩 |
| Strands 캐시 파라미터 미지원 | no-op(예외 없이), temperature는 적용 |

## 7. 테스트

- `route.test.ts` 확장: 기존 정규식 케이스 그대로 통과(회귀 방지) + pin 우선 + 단일/복수매칭 분기.
- `classifier.test.ts`(신규): Bedrock 모킹 → 랭킹 파싱, top-3 절단, 잘못된 JSON 폴백, 알 수 없는 키 제거.
- `chat/route.test.ts` 확장: 비활성 단락 응답, meta `ranked` 페이로드, Haiku 폴백.
- 골든셋 정확도 측정 스크립트(SLO 게이트).

## 8. 리스크 / 트레이드오프

- **지연**: Haiku는 *모호한 질의에만* 호출(~0.5–0.9s). 쉬운 70%는 정규식으로 즉시·무료. 수용 가능.
- **IAM 확장**: web task role에 Bedrock InvokeModel(Haiku 한정) — workload.tf 소폭 변경, 최소권한 유지.
- **temperature=0**: 응답 다양성 감소 → 운영 도메인에선 결정성이 이점(패널 지지).
- **단일-게이트웨이/턴 유지**: 진짜 교차-게이트웨이 fan-out은 P4. 본 ADR은 그 다리.

## 9. 범위 밖 (Out of scope)

- AgentCore Gateway 시맨틱 툴 검색(옵션 C) → **P4**.
- 진짜 토큰 스트리밍 / AG-UI 프로토콜(개선점 #1) → **별도 ADR**.
- 툴 결과 압축, Evaluations 하니스, Policy/Hooks, Performance Insights 툴, 유사인시던트 RAG → consensus 로드맵의 후속 항목(별도).

## 10. 멀티AI 의사결정 기록 (ADR Considered Alternatives용)

- **옵션 A 하이브리드(채택)** vs **B 임베딩 분류기** vs **C Gateway 시맨틱(연기)**.
- Kiro·Gemini·Codex **만장일치로 A-now / C-at-P4** 권고. 결정 트레이드오프: *아키텍처 순수성(C) vs 도메인 정밀도+즉시 출하(A)*, 그리고 C의 보상은 "전 게이트웨이 함대 존재(=P4)"에 묶임.
- 캐싱+temperature=0을 동일 패널이 **#1 ROI**로 지목 → 본 ADR에 부가 포함.
- (Codex 1차 라운드는 설정모델 `gpt-5.5` 404로 불참, 후속 라운드 기본모델로 참여.)
