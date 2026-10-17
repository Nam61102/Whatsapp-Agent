import { ChatsService } from './chats.service';
import { ChatTitleService } from './chat-title.service';
import { ContactsService } from '../contacts/contacts.service';
import { DeviceContactsService } from '../../shared/device-contacts.service';

const USER = 'user1';
const ACCOUNT = 'acc1';
const PHONE_JID = '917030513050@s.whatsapp.net';
const LID = '217256709591222@lid';

const savedRow = {
  id: 'c-saved',
  userId: USER,
  whatsappAccountId: ACCOUNT,
  externalContactId: PHONE_JID,
  displayName: 'Namrata Kadam',
  pushName: null,
  phoneNumber: '+917030513050',
  profilePhotoUrl: null,
  about: null,
  isBusiness: false,
  isGroup: false,
  isSavedContact: true,
  lid: null,
  lastSeenAt: null,
  verifiedName: null,
  aiProfile: null,
  conversations: [],
};
const pushRow = {
  ...savedRow,
  id: 'c-push',
  displayName: '💗 Ñ😊mr😊t😊 💗',
  pushName: '💗 Ñ😊mr😊t😊 💗',
  isSavedContact: false,
};
const lidRow = {
  ...savedRow,
  id: 'c-lid',
  externalContactId: LID,
  phoneNumber: null,
  displayName: '❤️ Ñ🤓mr🤓t🤓 ❤️',
  pushName: '❤️ Ñ🤓mr🤓t🤓 ❤️',
  isSavedContact: false,
};

function chat(id: string, jid: string, contact: any) {
  return {
    id,
    userId: USER,
    whatsappAccountId: ACCOUNT,
    externalChatId: jid,
    chatType: 'INDIVIDUAL',
    title: null as string | null,
    lastMessageText: 'hi',
    lastMessageAt: new Date('2026-10-14T10:00:00Z'),
    unreadCount: 0,
    contact: { ...contact },
  };
}

/** In-memory stand-in for the Prisma calls used by the chat, contact and title services. */
function makeDb(contactRows: any[], conversations: any[], mappings: any[] = []) {
  const db = {
    conversations,
    writes: 0,
    whatsAppAccount: { findFirst: async () => ({ id: ACCOUNT, userId: USER }) },
    $runCommandRaw: async () => ({ cursor: { firstBatch: [] } }),
    contact: {
      findMany: async () => contactRows.map((c) => ({ ...c })),
      count: async () => contactRows.length,
    },
    conversation: {
      findMany: async () => db.conversations.map((c) => ({ ...c, contact: c.contact ? { ...c.contact } : null })),
      count: async () => db.conversations.length,
      update: async ({ where, data }: any) => {
        const conv = db.conversations.find((c) => c.id === where.id);
        Object.assign(conv, data);
        db.writes++;
        return conv;
      },
    },
    lIDMapping: { findMany: async () => mappings.map((m) => ({ ...m })) },
  };
  return db;
}

/** Runs what the sync does: compute and store titles, then read them back on each screen. */
async function syncAndRead(contactRows: any[], conversations: any[], mappings: any[] = []) {
  const db = makeDb(contactRows, conversations, mappings);
  await new ChatTitleService(db as any).refreshAccount(USER, ACCOUNT);
  const chats: any = await new ChatsService(db as any).getChats(USER, undefined, 50, 0);
  const contacts: any = await new ContactsService(db as any, new DeviceContactsService()).getContacts(
    USER,
    undefined,
    50,
    0,
    'INDIVIDUAL'
  );
  return {
    chatTitles: chats.conversations.map((c: any) => c.title),
    contactNames: contacts.contacts.map((c: any) => c.displayName),
    db,
  };
}

describe('chat name is stored at sync time and matches the Contacts list', () => {
  it('a phone chat stores the saved phonebook name, same as Contacts', async () => {
    const r = await syncAndRead([savedRow, pushRow], [chat('c1', PHONE_JID, pushRow)]);
    expect(r.chatTitles).toEqual(['Namrata Kadam']);
    expect(r.contactNames).toContain('Namrata Kadam');
  });

  it('stores the same title regardless of contact row order', async () => {
    const a = await syncAndRead([savedRow, pushRow], [chat('c1', PHONE_JID, pushRow)]);
    const b = await syncAndRead([pushRow, savedRow], [chat('c1', PHONE_JID, pushRow)]);
    expect(a.chatTitles).toEqual(b.chatTitles);
  });

  it('a second sync with nothing changed writes nothing (stable, no flip-flop)', async () => {
    const db = makeDb([savedRow, pushRow], [chat('c1', PHONE_JID, pushRow)]);
    const svc = new ChatTitleService(db as any);
    await svc.refreshAccount(USER, ACCOUNT);
    const firstWrites = db.writes;
    await svc.refreshAccount(USER, ACCOUNT);
    expect(db.writes).toBe(firstWrites);
    expect(db.conversations[0].title).toBe('Namrata Kadam');
  });

  it('a LID chat stores the saved name when the LID→phone mapping is known', async () => {
    const r = await syncAndRead(
      [savedRow, pushRow, lidRow],
      [chat('c2', LID, lidRow)],
      [{ lid: LID, phoneJid: PHONE_JID }]
    );
    expect(r.chatTitles).toEqual(['Namrata Kadam']);
  });

  it('a LID chat without a mapping gets no title and borrows no other name', async () => {
    const r = await syncAndRead([savedRow, pushRow, lidRow], [chat('c2', LID, lidRow)], []);
    expect(r.chatTitles[0]).toBeNull();
  });

  it('never uses a push name or phone number as the chat title', async () => {
    const r = await syncAndRead([pushRow], [chat('c4', PHONE_JID, pushRow)]);
    expect(r.chatTitles[0]).toBeNull();
  });

  it('clears an old phone-number title once the contact has no saved name', async () => {
    const db = makeDb([pushRow], [{ ...chat('c5', PHONE_JID, pushRow), title: '+91 70305 13050' }]);
    await new ChatTitleService(db as any).refreshAccount(USER, ACCOUNT);
    expect(db.conversations[0].title).toBeNull();
  });

  it('a LID’s digits are never read as a phone number', async () => {
    const other = { ...savedRow, id: 'c-other', externalContactId: '919999999999@s.whatsapp.net', phoneNumber: '+919999999999', displayName: 'Someone Else', isSavedContact: true };
    const r = await syncAndRead([other], [chat('c2', LID, { ...lidRow, displayName: 'WhatsApp Contact', pushName: null })], []);
    expect(r.chatTitles[0]).not.toBe('Someone Else');
  });

  it('never shows "WhatsApp Contact" or a phone number when no saved name exists', async () => {
    const bare = { ...pushRow, id: 'c-bare', displayName: 'WhatsApp Contact', pushName: null, isSavedContact: false };
    const r = await syncAndRead([bare], [chat('c3', PHONE_JID, bare)]);
    expect(r.chatTitles[0]).toBeNull();
  });

  it('the Chats read path does no name lookup of its own', async () => {
    const db = makeDb([savedRow], [chat('c1', PHONE_JID, pushRow)]);
    db.conversations[0].title = 'Stored Title';
    const chats: any = await new ChatsService(db as any).getChats(USER, undefined, 50, 0);
    expect(chats.conversations[0].title).toBe('Stored Title');
  });
});
