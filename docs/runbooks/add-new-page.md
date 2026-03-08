# Runbook: Add New Dashboard Page / 새 대시보드 페이지 추가

## Steps / 단계

### 1. Verify Table Columns / 테이블 컬럼 확인
```bash
steampipe query "SELECT column_name FROM information_schema.columns WHERE table_name = 'aws_NEW_TABLE'" --output json --input=false
```

### 2. Create Query File / 쿼리 파일 생성
```bash
# src/lib/queries/newservice.ts
export const queries = {
  summary: `SELECT COUNT(*) AS total FROM aws_new_table`,
  list: `SELECT col1, col2 FROM aws_new_table ORDER BY col1`,
  detail: `SELECT * FROM aws_new_table WHERE id = '{id}'`,
};
```

### 3. Create Page / 페이지 생성
```bash
# src/app/newservice/page.tsx
# Copy pattern from src/app/ec2/page.tsx
# (src/app/ec2/page.tsx의 패턴을 복사)
# Include: 'use client', fetchData, StatsCard, DataTable, detail panel
# (포함 항목: 'use client', fetchData, StatsCard, DataTable, 상세 패널)
```

### 4. Add to Sidebar / 사이드바에 추가
Edit `src/components/layout/Sidebar.tsx`:
(`src/components/layout/Sidebar.tsx` 편집:)
- Add to appropriate `navGroup` (Compute, Network, Storage, Monitoring, Security)
  (적절한 `navGroup`에 추가 — Compute, Network, Storage, Monitoring, Security)
- Import icon from `lucide-react`
  (`lucide-react`에서 아이콘 임포트)

### 5. Build & Verify / 빌드 및 검증
```bash
npm run build
bash scripts/09-verify.sh
```

## Checklist / 체크리스트
- [ ] fetch URL uses `/awsops/api/steampipe` (fetch URL이 `/awsops/api/steampipe`를 사용하는지 확인)
- [ ] Component imports are default (not named) (컴포넌트 임포트가 default인지 확인 — named 아님)
- [ ] StatsCard color uses name ('cyan') not hex (StatsCard color에 이름('cyan')을 사용하는지 확인 — hex 아님)
- [ ] No SCP-blocked columns in list query (리스트 쿼리에 SCP 차단 컬럼이 없는지 확인)
- [ ] Detail panel uses Section/Row helpers (상세 패널이 Section/Row 헬퍼를 사용하는지 확인)
