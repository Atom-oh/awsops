'use client';
import { evidenceLabels, type ChatEvidence, type SourceStatus } from '@/lib/chat-evidence';
import { useI18n } from '@/components/shell/LanguageProvider';

const labels = {
  ko: { receipts: '도구 호출 근거', requested: '요청 범위', observed: '관측 범위', unknown: '알 수 없음',
    publication: '그래프 게시 시각', sources: '최근 시도 입력', published: '마지막 게시 입력', stale: '오래되거나 불완전한 원본',
    bounded: '일부 근거 생략', timing: '시각은 스트림 관측 시점이며 실행 시간이 아닙니다.' },
  en: { receipts: 'Tool call evidence', requested: 'Requested scope', observed: 'Observed scope', unknown: 'Unknown',
    publication: 'Graph publication time', sources: 'Latest attempted input', published: 'Last published input', stale: 'Stale or incomplete sources',
    bounded: 'Some evidence omitted', timing: 'Times are stream observations, not execution durations.' },
  zh: { receipts: '工具调用证据', requested: '请求范围', observed: '观测范围', unknown: '未知',
    publication: '图发布时刻', sources: '最近尝试的输入', published: '最后发布的输入', stale: '来源过期或不完整',
    bounded: '部分证据已省略', timing: '时间为流观测时刻，并非执行时长。' },
  ja: { receipts: 'ツール呼び出しの根拠', requested: '要求範囲', observed: '観測範囲', unknown: '不明',
    publication: 'グラフ公開時刻', sources: '最新の試行入力', published: '最終公開の入力', stale: '古い、または不完全なソース',
    bounded: '一部の根拠を省略', timing: '時刻はストリーム観測時点であり、実行時間ではありません。' },
};

const sourceLabels: Record<keyof typeof labels, Record<SourceStatus, string>> = {
  en: { ok: 'Available', empty: 'No results', partial: 'Incomplete', unavailable: 'Unavailable', error: 'Failed', unknown: 'Unknown' },
  ko: { ok: '사용 가능', empty: '결과 없음', partial: '불완전', unavailable: '사용 불가', error: '실패', unknown: '알 수 없음' },
  zh: { ok: '可用', empty: '无结果', partial: '不完整', unavailable: '不可用', error: '失败', unknown: '未知' },
  ja: { ok: '利用可能', empty: '結果なし', partial: '不完全', unavailable: '利用不可', error: '失敗', unknown: '不明' },
};

export default function EvidenceStatus({ evidence }: { evidence?: ChatEvidence }) {
  const { lang } = useI18n();
  const l = labels[lang], states = evidenceLabels[lang];
  return <div className="mt-2 space-y-1 text-[11px] text-ink-500">
    <div className="font-semibold">{states[evidence?.fallback ?? evidence?.status ?? 'unverified']}</div>
    {evidence?.truncated || evidence?.invalid ? <div>{l.bounded}</div> : null}
    {evidence?.domains.map(d => <div key={d.gateway}>
      <div>{d.gateway}: {states[d.status]}{d.truncated ? ` · ${l.bounded}` : ''}</div>
      {d.receipts.length > 0 ? <details className="mt-1">
        <summary className="cursor-pointer">{l.receipts} ({d.receipts.length})</summary>
        <p>{l.timing}</p>
        {d.receipts.map(r => <div key={r.callId} className="my-2 border-l border-ink-100 pl-2">
          <div>{r.tool} · {r.callId} · {states[r.outcome]}</div>
          <div>{l.requested}: {Object.values(r.requestedScope).join(', ') || l.unknown}</div>
          <div>{l.observed}: {Object.values(r.observedScope).join(', ') || l.unknown}</div>
          <div>{new Date(r.observedAt).toISOString()}{r.terminalObservedAt !== undefined ? ` → ${new Date(r.terminalObservedAt).toISOString()}` : ''}</div>
          {r.quality?.truncated ? <div>{l.bounded}</div> : null}
          {r.quality?.collection ? <div>
            {r.quality.collection.stale || r.quality.collection.retainedPrevious ? <div>{l.stale}</div> : null}
            <div>{l.publication}: {r.quality.collection.captured_at ?? l.unknown}</div>
            {(['sources', 'publishedSources'] as const).map(key => <div key={key}>
              {key === 'sources' ? l.sources : l.published}: {r.quality?.collection?.[key]?.map(s =>
                `${s.sourceId ?? l.unknown} (${sourceLabels[lang][s.status]}; ${s.capturedAtMs == null ? l.unknown : new Date(s.capturedAtMs).toISOString()})`).join(', ') || l.unknown}
            </div>)}
          </div> : null}
        </div>)}
      </details> : null}
    </div>)}
  </div>;
}
