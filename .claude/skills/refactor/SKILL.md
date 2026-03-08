# Skill: Refactor / 스킬: 리팩토링

## When to Use / 사용 시점
Refactor existing pages, components, or queries for consistency and performance.
(일관성과 성능 향상을 위해 기존 페이지, 컴포넌트 또는 쿼리를 리팩토링합니다.)

## Steps / 단계

### 1. Analyze Current State / 현재 상태 분석
- Read the file to understand current implementation (파일을 읽어 현재 구현 파악)
- Check for violations of CLAUDE.md rules (CLAUDE.md 규칙 위반 확인)
- Identify duplicated patterns (중복 패턴 식별)

### 2. Common Refactoring Patterns / 일반적인 리팩토링 패턴

#### Extract Detail Panel / 상세 패널 추출
If a page has inline detail rendering, extract to the standard pattern:
(페이지에 인라인 상세 렌더링이 있으면 표준 패턴으로 추출합니다:)
```tsx
{(selected || detailLoading) && (
  <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelected(null)}>
    <div className="absolute inset-0 bg-black/50" />
    <div className="relative w-full max-w-2xl h-full bg-navy-800 border-l border-navy-600 overflow-y-auto shadow-2xl animate-fade-in"
      onClick={(e) => e.stopPropagation()}>
      {/* Header + Content + Section/Row helpers */}
      {/* (헤더 + 콘텐츠 + Section/Row 헬퍼) */}
    </div>
  </div>
)}
```

#### Standardize Query File / 쿼리 파일 표준화
Every query file should export:
(모든 쿼리 파일은 다음을 export 해야 합니다:)
- `summary` — aggregated counts for StatsCards (StatsCard용 집계 수)
- `list` — main table data, avoid SCP-blocked columns (메인 테이블 데이터, SCP 차단 컬럼 제외)
- `detail` — full resource details with WHERE clause (WHERE 절이 포함된 전체 리소스 상세)
- Optional: distribution queries for charts (선택: 차트용 분포 쿼리)

#### Consolidate Fetch Pattern / Fetch 패턴 통합
All pages should use:
(모든 페이지는 다음 패턴을 사용해야 합니다:)
```tsx
const fetchData = useCallback(async (bustCache = false) => {
  setLoading(true);
  try {
    const res = await fetch(bustCache ? '/awsops/api/steampipe?bustCache=true' : '/awsops/api/steampipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: { ... } }),
    });
    setData(await res.json());
  } catch {} finally { setLoading(false); }
}, []);
```

### 3. Verify / 검증
- `npm run build` passes (`npm run build` 통과 확인)
- `bash scripts/09-verify.sh` shows no new failures (`bash scripts/09-verify.sh`에서 새로운 실패 없음 확인)
