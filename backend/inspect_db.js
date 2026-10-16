const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  console.log('=== USERS ===');
  console.log(users);

  const accounts = await prisma.whatsAppAccount.findMany();
  console.log('\n=== WHATSAPP ACCOUNTS ===');
  for (const a of accounts) {
    console.log({ id: a.id, userId: a.userId, phone: a.phoneNumber, name: a.displayName, status: a.status });
  }

  const contactsCount = await prisma.contact.count();
  console.log('\n=== CONTACTS (Total: ' + contactsCount + ') ===');
  const contacts = await prisma.contact.findMany({ take: 30, orderBy: { createdAt: 'desc' } });
  for (const c of contacts) {
    console.log({
      id: c.id,
      userId: c.userId,
      externalContactId: c.externalContactId,
      displayName: c.displayName,
      phoneNumber: c.phoneNumber,
      isGroup: c.isGroup,
    });
  }

  const convsCount = await prisma.conversation.count();
  console.log('\n=== CONVERSATIONS (Total: ' + convsCount + ') ===');
  const convs = await prisma.conversation.findMany({ take: 30, orderBy: { lastMessageAt: 'desc' } });
  for (const cv of convs) {
    console.log({
      id: cv.id,
      userId: cv.userId,
      externalChatId: cv.externalChatId,
      title: cv.title,
      chatType: cv.chatType,
      contactId: cv.contactId,
    });
  }

  const messagesCount = await prisma.message.count();
  console.log('\n=== MESSAGES (Total: ' + messagesCount + ') ===');
  const messages = await prisma.message.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
  for (const m of messages) {
    console.log({
      id: m.id,
      userId: m.userId,
      whatsappMessageId: m.whatsappMessageId,
      textContent: m.textContent?.substring(0, 40),
      isFromMe: m.isFromMe,
      metadata: m.metadata,
    });
  }

  const extractionsCount = await prisma.aIExtraction.count();
  console.log('\n=== EXTRACTIONS (Total: ' + extractionsCount + ') ===');
  const extractions = await prisma.aIExtraction.findMany({ take: 10, orderBy: { createdAt: 'desc' } });
  for (const e of extractions) {
    console.log({ id: e.id, userId: e.userId, type: e.extractionType, title: e.title });
  }

  await prisma.$disconnect();
}

check().catch((e) => {
  console.error(e);
  prisma.$disconnect();
});
