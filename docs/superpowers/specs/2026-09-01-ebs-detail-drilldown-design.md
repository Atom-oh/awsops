# EBS detail-panel drill-downs — 2 gap-audit items (L97, L98)
# EBS 상세 패널 드릴다운 — 갭 감사 2건 (L97, L98)

**Status:** Batch 11, 2026-09-01 (continuing the owner's standing "merge on review pass, keep
going" authorization). Branch `feat/ebs-detail-drilldown`.
**WA pillar:** Operational Excellence (volume forensics), Reliability (backup visibility).

Closes gap-audit items (docs/v1-gap-audit-2026-07-19.md): L97 (per-volume snapshot sub-list),
L98 (attached EC2 instance enrichment).

## 요약 (한국어)

EBS 볼륨 상세 패널에 v1 패리티 드릴다운 2종을 추가한다: 해당 볼륨의 스냅샷 최대 20개
서브리스트(빈 상태 'No snapshots for this volume' 포함)와 attachment 인스턴스별 EC2
정보(Name/type/state 배지) 카드. 데이터는 이미 동기화된 Aurora `inventory_resources`
교차조회 — 신규 AWS 호출/Terraform 없음. BFF 라우트 1개 추가.

## Decisions

- **Route** `GET /api/inventory/ebs_volume/related` (verifyUser; force-dynamic):
  - `volumeId` (required, `^vol-[0-9a-f]{8,32}$`) → up to 20 `ebs_snapshot` rows where
    `data->>'volume_id' = $volumeId`, newest first (`data->>'start_time' DESC`), fields
    `{snapshotId, sizeGb, encrypted, startTime, state}`.
  - `instanceIds` (optional, comma list, each `^i-[0-9a-f]{8,32}$`, max 10) → `ec2` rows by
    `resource_id = ANY(...)`, fields `{instanceId, name, instanceType, state}`.
  - `account` (optional, `self` | 12-digit) scopes BOTH queries (`account_id`) — same-id
    collisions across synced accounts must not leak another account's rows. Default `self`.
  - Invalid `volumeId`/tokens → 400 (never silently unfiltered); the two queries degrade
    independently (one failing block renders an inline error, not a dead panel).
- **Component** `web/components/inventory/metrics/EbsRelatedSection.tsx` (named export like its
  metric siblings), mounted by `DetailPanel` when `resourceType === 'ebs_volume'` (the exact
  `RdsMetricsSection` pattern). Receives the row's `resource_id`, `account_id`, and raw
  `attachments` (parses instance ids client-side, JSON-string tolerant):
  - 연결 인스턴스: one card per attachment instance — Name(tag)/type + state pill; an
    instance id absent from the synced ec2 rows renders the id with an 'inventory에 없음'
    note (honest-degrade — the volume may attach to an instance in an unsynced region).
  - 스냅샷 (최대 20): sub-list rows `snapshot_id · size GB · 암호화 · start_time`, with the
    v1 empty state ('이 볼륨의 스냅샷 없음') and a '20개 표시 상한' note when 20 returned.
- No schema/Terraform/AWS-call changes — pure Aurora cross-queries over synced rows.

## Testing
- Route: volumeId regex 400; snapshot filter SQL + newest-first + 20-cap; instanceIds
  validation (bad token → 400) + ANY() query; account scoping in both queries; degrade path.
- Component: instance cards with state pill; missing-instance honest-degrade; snapshot list;
  empty state; 20-cap note.
- Full `npm test` + `tsc` + build; gap-audit ticks with a batch-11 note.
