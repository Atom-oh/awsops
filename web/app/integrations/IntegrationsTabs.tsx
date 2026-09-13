'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/components/shell/LanguageProvider';
import DatasourcesTab from './datasources/DatasourcesTab';
import ConnectorsTab from './connectors/ConnectorsTab';
import AgentsSkillsTab from './agents-skills/AgentsSkillsTab';

// The Integrations hub tab bar. Three distinct categories: Datasources (observability query backends),
// Connectors (external services like Notion), Agents & Skills. `tab` query-param selects the initial tab.
const TABS = [
  { key: 'datasources', label: 'Datasources' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'agents-skills', label: 'Agents & Skills' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function normalize(t?: string): TabKey {
  return TABS.some((x) => x.key === t) ? (t as TabKey) : 'datasources';
}

export default function IntegrationsTabs({ initialTab, canManage = false }: { initialTab?: string; canManage?: boolean }) {
  const { tt } = useI18n();
  const [active, setActive] = useState<TabKey>(normalize(initialTab));
  useEffect(() => { setActive(normalize(initialTab)); }, [initialTab]);

  const select = (k: TabKey) => {
    setActive(k);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', k);
      window.history.replaceState(null, '', url.toString());
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-4">
      <div className="grid gap-3 rounded-lg border border-ink-100 bg-card p-4 sm:grid-cols-3">
        <button onClick={() => select('datasources')} className="text-left space-y-1">
          <span className="block text-sm font-semibold text-brand-600">{tt('1. 운영 데이터 연결')}</span>
          <span className="block text-[12px] text-ink-500">{tt('메트릭·로그·트레이스의 출처와 접속을 확인합니다.')}</span>
        </button>
        <Link href="/ai-diagnosis" className="space-y-1">
          <span className="block text-sm font-semibold text-brand-600">{tt('2. 근거 기반 진단')}</span>
          <span className="block text-[12px] text-ink-500">{tt('조사 범위를 선택하고 관측 근거와 미확인 영역을 정리합니다.')}</span>
        </Link>
        <button onClick={() => select('connectors')} className="text-left space-y-1">
          <span className="block text-sm font-semibold text-brand-600">{tt('3. 보고와 전문 검토')}</span>
          <span className="block text-[12px] text-ink-500">{tt('공유 초안을 검토하고 운영·보안·FinOps 조사로 이어갑니다.')}</span>
        </button>
      </div>
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-ink-100">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            onClick={() => select(t.key)}
            className={`whitespace-nowrap px-4 py-2 text-[13px] rounded-t-md border-b-2 -mb-px ${
              active === t.key ? 'border-brand-500 text-brand-600 font-semibold' : 'border-transparent text-ink-500 hover:text-ink-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div>
        {active === 'datasources' && <DatasourcesTab canManage={canManage} />}
        {active === 'connectors' && <ConnectorsTab canManage={canManage} onShowDatasources={() => select('datasources')} />}
        {active === 'agents-skills' && <AgentsSkillsTab />}
      </div>
    </div>
  );
}
