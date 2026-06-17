'use client';
import PageHeader from '@/components/ui/PageHeader';
import ExplorePanel from '@/components/datasources/ExplorePanel';

// NOTE: this standalone page is folded into the Integrations hub (a redirect is added in a later task);
// for now it renders the extracted ExplorePanel so the extraction is behavior-preserving.
export default function DatasourcesPage() {
  return (
    <div>
      <PageHeader
        title="데이터소스 탐색"
        subtitle="연결된 Prometheus·Mimir·Loki·Tempo·ClickHouse를 네이티브 쿼리 언어로 조회합니다 (읽기 전용)."
      />
      <div className="p-6 lg:p-8">
        <ExplorePanel />
      </div>
    </div>
  );
}
