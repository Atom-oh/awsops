# ADR-015: 운영 자가치유 — 호스트 자기 서비스 재배포 / Operational Self-Healing — Redeploying AWSops' Own Service

## Status / 상태
**Accepted — explicit, dated owner-override exception to the ADR-005 autonomy freeze (not a routine scoping clarification).**

- **Owner sign-off:** 오준석(Junseok Oh), 2026-07-01. This ADR is ratified as a deliberate, narrow exception the owner has personally authorized — per `docs/decisions/CLAUDE.md` / root `CLAUDE.md`'s rule that unfreezing ADR-005 always requires a new ADR + multi-AI panel review + a dated owner-override, never a self-scoping reinterpretation.
- **Panel record:** PR #114's multi-AI review (Claude chair · codex · kiro-opus · kiro-kimi, 2026-06-29) flagged the original "distinct category" framing as risking an owner-solo re-scope (echoing the legacy ADR-041 PARTIAL precedent) rather than a clearly-marked exception. This revision addresses that by naming the exception explicitly instead of implying it needs no sign-off.
- **Scope of the exception, precisely:** ADR-005 itself is unchanged and remains FROZEN for everything else — the mutation/autonomy substrate (`remediation_enabled`, BYO-MCP, mutating tools) stays do-not-enable. The ONLY carve-out this ADR grants is the narrow, gated, fail-closed self-redeploy described below.

## Context / 컨텍스트

Aurora는 `manage_master_user_password`로 마스터 비밀번호를 **주기 회전**(기본 7일)한다. 장수 ECS 태스크(web BFF)는 시작 시점에 ECS `secrets`/valueFrom으로 비밀번호를 주입받으므로, 회전 후엔 옛 비밀번호를 들고 있어 Aurora 인증이 실패한다(`password authentication failed`) — DB 의존 페이지 전면 장애. 2026-06-28 회전 → 2026-06-29 장애 발생, 수동 `force-new-deployment`로 복구. 재발방지 자동화가 필요한데, 프로젝트는 **AWS 리소스 변경 + 자율 = FROZEN(ADR-005)** 원칙을 둔다. 질문: *호스트 자신의 서비스를 자동 재배포*하는 것이 autonomy 동결 위반인가?

Aurora rotates its RDS-managed master password (~7 days). A long-running ECS task (the web BFF)
gets the password injected via `secrets`/valueFrom **at task start**, so after a rotation it holds a
stale password and Aurora auth fails — every DB-backed page breaks (observed 2026-06-29). A manual
redeploy recovers it. Automated recurrence-prevention is needed, but the project freezes **AWS-
resource mutation + autonomy (ADR-005)**. Question: is auto-redeploying AWSops' *own* service an
autonomy-freeze violation?

## Decision / 결정

**운영 자가치유(operational self-healing)를 ADR-005의 frozen substrate와 구별되는 별개 카테고리로 명확화한다.** AWSops는 자신의 **호스트 서비스에 한해** 배포 수준 복구(`ecs:UpdateService` force-new-deployment)를 자율 수행할 수 있다. 단 모두 충족:

- **default-off 플래그**(`secret_rotation_redeploy_enabled`) — 기본 0 리소스/$0.
- **IAM은 호스트 자기 서비스 ARN으로 스코프** — `force-new-deployment`만, 다른 ECS/리소스 변경 없음.
- **트리거 검증** — 자기(Aurora 마스터) 비밀 회전 이벤트로 제한(Lambda가 secret id 대조, **fail-closed**: 미식별 시 미실행).
- task definition/리소스 스펙은 **불변**(새 태스크가 회전된 시크릿을 다시 읽을 뿐).

이는 **관리/고객 AWS 리소스의 변경이 아니며**, ADR-005의 remediation/자율-mitigation substrate(`remediation_enabled`, **frozen 유지**)가 **아니다**. ADR-005는 그대로 동결이며, 본 ADR은 그것을 완화하지 않는다 — 호스트 자기 배포의 운영 복구라는 **다른 범주**를 명시할 뿐이다.

Establish **operational self-healing** as a category DISTINCT from ADR-005's frozen substrate.
AWSops MAY autonomously perform deployment-level recovery (`ecs:UpdateService` force-new-deployment)
**on its own host services only**, all of: default-off flag (`secret_rotation_redeploy_enabled`);
IAM scoped to the host's own service ARN (force-new-deployment only); trigger restricted to a
verified own-secret (Aurora master) rotation event (the Lambda matches the secret id, **fail-closed**
when unidentified); no task-definition/resource change. This is **not** AWS-resource mutation of
managed/customer infra and **not** the ADR-005 remediation/autonomy substrate (`remediation_enabled`
stays FROZEN). ADR-005 is unchanged; this ADR does not relax it.

## Consequences / 결과

### Positive / 긍정
- ~주간 회전마다 반복되던 인증 장애를 사람 개입 없이 제거(self-heal).
- blast radius 최소: 1개 stateless 서비스 롤링 재시작, IAM 1 ARN, default-off, secret-id fail-closed.

### Negative / Trade-offs
- autonomy 동결 원칙 아래 **좁은 자율 write 경로**가 존재(스코프·게이트·기본off·fail-closed로 완화).
- 트리거가 **CloudTrail management-event trail 의존**(Secrets Manager는 native 이벤트 없음) — trail 부재 시 미발화(문서화됨).
- IAM은 단일 서비스 스코프 — `srr_services` 다중화 시 IAM 동시 확장 필요(주석 명시).

## 6 Pillars (보안 중심) / 6 Pillars (security-focused)
- **Security**: 자기 서비스 한정 + force-new-deployment-only + IAM 1 ARN 스코프 + secret-id 검증 fail-closed + default-off. 관리/고객 리소스 변경 없음. ADR-005 frozen substrate 불가침.
- **Reliability**: RDS 회전↔valueFrom-at-start 불일치로 인한 ~주간 outage 자동 복구.
- **Operational Excellence**: 명시적 owner-override(오준석, 2026-07-01) + 멀티-AI 패널 리뷰(PR #114, 2026-06-29) + 본 ADR 기록으로 ADR-005 예외 거버넌스 요건(새 ADR+패널+날짜박힌 owner-override) 충족.
- **Cost**: default-off=$0; 켜도 회전당 짧은 롤링 1회.
- **Performance/Sustainability**: 무중단 롤링, 상시 자원 0.
