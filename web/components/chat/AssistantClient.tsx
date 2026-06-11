'use client';
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import SectionPicker from './SectionPicker';
import PresetChips from './PresetChips';
import Composer from './Composer';
import MessageList from './MessageList';
import ThreadList from './ThreadList';
import { sectionByKey } from '@/lib/sections';
import { useChat } from './useChat';

/**
 * Full-page assistant (/assistant). Same useChat engine + the same Aurora-backed
 * threads as the drawer, so a conversation started in either surface is visible
 * in the other. A `?thread=<id>` query (set by the drawer's "open full screen"
 * button) restores that conversation on entry.
 */
export default function AssistantClient() {
  const chat = useChat();
  const params = useSearchParams();
  const wantedThread = params.get('thread');
  const inited = useRef(false);

  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    chat.toggleThreads(); // page always shows the thread column → load list + keep it fresh post-send
    const tid = wantedThread ?? localStorage.getItem('awsops_chat_thread');
    if (tid) void chat.selectThread(tid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSec = chat.threadId && chat.msgs.length
    ? sectionByKey(chat.msgs.filter((m) => m.gateway).slice(-1)[0]?.gateway ?? '')
    : null;
  const title = chat.threads.find((t) => t.id === chat.threadId)?.title ?? '새 대화';

  return (
    <div className="flex h-full">
      {/* thread rail */}
      <div className="w-72 shrink-0 border-r border-ink-100">
        <ThreadList threads={chat.threads} activeId={chat.threadId} onSelect={chat.selectThread} onDelete={chat.removeThread} onNew={chat.newChat} />
      </div>

      {/* conversation */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-ink-100 px-6 py-3.5">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink-800">
            <Sparkles size={17} className="text-claude-500" />
            <span className="truncate">{title}</span>
          </div>
          {activeSec && (
            <span className="flex items-center gap-1 text-[12px] font-medium" style={{ color: activeSec.color }}>
              {activeSec.icon} {activeSec.label}
            </span>
          )}
        </header>

        <SectionPicker pinned={chat.pinned} onPin={chat.setPinned} />

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
            {chat.msgs.length === 0
              ? <PresetChips pinned={chat.pinned} onPick={chat.send} />
              : <MessageList msgs={chat.msgs} onSwitch={chat.resendWith} />}
            <Composer disabled={chat.busy} onSend={chat.send} />
          </div>
        </div>
      </div>
    </div>
  );
}
