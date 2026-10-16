import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { formatPhoneNumber, isRawIdentifier } from '../../shared/name-resolver';
import { findMatchingConversationsForContact } from '../../shared/contact-resolver';
import { DeviceContactsService } from '../../shared/device-contacts.service';
import { phoneKey, isHumanName, pickBestContact } from '../../shared/contact-name-policy';

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceContacts: DeviceContactsService
  ) {}

  private async getAccount(userId: string) {
    let account = await this.prisma.whatsAppAccount.findFirst({
      where: { userId },
    });
    if (!account) {
      account = await this.prisma.whatsAppAccount.create({
        data: {
          userId,
          status: 'DISCONNECTED',
          displayName: 'Primary WhatsApp',
          provider: 'BAILEYS',
        },
      });
    }
    return account;
  }

  async getContacts(
    userId: string,
    search?: string,
    limit?: number,
    offset: number = 0,
    type?: 'ALL' | 'INDIVIDUAL' | 'GROUP'
  ) {
    const account = await this.getAccount(userId);

    const whereClause: any = {
      userId,
      whatsappAccountId: account.id,
      isGroup: false,
      // Only show contacts that the connected WhatsApp session reported as being
      // in the user's actual address book (contact.name present on sync). This
      // filters out random senders, group members, and historical cruft that
      // accumulated from message/chat events.
      isSavedContact: true,
      NOT: [
        { externalContactId: { contains: 'broadcast' } },
        { externalContactId: { contains: 'newsletter' } },
      ],
    };

    if (search) {
      whereClause.AND = [
        {
          OR: [
            { displayName: { contains: search, mode: 'insensitive' } },
            { pushName: { contains: search, mode: 'insensitive' } },
            { phoneNumber: { contains: search } },
          ],
        },
      ];
    }

    const takeValue = limit && limit > 0 ? limit : undefined;

    const rawContacts = await this.prisma.contact.findMany({
      where: whereClause,
      include: {
        aiProfile: true,
        conversations: {
          take: 1,
          select: { id: true, lastMessageText: true, lastMessageAt: true },
        },
      },
      orderBy: { displayName: 'asc' },
      // IMPORTANT: no take/skip here yet — we need to dedupe by phone first, then paginate.
    });

    // ─── Dedupe by phone number ────────────────────────────────────────────────
    // The DB can hold several rows for the same phone (one saved with the proper
    // phonebook name, another created from a message/chat upsert with the push name).
    // Keep only the single best row per phone key, and promote its displayName into
    // any sibling row that lacked a human name.
    const rowsByPhone = new Map<string, any[]>();
    const noPhoneRows: any[] = [];
    for (const c of rawContacts) {
      const key = phoneKey(c.phoneNumber) || phoneKey(c.externalContactId);
      if (!key) {
        noPhoneRows.push(c);
        continue;
      }
      const list = rowsByPhone.get(key) || [];
      list.push(c);
      rowsByPhone.set(key, list);
    }
    const bestByPhone = new Map<string, any>();
    for (const [key, rows] of rowsByPhone) {
      bestByPhone.set(key, pickBestContact(rows));
    }

    // Build the deduped list and overlay the best known displayName onto each row.
    let contacts = [...bestByPhone.values(), ...noPhoneRows].map((c) => {
      const key = phoneKey(c.phoneNumber) || phoneKey(c.externalContactId);
      const best = key ? bestByPhone.get(key) : null;
      if (best && best !== c && isHumanName(best.displayName)) {
        return { ...c, displayName: best.displayName, isSavedContact: best.isSavedContact || c.isSavedContact };
      }
      if (!isHumanName(c.displayName) && best && isHumanName(best.displayName)) {
        return { ...c, displayName: best.displayName };
      }
      return c;
    });

    // Apply pagination AFTER dedup so the user sees `limit` unique people.
    if (typeof takeValue === 'number' && takeValue > 0) {
      contacts = contacts.slice(offset, offset + takeValue);
    } else if (offset > 0) {
      contacts = contacts.slice(offset);
    }

    // Fetch all user conversations once for fast in-memory matching
    const allUserConvs = await this.prisma.conversation.findMany({
      where: { userId, whatsappAccountId: account.id },
      include: { contact: true },
      orderBy: { lastMessageAt: 'desc' },
    });

    const formattedContacts = contacts.map((c) => {
      let displayName = c.displayName;
      let phoneNumber = c.phoneNumber;

      const rawDigits = c.externalContactId ? c.externalContactId.split('@')[0].split(':')[0] : '';
      if (!phoneNumber && rawDigits && /^\d+$/.test(rawDigits)) {
        phoneNumber = formatPhoneNumber(rawDigits) || rawDigits;
      }

      if (!displayName || displayName === 'Contact' || displayName === 'unnamed' || isRawIdentifier(displayName)) {
        if (phoneNumber) {
          displayName = formatPhoneNumber(phoneNumber) || phoneNumber;
        } else if (rawDigits) {
          displayName = formatPhoneNumber(rawDigits) || rawDigits;
        }
      }

      let conversations = c.conversations || [];
      if ((!conversations.length || !conversations[0].lastMessageAt) && allUserConvs.length > 0) {
        const phoneDigits = phoneNumber ? phoneNumber.replace(/\D/g, '') : null;
        const cleanPhoneDigits = phoneDigits && phoneDigits.length >= 7 ? phoneDigits.slice(-10) : null;

        const matched = allUserConvs.find((conv) => {
          if (conv.contactId === c.id) return true;
          if (cleanPhoneDigits) {
            const chatDigits = (conv.externalChatId || '').replace(/\D/g, '');
            const contactPhoneDigits = (conv.contact?.phoneNumber || '').replace(/\D/g, '');
            if (
              (chatDigits && chatDigits.includes(cleanPhoneDigits)) ||
              (contactPhoneDigits && contactPhoneDigits.includes(cleanPhoneDigits))
            ) {
              return true;
            }
          }
          return false;
        });

        if (matched) {
          conversations = [
            {
              id: matched.id,
              lastMessageText: matched.lastMessageText,
              lastMessageAt: matched.lastMessageAt,
            },
          ];
        }
      }

      return {
        ...c,
        displayName,
        phoneNumber,
        conversations,
      };
    });

    // Sort contacts: Named contacts A-Z first, raw phone numbers second
    formattedContacts.sort((a, b) => {
      const nameA = (a.displayName || '').trim();
      const nameB = (b.displayName || '').trim();
      const isPhoneA = nameA.startsWith('+') || /^\d/.test(nameA);
      const isPhoneB = nameB.startsWith('+') || /^\d/.test(nameB);

      if (isPhoneA && !isPhoneB) return 1;
      if (!isPhoneA && isPhoneB) return -1;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    });

    // Deduped total (one entry per unique phone number).
    const total = bestByPhone.size + noPhoneRows.length;

    return {
      contacts: formattedContacts,
      total,
      limit: limit || total,
      offset,
    };
  }

  async getContactById(userId: string, contactId: string) {
    const account = await this.getAccount(userId);

    const contact = await this.prisma.contact.findFirst({
      where: {
        id: contactId,
        whatsappAccountId: account.id,
        userId,
      },
      include: {
        aiProfile: true,
        conversations: {
          take: 1,
          select: { id: true, lastMessageText: true, lastMessageAt: true },
        },
        aiExtractions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!contact || contact.userId !== userId) {
      throw new NotFoundException('Contact not found');
    }

    // Resolve matching conversation if direct relationship is missing or empty
    if (!contact.conversations || !contact.conversations.length || !contact.conversations[0].lastMessageAt) {
      const matchedConvs = await findMatchingConversationsForContact(
        this.prisma,
        userId,
        account.id,
        contact
      );
      if (matchedConvs.length > 0) {
        (contact as any).conversations = matchedConvs.map((m) => ({
          id: m.id,
          lastMessageText: m.lastMessageText,
          lastMessageAt: m.lastMessageAt,
        }));
      }
    }

    return contact;
  }
}
