import { PrismaService } from '../prisma/prisma.service';
import { isLidJid, lidId, phoneKey } from './contact-name-policy';

export function getConsonants(str: string): string {
  if (!str) return '';
  const s = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return s.replace(/[^a-z]/g, '').replace(/[aeiouy]/g, '');
}

export function isNameMatch(nameA?: string | null, nameB?: string | null): boolean {
  if (!nameA || !nameB) return false;
  const rawA = nameA.toLowerCase().trim();
  const rawB = nameB.toLowerCase().trim();

  if (rawA === rawB) return true;

  const normA = rawA.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const normB = rawB.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

  if (normA.length >= 3 && normB.length >= 3 && (normA === normB || normA.includes(normB) || normB.includes(normA))) {
    return true;
  }

  const consA = getConsonants(nameA);
  const consB = getConsonants(nameB);

  if (consA.length >= 3 && consB.length >= 3) {
    if (consA === consB || consA.includes(consB) || consB.includes(consA)) {
      return true;
    }
  }

  return false;
}

export async function findMatchingConversationsForContact(
  prisma: PrismaService,
  userId: string,
  whatsappAccountId: string,
  contact: any
) {
  // 1. Direct conversations by contactId
  const directConvs = await prisma.conversation.findMany({
    where: {
      userId,
      whatsappAccountId,
      contactId: contact.id,
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (directConvs.length > 0 && directConvs.some((c) => c.lastMessageAt)) {
    return directConvs;
  }

  // 2. Query all user conversations and match via phone digits, LID, or name/pushName
  const allConvs = await prisma.conversation.findMany({
    where: {
      userId,
      whatsappAccountId,
    },
    include: {
      contact: true,
    },
    orderBy: { lastMessageAt: 'desc' },
  });

  const phoneDigits = contact.phoneNumber ? contact.phoneNumber.replace(/\D/g, '') : null;
  const cleanPhoneDigits = phoneDigits && phoneDigits.length >= 7 ? phoneDigits.slice(-10) : null;

  const matched = allConvs.filter((c) => {
    if (c.contactId === contact.id) return true;

    if (cleanPhoneDigits) {
      const chatDigits = (c.externalChatId || '').replace(/\D/g, '');
      const contactPhoneDigits = (c.contact?.phoneNumber || '').replace(/\D/g, '');
      if (
        (chatDigits && chatDigits.includes(cleanPhoneDigits)) ||
        (contactPhoneDigits && contactPhoneDigits.includes(cleanPhoneDigits))
      ) {
        return true;
      }
    }

    if (c.contact?.lid && contact.externalContactId && contact.externalContactId.includes(c.contact.lid)) {
      return true;
    }

    const cand1 = c.contact?.pushName;
    const cand2 = c.contact?.displayName;
    const cand3 = c.title;

    return (
      isNameMatch(contact.displayName, cand1) ||
      isNameMatch(contact.displayName, cand2) ||
      isNameMatch(contact.displayName, cand3)
    );
  });

  return matched.length > 0 ? matched : directConvs;
}

/**
 * The latest text messages exchanged with one saved contact, oldest first.
 * A chat belongs to the contact only by phone number, or by the LID→phone link.
 * Name similarity is never used, so another person's chat cannot leak in.
 */
export async function findChatMessagesForContact(
  prisma: PrismaService,
  userId: string,
  whatsappAccountId: string,
  contact: any,
  take: number = 100
) {
  const key = phoneKey(contact.phoneNumber) || phoneKey(contact.externalContactId);
  const mappings = await prisma.lIDMapping.findMany({
    where: { whatsappAccountId },
    select: { lid: true, phoneJid: true },
  });
  const lidIds = new Set(
    mappings
      .filter((m) => key && phoneKey(m.phoneJid) === key)
      .map((m) => lidId(m.lid))
      .filter(Boolean) as string[]
  );

  const convs = await prisma.conversation.findMany({
    where: { userId, whatsappAccountId, chatType: 'INDIVIDUAL' },
    select: { id: true, externalChatId: true, contactId: true },
  });
  const convIds = convs
    .filter((c) => {
      if (c.contactId === contact.id) return true;
      if (!key) return false;
      if (isLidJid(c.externalChatId)) return lidIds.has(lidId(c.externalChatId) || '');
      return phoneKey(c.externalChatId) === key;
    })
    .map((c) => c.id);

  if (!convIds.length) return [];

  const latest = await prisma.message.findMany({
    where: { userId, whatsappAccountId, conversationId: { in: convIds }, textContent: { not: null } },
    orderBy: { messageTimestamp: 'desc' },
    take,
    select: { id: true, isFromMe: true, textContent: true, messageTimestamp: true },
  });
  return latest.filter((m) => m.textContent && m.textContent.trim().length > 0).reverse();
}

export async function autoLinkAllLidConversations(
  prisma: PrismaService,
  userId: string,
  whatsappAccountId: string
) {
  try {
    const savedContacts = await prisma.contact.findMany({
      where: {
        userId,
        isSavedContact: true,
        NOT: { externalContactId: { contains: 'lid' } },
      },
    });

    if (!savedContacts.length) return 0;

    const lidConvs = await prisma.conversation.findMany({
      where: {
        userId,
        externalChatId: { contains: 'lid' },
      },
      include: { contact: true },
    });

    let linkedCount = 0;
    for (const conv of lidConvs) {
      if (conv.contact?.isSavedContact) continue;

      const cleanLid = conv.externalChatId.trim();
      const rawDigits = cleanLid.replace(/\D/g, '');

      // 1. Check existing LID mappings
      const existingMapping = await prisma.lIDMapping.findFirst({
        where: {
          userId,
          lid: { contains: rawDigits.length >= 8 ? rawDigits : cleanLid },
        },
      });

      let matchedSaved = null;

      if (existingMapping?.phoneJid) {
        matchedSaved = savedContacts.find(
          (sc) =>
            sc.externalContactId === existingMapping.phoneJid ||
            (sc.phoneNumber && sc.phoneNumber.replace(/\D/g, '').includes(existingMapping.phoneJid.replace(/\D/g, '')))
        );
      }

      // 2. Gather all name candidates for this LID across the system
      if (!matchedSaved) {
        const candidates: string[] = [];
        if (conv.contact?.pushName) candidates.push(conv.contact.pushName);
        if (conv.contact?.displayName) candidates.push(conv.contact.displayName);
        if (conv.title) candidates.push(conv.title);

        // Fetch historical contacts for this LID across the entire database to harvest real push names
        const historicalContacts = await prisma.contact.findMany({
          where: {
            OR: [
              { externalContactId: { contains: rawDigits } },
              { lid: { contains: rawDigits } },
            ],
          },
        });

        for (const hc of historicalContacts) {
          if (hc.pushName && hc.pushName !== rawDigits && hc.pushName !== 'Contact') candidates.push(hc.pushName);
          if (hc.displayName && hc.displayName !== rawDigits && hc.displayName !== 'Contact') candidates.push(hc.displayName);
        }

        // Fetch message sender names in this conversation
        const sampleMsgs = await prisma.message.findMany({
          where: { conversationId: conv.id, isFromMe: false },
          take: 10,
          orderBy: { messageTimestamp: 'desc' },
        });

        for (const m of sampleMsgs) {
          const meta = m.metadata as any;
          if (meta?.senderName) candidates.push(meta.senderName);
        }

        // Search for matching saved contact using candidates
        for (const sc of savedContacts) {
          const isMatch = candidates.some((cand) => {
            if (!cand) return false;
            // Ignore generic placeholder strings
            const lower = cand.toLowerCase().trim();
            if (lower === 'contact' || lower === 'whatsapp contact' || /^\+?\d+$/.test(lower)) return false;
            return isNameMatch(sc.displayName, cand);
          });

          if (isMatch) {
            matchedSaved = sc;
            break;
          }
        }
      }

      if (matchedSaved) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            contactId: matchedSaved.id,
            title: matchedSaved.displayName,
          },
        });

        await prisma.message.updateMany({
          where: { conversationId: conv.id, isFromMe: false },
          data: { senderContactId: matchedSaved.id },
        });

        await prisma.lIDMapping.upsert({
          where: {
            whatsappAccountId_lid: {
              whatsappAccountId,
              lid: conv.externalChatId,
            },
          },
          update: { phoneJid: matchedSaved.externalContactId },
          create: {
            userId,
            whatsappAccountId,
            lid: conv.externalChatId,
            phoneJid: matchedSaved.externalContactId,
          },
        });

        await prisma.contactAIProfile.deleteMany({
          where: { contactId: matchedSaved.id },
        });

        linkedCount++;
      } else {
        // If not matched to a phonebook contact yet, check if a historical contact record has a valid human name
        const historicalHumanContact = await prisma.contact.findFirst({
          where: {
            userId,
            OR: [
              { externalContactId: { contains: rawDigits } },
              { lid: { contains: rawDigits } },
            ],
            displayName: { notIn: ['Contact', 'WhatsApp Contact', rawDigits] },
          },
          orderBy: { updatedAt: 'desc' },
        });

        if (historicalHumanContact && conv.contact && conv.contact.id !== historicalHumanContact.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: {
              contactId: historicalHumanContact.id,
              title: historicalHumanContact.displayName || historicalHumanContact.pushName,
            },
          });
          linkedCount++;
        }
      }
    }
    return linkedCount;
  } catch (err: any) {
    console.error('Error in autoLinkAllLidConversations:', err);
    return 0;
  }
}
