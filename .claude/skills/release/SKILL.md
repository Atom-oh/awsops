# Skill: Release / 스킬: 릴리스

## When to Use / 사용 시점
Prepare a new release of the AWSops Dashboard.
(AWSops 대시보드의 새 릴리스를 준비합니다.)

## Steps / 단계

### 1. Pre-Release Checks / 릴리스 전 점검
```bash
# Build must pass (빌드 통과 필수)
npm run build

# Full verification — 46+ checks (전체 검증 — 46개 이상 점검)
bash scripts/09-verify.sh

# All services running (전체 서비스 실행 확인)
bash scripts/07-start-all.sh
```

### 2. Version Update / 버전 업데이트
- Update version in `src/components/layout/Sidebar.tsx` footer — currently v1.0.0 (`src/components/layout/Sidebar.tsx` 푸터의 버전 업데이트 — 현재 v1.0.0)
- Update CLAUDE.md if architecture changed (아키텍처 변경 시 CLAUDE.md 업데이트)

### 3. Changelog / 변경 이력
Document changes in commit messages or CHANGELOG.md:
(커밋 메시지 또는 CHANGELOG.md에 변경 사항을 기록합니다:)
- New pages added (새 페이지 추가)
- New query files (새 쿼리 파일)
- API changes (API 변경)
- AgentCore/Gateway updates (AgentCore/Gateway 업데이트)
- Bug fixes, especially query column fixes (버그 수정, 특히 쿼리 컬럼 수정)

### 4. Deploy / 배포
```bash
# On EC2: rebuild and restart (EC2에서: 재빌드 및 재시작)
bash scripts/03-build-deploy.sh

# Invalidate CloudFront cache (CloudFront 캐시 무효화)
aws cloudfront create-invalidation --distribution-id <ID> --paths "/awsops*"
```

### 5. Post-Deploy Verification / 배포 후 검증
```bash
# Verify via CloudFront (CloudFront를 통해 검증)
curl -s -o /dev/null -w "%{http_code}" https://<cf-domain>/awsops

# Run full verify (전체 검증 실행)
bash scripts/09-verify.sh
```
