import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isHumanName,
  isLidJid,
  lidId,
  phoneKey,
  pickBestContact,
} from '../../shared/contact-name-policy';

interface ContactRow {
  displayName: string;
  pushName: string | null;
  phoneNumber: string | null;
  externalContactId: string;
  isSavedContact: boolean;
}

interface ConversationRow {
  id: string;
  externalChatId: string;
  title: string | null;
  contact: { displayName: string; pushName: string | null; phoneNumber: string | null } | null;
}

export interface TitleIndex {
  byPhone: Map<string, ContactRow>;
  lidToPhone: Map<string, string>;
}

/**
 * Stores the display name on every individual chat. The name comes from the same
 * contact row the Contacts tab shows, so a chat never has to re-derive it on read.
 */
@Injectable()
export class ChatTitleService {
  constructor(private readonly prisma: PrismaService) {}

  buildIndex(contacts: ContactRow[], mappings: Array<{ lid: string; phoneJid: string }>): TitleIndex {
    const rowsByPhone = new Map<string, ContactRow[]>();
    for (const c of contacts) {
      const keys = new Set(
        [phoneKey(c.phoneNumber), phoneKey(c.externalContactId)].filter(Boolean) as string[]
      );
      for (const k of keys) {
        const list = rowsByPhone.get(k) || [];
        list.push(c);
        rowsByPhone.set(k, list);
      }
    }
    const byPhone = new Map<string, ContactRow>();
    for (const [k, rows] of rowsByPhone) {
      const best = pickBestContact(rows);
      if (best) byPhone.set(k, best);
    }
    const lidToPhone = new Map<string, string>();
    for (const m of mappings) {
      const id = lidId(m.lid);
      const pk = phoneKey(m.phoneJid);
      if (id && pk) lidToPhone.set(id, pk);
    }
    return { byPhone, lidToPhone };
  }

  /**
   * The chat's title is the saved display name of its contact, and nothing else.
   * Returns null when the contact is not saved, so no phone number or push name shows.
   */
  resolveTitle(conv: ConversationRow, index: TitleIndex): string | null {
    const chatIsLid = isLidJid(conv.externalChatId);
    const chatKey = chatIsLid ? null : phoneKey(conv.externalChatId);
    const lidKey = chatIsLid ? index.lidToPhone.get(lidId(conv.externalChatId) || '') || null : null;
    const contactKey = phoneKey(conv.contact?.phoneNumber);

    for (const k of [chatKey, lidKey, contactKey]) {
      if (!k) continue;
      const row = index.byPhone.get(k);
      if (row?.isSavedContact && isHumanName(row.displayName)) return row.displayName.trim();
    }
    return null;
  }

  /**
   * Recomputes and stores titles for individual chats of one account. Pass
   * externalChatIds to limit the work to specific chats (e.g. one incoming message).
   */
  async refreshAccount(userId: string, whatsappAccountId: string, externalChatIds?: string[]) {
    const [contacts, mappings, convs] = await Promise.all([
      this.prisma.contact.findMany({
        where: { userId, whatsappAccountId, isGroup: false },
        select: {
          displayName: true,
          pushName: true,
          phoneNumber: true,
          externalContactId: true,
          isSavedContact: true,
        },
      }),
      this.prisma.lIDMapping.findMany({
        where: { whatsappAccountId },
        select: { lid: true, phoneJid: true },
      }),
      this.prisma.conversation.findMany({
        where: {
          userId,
          whatsappAccountId,
          chatType: { in: ['INDIVIDUAL', 'SELF'] },
          ...(externalChatIds ? { externalChatId: { in: externalChatIds } } : {}),
        },
        select: {
          id: true,
          externalChatId: true,
          title: true,
          contact: { select: { displayName: true, pushName: true, phoneNumber: true } },
        },
      }),
    ]);

    const index = this.buildIndex(contacts as ContactRow[], mappings);
    const toUpdate = [];
    for (const conv of convs) {
      const title = this.resolveTitle(conv, index);
      if (title && title !== conv.title) {
        toUpdate.push({ id: conv.id, title });
      }
    }
    const chunkSize = 25;
    for (let i = 0; i < toUpdate.length; i += chunkSize) {
      const batch = toUpdate.slice(i, i + chunkSize);
      await Promise.all(
        batch.map((b) =>
          this.prisma.conversation.update({ where: { id: b.id }, data: { title: b.title } }).catch(() => {})
        )
      );
    }
    return toUpdate.length;
  }
}
