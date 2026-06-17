'use client';
import { useEffect, useRef, useState } from 'react';
import type { Msg } from './MessageList';
import { sectionByKey } from '@/lib/sections';
import type { ThreadSummary, ThreadMessage } from '@/lib/chat-store';

export function newSessionId(): string {
  const s = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`);
  return s.length >= 33 ? s : s.padEnd(36, '0');
}

/**
 * Shared chat engine for the drawer (ChatDrawer) and the /assistant page.
 * Owns conversation state, SSE streaming, and thread CRUD against the same
 * Aurora-backed endpoints — so both surfaces share one history.
 *
 * UI-specific concerns (drawer open/resize, page query restore, the
 * `awsops:open-chat` event) live in the consumers, not here. Every action only
 * touches refs/setters, so a consumer may capture them once in a mount effect
 * without stale-closure hazards.
 */
export function useChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [showThreads, setShowThreads] = useState(false);
  const sessionRef = useRef<string>('');
  const abortRef = useRef<AbortController | null>(null);
  const threadIdRef = useRef<string | null>(null); // mirrors threadId for use inside send()
  const showThreadsRef = useRef(false);            // mirrors showThreads for post-send refresh

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
  }, []);

  function newChat() {
    abortRef.current?.abort();
    const sid = newSessionId();
    localStorage.setItem('awsops_chat_session', sid);
    sessionRef.current = sid;
    setThread(null); // previous conversation stays on the server — switching, not wiping
    setMsgs([]); setBusy(false);
  }

  async function refreshThreads() {
    try {
      const res = await fetch('/api/chat/threads');
      const data = res.ok ? await res.json() : { threads: [] };
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch {
      setThreads([]);
    }
  }

  function toggleThreads() {
    const next = !showThreadsRef.current;
    showThreadsRef.current = next;
    setShowThreads(next);
    if (next) void refreshThreads();
  }

  async function selectThread(id: string) {
    abortRef.current?.abort(); // an in-flight stream must not patch into the restored thread
    setBusy(false);
    try {
      const res = await fetch(`/api/chat/threads/${id}`);
      if (!res.ok) { // stale/foreign thread — clear so it doesn't stick as blank history
        if (threadIdRef.current === id || localStorage.getItem('awsops_chat_thread') === id) setThread(null);
        return;
      }
      const data: { thread: ThreadSummary; messages: ThreadMessage[] } = await res.json();
      setMsgs(data.messages.map((m) => {
        const meta = (m.meta ?? {}) as { ranked?: Msg['ranked']; method?: string; via?: string };
        return { role: m.role, content: m.content, gateway: m.gateway ?? undefined, ranked: meta.ranked, method: meta.method, via: meta.via };
      }));
      sessionRef.current = data.thread.sessionId;
      localStorage.setItem('awsops_chat_session', data.thread.sessionId);
      setThread(id);
    } catch { /* degrade: keep current view */ }
  }

  async function removeThread(id: string) {
    try { await fetch(`/api/chat/threads/${id}`, { method: 'DELETE' }); } catch { /* best-effort */ }
    if (threadIdRef.current === id) newChat();
    void refreshThreads();
  }

  function patchLast(fn: (m: Msg) => Msg) {
    setMsgs((arr) => arr.map((m, i) => (i === arr.length - 1 && m.role === 'assistant' ? fn(m) : m)));
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
      if (isMeta && obj.gateway) patchLast((m) => ({ ...m, gateway: obj.gateway, ranked: obj.ranked, method: obj.method, via: obj.via }));
      else if (obj.delta !== undefined) patchLast((m) => ({ ...m, content: m.content + obj.delta }));
      else if (obj.error) patchLast((m) => ({ ...m, content: `⚠️ ${obj.error}`, streaming: false }));
    } catch { /* heartbeat / non-JSON */ }
  }

  async function send(prompt: string, overrideSection?: string | null, switchedFrom?: string) {
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
        body: JSON.stringify({ prompt, messages: history, section: overrideSection ?? null, switchedFrom, sessionId: sessionRef.current, threadId: threadIdRef.current ?? undefined }),
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
      if (showThreadsRef.current) void refreshThreads(); // new title/order shows up immediately
    }
  }

  function resendWith(sectionKey: string) {
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant');
    // Only a misroute candidate if the previous answer came from a LIVE agent —
    // switching away from an inactive-section guidance bubble is not a misroute (ADR-038 §5).
    const prevGateway = lastAssistant?.gateway;
    const switchedFrom = prevGateway && sectionByKey(prevGateway)?.active ? prevGateway : undefined;
    if (lastUser) void send(lastUser.content, sectionKey, switchedFrom);
  }

  function abort() { abortRef.current?.abort(); }

  return {
    // state
    msgs, busy, threadId, threads, showThreads,
    // actions
    send, selectThread, newChat, refreshThreads, removeThread, toggleThreads, resendWith, abort,
  };
}

export type UseChat = ReturnType<typeof useChat>;
