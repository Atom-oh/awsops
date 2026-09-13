'use client';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { ReportHandoffData } from '@/lib/report-handoff';
import type { Lang } from '@/lib/i18n';

type Labels = Record<'title' | 'target' | 'preview' | 'copy' | 'download' | 'copied'
  | 'downloaded' | 'failed' | 'downloadFailed' | 'unavailable' | 'note', string>;
const LABELS = {
  en: { title: 'Manual report handoff', target: 'Draft target', preview: 'Draft preview',
    copy: 'Copy draft', download: 'Download draft', copied: 'Copied draft.', downloaded: 'Draft download prepared.',
    failed: 'Copy failed. Select the preview or download the draft.', downloadFailed: 'Download failed. Copy the preview instead.',
    unavailable: 'Draft unavailable: a completed report with readable evidence is required.',
    note: 'Manual transfer only. Nothing is published and no external agent is invoked. Review the draft and its audience.' },
  ko: { title: '리포트 수동 전달', target: '초안 대상', preview: '초안 미리보기',
    copy: '초안 복사', download: '초안 다운로드', copied: '초안을 복사했습니다.', downloaded: '초안 다운로드를 준비했습니다.',
    failed: '복사 실패. 미리보기를 선택하거나 초안을 다운로드하세요.', downloadFailed: '다운로드 실패. 미리보기를 복사하세요.',
    unavailable: '초안을 만들 수 없습니다. 완료된 리포트와 읽을 수 있는 근거가 필요합니다.',
    note: '수동 전달용입니다. 외부 게시나 에이전트 호출은 수행하지 않습니다. 초안과 수신 대상을 검토하세요.' },
  zh: { title: '手动移交报告', target: '草稿目标', preview: '草稿预览',
    copy: '复制草稿', download: '下载草稿', copied: '已复制草稿。', downloaded: '已准备草稿下载。',
    failed: '复制失败。请选择预览文本或下载草稿。', downloadFailed: '下载失败。请复制预览文本。',
    unavailable: '草稿不可用：需要已完成且证据可读的报告。',
    note: '仅供手动移交。不会发布内容或调用外部代理。请审核草稿及接收对象。' },
  ja: { title: 'レポートの手動引き継ぎ', target: '下書きの対象', preview: '下書きプレビュー',
    copy: '下書きをコピー', download: '下書きをダウンロード', copied: '下書きをコピーしました。', downloaded: '下書きのダウンロードを準備しました。',
    failed: 'コピーに失敗しました。プレビューを選択するかダウンロードしてください。', downloadFailed: 'ダウンロードに失敗しました。プレビューをコピーしてください。',
    unavailable: '下書きを作成できません。完了済みで根拠を読み取れるレポートが必要です。',
    note: '手動引き継ぎ用です。外部への公開やエージェント呼び出しは行いません。下書きと共有先を確認してください。' },
} satisfies Record<Lang, Labels>;

export default function ReportHandoff({ handoff }: { handoff: ReportHandoffData | null }) {
  const { lang } = useI18n();
  const labels = LABELS[lang] ?? LABELS.en;
  const [target, setTarget] = useState('notion');
  const [message, setMessage] = useState('');
  const draft = handoff?.drafts.find(d => d.target === target) ?? handoff?.drafts[0];
  const current = useRef(draft?.text);
  current.current = draft?.text;
  useEffect(() => { setMessage(''); }, [draft?.text]);
  async function copy() {
    if (!draft) return;
    const text = draft.text;
    try {
      await navigator.clipboard.writeText(text);
      if (current.current === text) setMessage(labels.copied);
    } catch { if (current.current === text) setMessage(labels.failed); }
  }
  function download() {
    if (!draft) return;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([draft.text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = draft.filename;
      document.body.appendChild(link);
      link.click(); link.remove();
      setMessage(labels.downloaded);
    } catch { setMessage(labels.downloadFailed); }
    finally { if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000); }
  }
  return (
    <details className="mb-4 rounded-md border border-ink-200 bg-card p-3">
      <summary className="cursor-pointer text-sm font-medium text-ink-800">{labels.title}</summary>
      <p className="my-2 text-[12px] text-ink-500">{labels.note}</p>
      {!draft ? <p className="text-sm text-ink-500">{labels.unavailable}</p> : <>
        <label className="block text-sm text-ink-700">{labels.target}
          <select aria-label={labels.target} value={draft.target} onChange={e => setTarget(e.target.value)}
            className="my-2 block w-full rounded border border-ink-200 bg-card p-2">
            {handoff!.drafts.map(d => <option key={d.target} value={d.target}>{d.label}</option>)}
          </select>
        </label>
        <textarea aria-label={labels.preview} readOnly value={draft.text} rows={12}
          className="w-full rounded border border-ink-200 bg-paper p-2 text-[12px] text-ink-800" />
        <p className="my-2 text-[12px] text-ink-500">{handoff!.notices.join(' ')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={copy} className="rounded border border-ink-200 px-3 py-1.5 text-sm">{labels.copy}</button>
          <button type="button" onClick={download} className="rounded border border-ink-200 px-3 py-1.5 text-sm">{labels.download}</button>
        </div>
        {message && <p role="status" className="mt-2 text-sm text-ink-600">{message}</p>}
      </>}
    </details>
  );
}
