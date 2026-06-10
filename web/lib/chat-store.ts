import { getPool } from './db';

// Chat thread persistence (P3-A follow-up). Same contract as trace.ts:
// fire-and-forget writes NEVER throw and silently no-op without Aurora.

export interface ThreadSummary { id: string; title: string; sessionId: string; updatedAt: string }
export interface ThreadMessage { role: 'user' | 'assistant'; content: string; gateway: string | null; meta: unknown; createdAt: string }
export interface ExchangeInput {
  threadId: string; userSub: string; sessionId: string; promptTitle: string;
  userContent: string; assistantContent: string; gateway?: string; meta?: unknown;
}

const on = () => !!process.env.AURORA_ENDPOINT;

/** Record one user→assistant exchange. Owner-guarded upsert; never throws (chat must not block). */
export async function recordExchange(x: ExchangeInput): Promise<void> {
  if (!on()) return;
  try {
    const pool = getPool();
    // Upsert the thread; the WHERE guard means a foreign threadId updates nothing → no RETURNING row.
    const up = await pool.query(
      `INSERT INTO chat_threads (id, user_sub, title, session_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()
       WHERE chat_threads.user_sub = EXCLUDED.user_sub
       RETURNING id`,
      [x.threadId, x.userSub, x.promptTitle, x.sessionId],
    );
    if (up.rows.length === 0) {
      console.warn(JSON.stringify({ evt: 'chat_thread_owner_mismatch', threadId: x.threadId }));
      return;
    }
    // NOTE: three non-transactional queries — a mid-failure can leave a user-only message;
    // harmless for fire-and-forget (next exchange records normally). Transactionality = YAGNI (P2 gate).
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content) VALUES ($1, 'user', $2)`,
      [x.threadId, x.userContent],
    );
    await pool.query(
      `INSERT INTO chat_messages (thread_id, role, content, gateway, meta) VALUES ($1, 'assistant', $2, $3, $4::jsonb)`,
      [x.threadId, x.assistantContent, x.gateway ?? null, x.meta ? JSON.stringify(x.meta) : null],
    );
  } catch (e) {
    console.warn(`[chat-store] record failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function listThreads(userSub: string): Promise<ThreadSummary[]> {
  if (!on()) return [];
  const r = await getPool().query(
    `SELECT id, title, session_id, updated_at FROM chat_threads
     WHERE user_sub = $1 ORDER BY updated_at DESC LIMIT 20`,
    [userSub],
  );
  return r.rows.map((t) => ({ id: t.id, title: t.title, sessionId: t.session_id, updatedAt: new Date(t.updated_at).toISOString() }));
}

export async function getThread(userSub: string, threadId: string): Promise<{ thread: ThreadSummary; messages: ThreadMessage[] } | null> {
  if (!on()) return null;
  const t = await getPool().query(
    `SELECT id, title, session_id, updated_at FROM chat_threads WHERE id = $1 AND user_sub = $2`,
    [threadId, userSub],
  );
  if (t.rows.length === 0) return null;
  const m = await getPool().query(
    `SELECT role, content, gateway, meta, created_at FROM chat_messages
     WHERE thread_id = $1 ORDER BY id ASC LIMIT 200`,
    [threadId],
  );
  const th = t.rows[0];
  return {
    thread: { id: th.id, title: th.title, sessionId: th.session_id, updatedAt: new Date(th.updated_at).toISOString() },
    messages: m.rows.map((r) => ({ role: r.role, content: r.content, gateway: r.gateway, meta: r.meta, createdAt: new Date(r.created_at).toISOString() })),
  };
}

export async function deleteThread(userSub: string, threadId: string): Promise<boolean> {
  if (!on()) return false;
  const r = await getPool().query(`DELETE FROM chat_threads WHERE id = $1 AND user_sub = $2`, [threadId, userSub]);
  return (r.rowCount ?? 0) > 0;
}
