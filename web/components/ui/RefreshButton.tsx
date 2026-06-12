'use client';
import { RotateCw } from 'lucide-react';
import Button from './Button';
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
  const age = capturedAt ? `업데이트: ${new Date(capturedAt).toLocaleString('ko-KR')}` : '미수집';
  const stale = capturedAt ? Date.now() - new Date(capturedAt).getTime() > 30 * 60 * 1000 : false;
  return (
    <div className="flex items-center gap-2.5">
      <Button variant="secondary" size="sm" onClick={onClick} disabled={busy}>
        <RotateCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
        {busy ? '수집 중…' : 'Refresh'}
      </Button>
      <span className={cn('text-[11px]', stale ? 'text-claude-700' : 'text-ink-400')}>
        {age}
        {stale ? ' (오래됨)' : ''}
      </span>
    </div>
  );
}
