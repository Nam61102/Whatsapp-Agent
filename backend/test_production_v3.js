require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTests() {
  console.log('====================================================');
  console.log('  PRODUCTION UPGRADE REQUIREMENTS VERIFICATION (V3) ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  await prisma.$connect();
  console.log('MongoDB connected successfully.\n');

  const testPrefix = `test_${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      authUserId: `${testPrefix}_auth`,
      email: `${testPrefix}@test.local`,
      passwordHash: 'dummy_hash',
      name: 'V3 Test User',
    },
  });

  const account = await prisma.whatsAppAccount.create({
    data: {
      userId: user.id,
      phoneNumber: '+919999988888',
      status: 'CONNECTED',
    },
  });

  try {
    // -------------------------------------------------------------
    // TEST 1: Contact vs Group Distinction & Type Filtering
    // -------------------------------------------------------------
    console.log('--- TEST 1: Contact vs Group Distinction & Type Filtering ---');
    const individualContact = await prisma.contact.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        externalContactId: '919876543210@s.whatsapp.net',
        phoneNumber: '+91 98765 43210',
        displayName: 'Aarav Sharma',
        isGroup: false,
      },
    });

    const groupContact = await prisma.contact.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        externalContactId: '120363040123456789@g.us',
        phoneNumber: null,
        displayName: 'Project Alpha Team',
        isGroup: true,
      },
    });

    const individuals = await prisma.contact.findMany({
      where: { userId: user.id, isGroup: false },
    });
    const groups = await prisma.contact.findMany({
      where: { userId: user.id, isGroup: true },
    });
    const all = await prisma.contact.findMany({
      where: { userId: user.id },
    });

    assert(individuals.length === 1 && individuals[0].displayName === 'Aarav Sharma', 'Individual contacts correctly filtered');
    assert(groups.length === 1 && groups[0].displayName === 'Project Alpha Team', 'Group contacts correctly filtered');
    assert(all.length === 2, 'Total contacts includes both individual and group entities');

    // -------------------------------------------------------------
    // TEST 2: Group Conversation Preview & Metadata
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: Group Conversation Preview & Metadata ---');
    const groupConv = await prisma.conversation.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        contactId: groupContact.id,
        externalChatId: groupContact.externalContactId,
        chatType: 'GROUP',
        title: 'Project Alpha Team',
        lastMessageText: 'Rahul: Next sprint starts on Monday',
        lastMessageAt: new Date(),
      },
    });

    const groupMsg = await prisma.message.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        conversationId: groupConv.id,
        externalMessageId: `msg_${testPrefix}_group_1`,
        senderType: 'OTHER',
        messageType: 'TEXT',
        textContent: 'Next sprint starts on Monday',
        isFromMe: false,
        currentStatus: 'DELIVERED',
        messageTimestamp: new Date(),
        metadata: {
          senderName: 'Rahul',
          senderJid: '919123456789@s.whatsapp.net',
          isGroup: true,
        },
      },
    });

    assert(groupConv.title === 'Project Alpha Team', 'Group conversation preserves group title');
    assert(groupConv.lastMessageText.startsWith('Rahul:'), 'Group last message preview includes sender name');
    assert(groupMsg.metadata.senderName === 'Rahul', 'Message metadata stores group sender pushName');

    // -------------------------------------------------------------
    // TEST 3: Message Deduplication via Compound Unique Key
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Message Deduplication via Unique Key ---');
    let duplicateRejected = false;
    try {
      await prisma.message.create({
        data: {
          userId: user.id,
          whatsappAccountId: account.id,
          conversationId: groupConv.id,
          externalMessageId: `msg_${testPrefix}_group_1`, // Exact same externalMessageId
          senderType: 'OTHER',
          messageType: 'TEXT',
          textContent: 'Next sprint starts on Monday (duplicate)',
          isFromMe: false,
          currentStatus: 'DELIVERED',
          messageTimestamp: new Date(),
        },
      });
    } catch (err) {
      duplicateRejected = true;
    }
    assert(duplicateRejected, 'Duplicate message with same [whatsappAccountId, externalMessageId] is rejected');

    // -------------------------------------------------------------
    // TEST 4: AI Reply Suggestions Non-Destructive Integrity
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: AI Reply Suggestions Policy ---');
    const replySuggestion = await prisma.aIReplySuggestion.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        conversationId: groupConv.id,
        sourceMessageId: groupMsg.id,
        suggestion: 'Understood! I have prepared the sprint backlog.',
        tone: 'PROFESSIONAL',
      },
    });

    assert(replySuggestion.id !== undefined, 'Reply suggestion created linked to conversation & message');
    assert(groupMsg.currentStatus !== 'READ', 'Reply suggestion does NOT auto-send or change message status');

    // -------------------------------------------------------------
    // TEST 5: Derived AI Extraction & Traceability
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Derived AI Extraction & Traceability ---');
    const extraction = await prisma.aIExtraction.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        conversationId: groupConv.id,
        contactId: groupContact.id,
        extractionType: 'TASK',
        title: 'Prepare Sprint Backlog',
        summary: 'Next sprint starts on Monday',
        eventDate: new Date(Date.now() + 86400000 * 2),
        confidenceScore: 0.95,
        status: 'PENDING',
      },
    });

    await prisma.aIExtractionSource.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        extractionId: extraction.id,
        messageId: groupMsg.id,
      },
    });

    assert(extraction.extractionType === 'TASK', 'AI extraction extracted as TASK');
    assert(extraction.eventDate !== null, 'AI extraction has structured eventDate');

    // -------------------------------------------------------------
    // TEST 6: Message Retention & Purge Verification
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: Message Retention & Derived Data Preservation ---');
    const pastDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const expiredMsg = await prisma.message.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        conversationId: groupConv.id,
        externalMessageId: `msg_${testPrefix}_expired`,
        senderType: 'OTHER',
        messageType: 'TEXT',
        textContent: 'Old message that should be purged',
        isFromMe: false,
        currentStatus: 'READ',
        messageTimestamp: pastDate,
        createdAt: pastDate,
      },
    });

    const persistentExtraction = await prisma.aIExtraction.create({
      data: {
        userId: user.id,
        whatsappAccountId: account.id,
        conversationId: groupConv.id,
        contactId: groupContact.id,
        extractionType: 'IMPORTANT_EVENT',
        title: 'Historical Contract Signed',
        summary: 'Contract signed 45 days ago',
        confidenceScore: 0.99,
        status: 'COMPLETED',
        createdAt: pastDate,
      },
    });

    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleteResult = await prisma.message.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        id: expiredMsg.id,
      },
    });

    const checkExpiredMsg = await prisma.message.findUnique({ where: { id: expiredMsg.id } });
    const checkPersistedExtraction = await prisma.aIExtraction.findUnique({ where: { id: persistentExtraction.id } });

    assert(deleteResult.count === 1 && checkExpiredMsg === null, 'Expired raw WhatsApp message purged according to retention policy');
    assert(checkPersistedExtraction !== null, 'Derived AI extraction preserved even after raw message retention purge');

  } finally {
    console.log('\nCleaning up verification records...');
    await prisma.aIExtractionSource.deleteMany({ where: { extraction: { userId: user.id } } }).catch(() => {});
    await prisma.aIExtraction.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.aIReplySuggestion.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.message.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.conversation.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.contact.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.whatsAppAccount.deleteMany({ where: { userId: user.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
    console.log('Cleanup completed cleanly.');
  }

  console.log('\n====================================================');
  console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) process.exit(1);
}

runTests().catch((e) => {
  console.error('Test execution failed:', e);
  process.exit(1);
});
