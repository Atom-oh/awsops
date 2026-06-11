import DiagnosisView from '@/components/diagnosis/DiagnosisView';

export const dynamic = 'force-dynamic';

export default function AiDiagnosisPage() {
  return (
    <div className="px-8 py-6">
      <h1 className="mb-1 text-xl font-semibold text-ink-800">AI 진단</h1>
      <p className="mb-6 text-sm text-ink-400">AWS 네이티브 데이터 기반 종합 운영 진단 리포트.</p>
      <DiagnosisView />
    </div>
  );
}
