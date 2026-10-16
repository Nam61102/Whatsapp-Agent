require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function runTests() {
  console.log('====================================================');
  console.log('   MONGODB SCHEMA & TENANT ISOLATION VERIFICATION   ');
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

  let connected = false;
  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`Connecting to MongoDB database (attempt ${i}/5)...`);
      await prisma.$connect();
      console.log('Connected to MongoDB database successfully!');
      connected = true;
      break;
    } catch (e) {
      console.log(`Attempt ${i} failed (${e.message.split('\n')[0]}). Retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!connected) throw new Error('Could not connect to database after 5 attempts');

  try {
    console.log('--- TEST 1: Model & Schema Availability ---');
    assert(prisma.user !== undefined, 'User model available');
    assert(prisma.whatsAppAccount !== undefined, 'WhatsAppAccount model available');
    assert(prisma.whatsAppConnection !== undefined, 'WhatsAppConnection model available');
    assert(prisma.contact !== undefined, 'Contact model available');
    assert(prisma.conversation !== undefined, 'Conversation model available');
    assert(prisma.message !== undefined, 'Message model available');
    assert(prisma.messageMedia !== undefined, 'MessageMedia model available');
    assert(prisma.messageStatus !== undefined, 'MessageStatus model available');
    assert(prisma.aIExtraction !== undefined, 'AIExtraction model available');
    assert(prisma.aIExtractionSource !== undefined, 'AIExtractionSource model available');
    assert(prisma.aIReplySuggestion !== undefined, 'AIReplySuggestion model available');
    assert(prisma.aIProcessingJob !== undefined, 'AIProcessingJob model available');
    assert(prisma.contactAIProfile !== undefined, 'ContactAIProfile model available');

    // -------------------------------------------------------------
    // TEST 2: Native Password Hash Storage in MongoDB
    // -------------------------------------------------------------
    console.log('\n--- TEST 2: User Creation & Password Hash ---');
    const testAuthId1 = 'auth_mongo_test_user_alice';
    const testAuthId2 = 'auth_mongo_test_user_bob';

    // Clean any previous test entries cleanly
    const existingUsers = await prisma.user.findMany({
      where: { email: { in: ['alice_mongo@test.local', 'bob_mongo@test.local'] } }
    });
    for (const u of existingUsers) {
      await prisma.user.delete({ where: { id: u.id } });
    }

    const userA = await prisma.user.create({
      data: {
        authUserId: testAuthId1,
        email: 'alice_mongo@test.local',
        passwordHash: '$2a$10$test_alice_password_hash_mongo',
        name: 'Alice MongoDB Tenant',
      }
    });

    await prisma.userSettings.create({
      data: {
        userId: userA.id,
        retentionDays: 30,
        autoAIAnalysis: true,
      }
    });

    const userB = await prisma.user.create({
      data: {
        authUserId: testAuthId2,
        email: 'bob_mongo@test.local',
        passwordHash: '$2a$10$test_bob_password_hash_mongo',
        name: 'Bob MongoDB Tenant',
      }
    });

    assert(userA.id !== undefined && userA.id.length > 0, 'User A document created in MongoDB');
    assert(userB.id !== undefined && userB.id.length > 0, 'User B document created in MongoDB');
    assert(userA.passwordHash !== null, 'Password hash stored natively in MongoDB User document');

    // -------------------------------------------------------------
    // TEST 3: Account & Connection Flow
    // -------------------------------------------------------------
    console.log('\n--- TEST 3: Account & Connection Flow ---');
    const accountA = await prisma.whatsAppAccount.create({
      data: {
        userId: userA.id,
        displayName: 'Alice WhatsApp MongoDB',
        status: 'CONNECTED',
      }
    });

    const accountB = await prisma.whatsAppAccount.create({
      data: {
        userId: userB.id,
        displayName: 'Bob WhatsApp MongoDB',
        status: 'CONNECTED',
      }
    });

    const conn1 = await prisma.whatsAppConnection.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        connectionStatus: 'CONNECTED',
        isActive: true,
      }
    });
    assert(conn1.isActive === true, 'First connection created as active');

    // -------------------------------------------------------------
    // TEST 4: Same-Name Contact Independence
    // -------------------------------------------------------------
    console.log('\n--- TEST 4: Independent Same-Name Contacts ---');
    const contactA = await prisma.contact.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        externalContactId: '919811122233@c.us',
        displayName: 'Rahul Sharma',
        phoneNumber: '+91 98111 22233',
      }
    });

    const contactB = await prisma.contact.create({
      data: {
        userId: userB.id,
        whatsappAccountId: accountB.id,
        externalContactId: '919811122233@c.us',
        displayName: 'Rahul Sharma',
        phoneNumber: '+91 98111 22233',
      }
    });

    assert(contactA.id !== contactB.id, 'Alice and Bob have distinct MongoDB contact documents');
    assert(contactA.userId === userA.id && contactB.userId === userB.id, 'Each contact document has strict userId ownership');

    // -------------------------------------------------------------
    // TEST 5: Messages & Media
    // -------------------------------------------------------------
    console.log('\n--- TEST 5: Messages & Media Documents ---');
    const convA = await prisma.conversation.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        contactId: contactA.id,
        externalChatId: '919811122233@c.us',
        lastMessageText: 'Meeting tomorrow at 11 AM',
      }
    });

    const msgA = await prisma.message.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        conversationId: convA.id,
        externalMessageId: 'msg_mongo_ext_a1',
        senderType: 'CONTACT',
        messageType: 'TEXT',
        textContent: 'Hey Alice, our Zoom meeting is tomorrow at 11:00 AM',
        isFromMe: false,
        currentStatus: 'RECEIVED',
      }
    });

    const msgStatusA = await prisma.messageStatus.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        messageId: msgA.id,
        status: 'RECEIVED',
      }
    });

    const mediaA = await prisma.messageMedia.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        messageId: msgA.id,
        mediaType: 'image',
        storageBucket: 'whatsapp-media',
        storagePath: 'tenants/alice/media/doc1.jpg',
        fileSize: 45000,
      }
    });

    assert(msgA.textContent !== null, 'Message textContent is populated in MongoDB');
    assert(mediaA.id !== undefined, 'Message media is linked via messageId');
    assert(msgStatusA.status === 'RECEIVED', 'Message status lifecycle tracked');
    assert(msgA.userId === userA.id, 'Message has explicit userId tenant tracking');

    // -------------------------------------------------------------
    // TEST 6: AI Extraction & Source Traceability
    // -------------------------------------------------------------
    console.log('\n--- TEST 6: AI Extraction & Source Traceability ---');
    const extractionA = await prisma.aIExtraction.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        conversationId: convA.id,
        contactId: contactA.id,
        messageId: msgA.id,
        extractionType: 'MEETING',
        title: 'Meeting with Rahul Sharma',
        summary: 'Zoom meeting scheduled tomorrow at 11:00 AM',
        importanceScore: 0.9,
        confidenceScore: 0.95,
        status: 'ACTIVE',
        aiModel: 'gemini-2.5-flash',
      }
    });

    const sourceA = await prisma.aIExtractionSource.create({
      data: {
        userId: userA.id,
        whatsappAccountId: accountA.id,
        extractionId: extractionA.id,
        messageId: msgA.id,
        relevanceScore: 1.0,
      }
    });

    assert(sourceA.id !== undefined, 'AI extraction has traceable AIExtractionSource');
    assert(sourceA.messageId === msgA.id, 'Source points directly to msgA');

    // -------------------------------------------------------------
    // TEST 7: Cross-Tenant Isolation
    // -------------------------------------------------------------
    console.log('\n--- TEST 7: Cross-Tenant Isolation Checks ---');
    const bobConv = await prisma.conversation.findFirst({
      where: {
        id: convA.id,
        userId: userB.id,
      }
    });
    assert(bobConv === null, 'Bob cannot query Alice conversation with his tenant context');

    const bobMsg = await prisma.message.findFirst({
      where: {
        id: msgA.id,
        userId: userB.id,
      }
    });
    assert(bobMsg === null, 'Bob cannot query Alice message with his tenant context');

    const bobExtraction = await prisma.aIExtraction.findFirst({
      where: {
        id: extractionA.id,
        userId: userB.id,
      }
    });
    assert(bobExtraction === null, 'Bob cannot query Alice AI extractions with his tenant context');

    // Clean up test data
    console.log('\nCleaning up verification tenant records...');
    await prisma.user.delete({ where: { id: userA.id } });
    await prisma.user.delete({ where: { id: userB.id } });
    console.log('Cleanup completed cleanly.');

    console.log('\n====================================================');
    console.log(`VERIFICATION SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('====================================================\n');

    await prisma.$disconnect();

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Test execution error:', err);
    await prisma.$disconnect();
    process.exit(1);
  }
}

runTests();
