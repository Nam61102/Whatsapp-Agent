import { ChatsService } from './chats.service';

function make(conv: any, latest: any) {
  const prisma: any = {
    whatsAppAccount: { findFirst: async () => ({ id: 'a1' }) },
    conversation: { findMany: async () => [conv], count: async () => 1 },
  };
  const svc: any = new ChatsService(prisma);
  svc.getAccount = async () => ({ id: 'a1' });
  // the single aggregate query returns one row per chat
  svc.latestMessages = async (ids: string[]) => {
    const m = new Map<string, any>();
    if (latest) {
      const g = latest.metadata?.senderName ?? null;
      for (const id of ids) m.set(id, { text: latest.textContent, at: latest.messageTimestamp, isFromMe: latest.isFromMe, sender: g });
    }
    return m;
  };
  return svc;
}

describe('chat list matches the latest message in the chat', () => {
  const when = new Date('2026-10-16T16:36:26Z');
  it('uses the real latest text and time, not the saved copy', async () => {
    const svc = make(
      { id: 'c1', chatType: 'INDIVIDUAL', externalChatId: '1@s.whatsapp.net', lastMessageText: '', lastMessageAt: new Date('2026-10-14T00:00:00Z') },
      { textContent: 'see you at 5', isFromMe: false, messageTimestamp: when, metadata: {}, senderContact: null }
    );
    const r = await svc.getChats('u1');
    expect(r.conversations[0].lastMessageText).toBe('see you at 5');
    expect(r.conversations[0].lastMessageAt).toEqual(when);
  });
  it('prefixes group previews with the sender, like WhatsApp', async () => {
    const svc = make(
      { id: 'c2', chatType: 'GROUP', externalChatId: '1@g.us', lastMessageText: null, lastMessageAt: when },
      { textContent: 'hello all', isFromMe: false, messageTimestamp: when, metadata: { senderName: 'Amit' }, senderContact: null }
    );
    expect((await svc.getChats('u1')).conversations[0].lastMessageText).toBe('Amit: hello all');
  });
  it('shows a placeholder for media without text and keeps chats with no messages', async () => {
    const media = make({ id: 'c3', chatType: 'INDIVIDUAL', externalChatId: '2@s.whatsapp.net' }, { textContent: null, isFromMe: true, messageTimestamp: when, metadata: {}, senderContact: null });
    expect((await media.getChats('u1')).conversations[0].lastMessageText).toBe('[Message]');
    const none = make({ id: 'c4', chatType: 'INDIVIDUAL', externalChatId: '3@s.whatsapp.net', lastMessageText: 'kept', lastMessageAt: when }, null);
    expect((await none.getChats('u1')).conversations[0].lastMessageText).toBe('kept');
  });
});

describe('latestMessages (single query)', () => {
  it('reads one row per chat from the aggregate and ignores bad dates', async () => {
    const calls: any[] = [];
    const prisma: any = {
      $runCommandRaw: async (cmd: any) => (calls.push(cmd), {
        cursor: { firstBatch: [
          { _id: { $oid: 'c1' }, text: 'hi', at: { $date: '2026-10-16T16:36:26Z' }, isFromMe: true, sender: null },
          { _id: { $oid: 'c2' }, text: 'x', at: 'not a date', isFromMe: false },
        ] },
      }),
    };
    const svc: any = new ChatsService(prisma);
    const m = await svc.latestMessages(['c1', 'c2']);
    expect(calls).toHaveLength(1); // one round trip for all chats
    expect(m.get('c1')).toMatchObject({ text: 'hi', isFromMe: true });
    expect(m.has('c2')).toBe(false);
    expect((await svc.latestMessages([])).size).toBe(0);
  });
});
