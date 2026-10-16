const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testRawDelete() {
  try {
    await prisma.$connect();
    console.log('Connected to Prisma MongoDB');

    const account = await prisma.whatsAppAccount.findFirst();
    if (!account) {
      console.log('No account found');
      return;
    }
    const accountId = account.id;
    console.log('Account ID:', accountId);

    const collections = [
      'ai_extraction_sources',
      'ai_extractions',
      'ai_reply_suggestions',
      'ai_processing_jobs',
      'message_statuses',
      'message_media',
      'messages',
      'group_participants',
      'conversation_summaries',
      'conversations',
      'contact_ai_profiles',
      'lid_mappings',
      'contacts',
      'provider_events',
      'sync_states'
    ];

    console.time('Total raw delete execution time');
    for (const coll of collections) {
      const start = Date.now();
      const res = await prisma.$runCommandRaw({
        delete: coll,
        deletes: [
          {
            q: { whatsappAccountId: { $oid: accountId } },
            limit: 0
          }
        ]
      });
      console.log(`Collection ${coll}: deleted ${res.n} docs in ${Date.now() - start}ms`);
    }
    console.timeEnd('Total raw delete execution time');

  } catch (err) {
    console.error('Raw delete error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

testRawDelete();
