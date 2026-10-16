import { ChatsService } from './chats.service';

function make(conv: any, latest: any) {
  const prisma: any = {
    whatsAppAccount: { findFirst: async () => ({ id: 'a1' }) },
    conversation: { findMany: async () => [conv], count: async () => 1 },
    message: { findFirst: async () => latest },
  };
  const svc: any = new ChatsService(prisma);
  svc.getAccount = async () => ({ id: 'a1' });
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
