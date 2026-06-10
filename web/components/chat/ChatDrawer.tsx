'use client';
import { useEffect, useRef, useState } from 'react';
import SectionPicker from './SectionPicker';
import PresetChips from './PresetChips';
import Composer from './Composer';
import MessageList, { type Msg } from './MessageList';
import ThreadList from './ThreadList';
import { sectionByKey } from '@/lib/sections';
import type { ThreadSummary, ThreadMessage } from '@/lib/chat-store';

function newSessionId(): string {
  const s = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  return s.length >= 33 ? s : s.padEnd(36, '0');
}

export default function ChatDrawer() {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [showThreads, setShowThreads] = useState(false);
  const sessionRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null); // mirrors threadId for use inside send()
  function setThread(id: string | null) {
    threadIdRef.current = id;
    setThreadId(id);
    if (id) localStorage.setItem('awsops_chat_thread', id);
    else localStorage.removeItem('awsops_chat_thread');
  }

  useEffect(() => {
    let sid = localStorage.getItem('awsops_chat_session');
    if (!sid) { sid = newSessionId(); localStorage.setItem('awsops_chat_session', sid); }
    sessionRef.current = sid;
    // Restore the active thread across reloads; selectThread cleans up a stale key on 404.
    const tid = localStorage.getItem('awsops_chat_thread');
    if (tid) void selectThread(tid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function newChat() {
    abortRef.current?.abort();
    const sid = newSessionId();
    localStorage.setItem('awsops_chat_session', sid);
    sessionRef.current = sid;
    setThread(null); // previous conversation stays on the server — switching, not wiping
    setMsgs([]); setBusy(false);
  }

  async function openThreads() {
    try {
      const res = await fetch('/api/chat/threads');
      const data = res.ok ? await res.json() : { threads: [] };
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch {
      setThreads([]);
    }
    setShowThreads(true);
  }

  async function selectThread(id: string) {
    try {
      const res = await fetch(`/api/chat/threads/${id}`);
      if (!res.ok) { // stale/foreign thread — clear so it doesn't stick as blank history (P2 r2)
        if (threadIdRef.current === id || localStorage.getItem('awsops_chat_thread') === id) setThread(null);
        return;
      }
      const data: { thread: ThreadSummary; messages: ThreadMessage[] } = await res.json();
      setMsgs(data.messages.map((m) => {
        const meta = (m.meta ?? {}) as { ranked?: Msg['ranked']; method?: string };
        return { role: m.role, content: m.content, gateway: m.gateway ?? undefined, ranked: meta.ranked, method: meta.method };
      }));
      sessionRef.current = data.thread.sessionId;
      localStorage.setItem('awsops_chat_session', data.thread.sessionId);
      setThread(id);
      setShowThreads(false);
    } catch { /* degrade: keep current view */ }
  }

  async function removeThread(id: string) {
    try { await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' }); } catch { /* best-effort */ }
    if (threadIdRef.current === id) newChat();
    void openThreads(); // refresh the list
  }

  async function send(prompt: string, overrideSection?: string, switchedFrom?: string) {
    if (busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: prompt }, { role: 'assistant', content: '', streaming: true }]);
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, messages: history, section: overrideSection ?? pinned, switchedFrom, sessionId: sessionRef.current, threadId: threadIdRef.current ?? undefined }),
      });
      if (!res.ok || !res.body) {
        patchLast((m) => ({ ...m, content: res.status === 401 ? '세션이 만료되었습니다. 새로고침해 주세요.' : 'AI 응답을 받지 못했습니다.', streaming: false }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) handleFrame(f);
      }
    } catch {
      patchLast((m) => ({ ...m, streaming: false }));
    } finally {
      patchLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  function handleFrame(frame: string) {
    const isMeta = frame.startsWith('event: meta');
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    try {
      const obj = JSON.parse(data);
      if (isMeta && obj.threadId) setThread(obj.threadId); // server-issued thread (first message mints it)
      if (isMeta && obj.gateway) patchLast((m) => ({ ...m, gateway: obj.gateway, ranked: obj.ranked, method: obj.method }));
      else if (obj.delta !== undefined) patchLast((m) => ({ ...m, content: m.content + obj.delta }));
      else if (obj.error) patchLast((m) => ({ ...m, content: `⚠️ ${obj.error}`, streaming: false }));
    } catch { /* heartbeat / non-JSON */ }
  }
  function patchLast(fn: (m: Msg) => Msg) {
    setMsgs((arr) => arr.map((m, i) => (i === arr.length - 1 && m.role === 'assistant' ? fn(m) : m)));
  }
  function resendWith(sectionKey: string) {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    // Only count as a misroute candidate if the previous answer came from a LIVE agent —
    // switching away from an inactive-section guidance bubble is not a misroute (ADR-038 §5).
    const prevGateway = lastAssistant?.gateway;
    const switchedFrom = prevGateway && sectionByKey(prevGateway)?.active ? prevGateway : undefined;
    if (lastUser) void send(lastUser.content, sectionKey, switchedFrom);
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label="AI 어시스턴트 열기"
        style={{ position: 'fixed', right: 16, bottom: 16, width: 46, height: 46, borderRadius: '50%', background: '#00d4ff', color: '#06121f', border: 'none', fontSize: 20, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px #00d4ff55' }}>✦</button>
    );
  }
  return (
    <div style={{ position: 'fixed', right: 0, top: 0, height: '100vh', width: 460, background: '#0f1629', borderLeft: '2px solid #00d4ff', boxShadow: '-12px 0 28px #000a', display: 'flex', flexDirection: 'column', zIndex: 50 }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #1a2540', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>AWSops Assistant</span>
        <span>
          <button onClick={openThreads} title="대화 목록" aria-label="대화 목록" style={iconBtn}>☰</button>
          <button onClick={newChat} title="새 대화" style={iconBtn}>＋</button>
          <button onClick={() => { abortRef.current?.abort(); setOpen(false); }} title="닫기" style={iconBtn}>✕</button>
        </span>
      </div>
      <SectionPicker pinned={pinned} onPin={setPinned} />
      {msgs.length === 0 ? <PresetChips pinned={pinned} onPick={send} /> : <MessageList msgs={msgs} onSwitch={resendWith} />}
      <Composer disabled={busy} onSend={send} />
      {showThreads && <ThreadList threads={threads} activeId={threadId} onSelect={selectThread} onDelete={removeThread} onClose={() => setShowThreads(false)} />}
    </div>
  );
}
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#7da2c9', fontSize: 15, cursor: 'pointer', marginLeft: 8 };
