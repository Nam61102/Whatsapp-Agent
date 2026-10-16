import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function testRealtimeAI() {
  const account = await prisma.whatsAppAccount.findFirst();
  if (!account) {
    console.log('No WhatsApp account found');
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: { whatsappAccountId: account.id },
    include: { contact: true },
  });

  if (!conversation) {
    console.log('No conversation found');
    return;
  }

  // Create test message
  const testMessage = await prisma.message.create({
    data: {
      userId: account.userId,
      whatsappAccountId: account.id,
      conversationId: conversation.id,
      externalMessageId: `TEST_MSG_${Date.now()}`,
      senderType: 'CONTACT',
      messageType: 'TEXT',
      textContent: 'Can you send me the report tomorrow at 10 AM?',
      isFromMe: false,
      currentStatus: 'DELIVERED',
      messageTimestamp: new Date(),
    },
  });

  console.log('Created test message:', testMessage.id);
  console.log('Message text:', testMessage.textContent);
}

testRealtimeAI()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
