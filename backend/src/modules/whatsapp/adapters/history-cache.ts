import * as fs from 'fs';
import * as path from 'path';

export interface CachedChat {
  id: string;
  name?: string;
  unreadCount?: number;
  conversationTimestamp?: number;
}
export interface CachedContact {
  id: string;
  lid?: string;
  jid?: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}
export interface CachedMessage {
  key: { remoteJid: string; id: string; fromMe?: boolean; participant?: string };
  pushName?: string;
  messageTimestamp: number;
  message: { conversation: string };
}
export interface CachedHistory {
  chats: CachedChat[];
  contacts: CachedContact[];
  messages: CachedMessage[];
}

interface UserCache {
  chats: Map<string, CachedChat>;
  contacts: Map<string, CachedContact>;
  messages: Map<string, CachedMessage>;
  timer?: NodeJS.Timeout;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 30000;
const WRITE_DEBOUNCE_MS = 5000;

export function toSeconds(ts: any): number {
  if (!ts) return 0;
  const n = typeof ts === 'number' ? ts : typeof ts?.toNumber === 'function' ? ts.toNumber() : Number(ts);
  if (!n || Number.isNaN(n)) return 0;
  return n > 1e11 ? Math.floor(n / 1000) : n;
}

/**
 * WhatsApp only sends chat history once, when a device is first linked. This keeps a
 * slim on-disk copy of everything we receive so "Clear & Re-sync" can rebuild the
 * database without asking WhatsApp again. Lives inside the session folder, so
 * unlinking WhatsApp removes it too.
 */
export class HistoryCache {
  private users = new Map<string, UserCache>();

  private sessionDir(userId: string) {
    return path.join(process.cwd(), 'sessions', userId);
  }
  private file(userId: string) {
    return path.join(this.sessionDir(userId), 'history-cache.json');
  }

  private get(userId: string): UserCache {
    let uc = this.users.get(userId);
    if (uc) return uc;
    uc = { chats: new Map(), contacts: new Map(), messages: new Map() };
    try {
      if (fs.existsSync(this.file(userId))) {
        const raw: CachedHistory = JSON.parse(fs.readFileSync(this.file(userId), 'utf-8'));
        for (const c of raw.chats || []) uc.chats.set(c.id, c);
        for (const c of raw.contacts || []) uc.contacts.set(c.id, c);
        for (const m of raw.messages || []) uc.messages.set(m.key.id, m);
      }
    } catch {}
    this.users.set(userId, uc);
    return uc;
  }

  recordChats(userId: string, chats: Array<{ id?: string | null; name?: any; unreadCount?: any; conversationTimestamp?: any }>) {
    const uc = this.get(userId);
    for (const c of chats) {
      if (!c?.id || c.id === 'status@broadcast') continue;
      const prev = uc.chats.get(c.id);
      const ts = toSeconds(c.conversationTimestamp);
      uc.chats.set(c.id, {
        id: c.id,
        name: (typeof c.name === 'string' && c.name.trim() ? c.name : undefined) ?? prev?.name,
        unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : prev?.unreadCount,
        conversationTimestamp: Math.max(ts, prev?.conversationTimestamp || 0) || undefined,
      });
    }
    this.schedule(userId);
  }

  removeChats(userId: string, chatIds: string[]) {
    const uc = this.get(userId);
    for (const id of chatIds) uc.chats.delete(id);
    this.schedule(userId);
  }

  recordContacts(
    userId: string,
    contacts: Array<{ id?: string | null; lid?: any; jid?: any; name?: any; notify?: any; verifiedName?: any }>
  ) {
    const uc = this.get(userId);
    for (const c of contacts) {
      if (!c?.id || c.id === 'status@broadcast') continue;
      const prev = uc.contacts.get(c.id);
      const str = (v: any) => (typeof v === 'string' && v.trim() ? v : undefined);
      uc.contacts.set(c.id, {
        id: c.id,
        lid: str(c.lid) ?? prev?.lid,
        jid: str(c.jid) ?? prev?.jid,
        name: str(c.name) ?? prev?.name,
        notify: str(c.notify) ?? prev?.notify,
        verifiedName: str(c.verifiedName) ?? prev?.verifiedName,
      });
    }
    this.schedule(userId);
  }

  /** `textOf` turns a raw WhatsApp message into preview text (see unwrapMessage). */
  recordMessages(userId: string, messages: any[], textOf: (m: any) => string) {
    const uc = this.get(userId);
    for (const m of messages) {
      const jid = m?.key?.remoteJid;
      const id = m?.key?.id;
      if (!m?.message || !jid || !id || jid === 'status@broadcast') continue;
      const text = textOf(m.message);
      if (!text) continue;
      const ts = toSeconds(m.messageTimestamp) || Math.floor(Date.now() / 1000);
      uc.messages.set(id, {
        key: { remoteJid: jid, id, fromMe: Boolean(m.key.fromMe), participant: m.key.participant || undefined },
        pushName: m.pushName || undefined,
        messageTimestamp: ts,
        message: { conversation: text },
      });
      const chat = uc.chats.get(jid);
      if (!chat) uc.chats.set(jid, { id: jid, conversationTimestamp: ts });
      else if (ts > (chat.conversationTimestamp || 0)) chat.conversationTimestamp = ts;
    }
    this.schedule(userId);
  }

  snapshot(userId: string): CachedHistory {
    const uc = this.get(userId);
    return {
      chats: [...uc.chats.values()],
      contacts: [...uc.contacts.values()],
      messages: [...uc.messages.values()],
    };
  }

  clear(userId: string) {
    const uc = this.users.get(userId);
    if (uc?.timer) clearTimeout(uc.timer);
    this.users.delete(userId);
  }

  private schedule(userId: string) {
    const uc = this.get(userId);
    if (uc.timer) return;
    uc.timer = setTimeout(() => {
      uc.timer = undefined;
      this.flush(userId);
    }, WRITE_DEBOUNCE_MS);
  }

  private flush(userId: string) {
    const uc = this.users.get(userId);
    // Never recreate a session folder that was deleted by an unlink/logout.
    if (!uc || !fs.existsSync(this.sessionDir(userId))) return;
    const cutoff = Math.floor((Date.now() - MAX_AGE_MS) / 1000);
    let msgs = [...uc.messages.values()].filter((m) => m.messageTimestamp >= cutoff);
    if (msgs.length > MAX_MESSAGES) {
      msgs.sort((a, b) => b.messageTimestamp - a.messageTimestamp);
      msgs = msgs.slice(0, MAX_MESSAGES);
    }
    uc.messages = new Map(msgs.map((m) => [m.key.id, m]));
    const data: CachedHistory = {
      chats: [...uc.chats.values()],
      contacts: [...uc.contacts.values()],
      messages: msgs,
    };
    try {
      const tmp = `${this.file(userId)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file(userId));
    } catch {}
  }
}
