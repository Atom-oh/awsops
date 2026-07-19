'use client';
import { RotateCw } from 'lucide-react';
import Button from './Button';
import { useI18n } from '@/components/shell/LanguageProvider';
import { cn } from '@/lib/cn';

export default function RefreshButton({
  busy,
  onClick,
  capturedAt,
}: {
  busy: boolean;
  onClick: () => void;
  capturedAt?: string | null;
}) {
  const { locale, t } = useI18n();
  const age = capturedAt
    ? t('common.updated', { date: new Date(capturedAt).toLocaleString(locale) })
    : t('common.notCollected');
  const stale = capturedAt ? Date.now() - new Date(capturedAt).getTime() > 30 * 60 * 1000 : false;
  return (
    <div className="flex items-center gap-2.5">
      <Button variant="secondary" size="sm" onClick={onClick} disabled={busy}>
        <RotateCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {busy ? t('common.collecting') : t('common.refresh')}
      </Button>
      <span className={cn('text-[11px]', stale ? 'text-brand-700' : 'text-ink-400')}>
        {age}
        {stale ? ` (${t('common.stale')})` : ''}
      </span>
    </div>
  );
}
