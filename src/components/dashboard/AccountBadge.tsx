'use client';

import { useAccountContext } from '@/contexts/AccountContext';

export default function AccountBadge({ accountId }: { accountId: string }) {
  const { accounts } = useAccountContext();
  const account = accounts.find(a => a.accountId === accountId);
  const alias = account?.alias || accountId;
  const isHost = account?.isHost || false;

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${isHost ? 'bg-green-400' : 'bg-cyan-400'}`} />
      <span className="text-gray-300">{alias}</span>
    </span>
  );
}
