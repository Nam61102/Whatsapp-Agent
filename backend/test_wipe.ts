import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetAllData() {
  const account = await prisma.whatsAppAccount.findFirst();
  if (!account) {
    console.log('No account found');
    return;
  }
  const accountId = account.id;

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
    'sync_states',
  ];

  for (const coll of collections) {
    try {
      const res = await prisma.$runCommandRaw({
        delete: coll,
        deletes: [
          {
            q: { whatsappAccountId: { $oid: accountId } },
            limit: 0,
          },
        ],
      });
      console.log(`Raw delete for ${coll}:`, res);
    } catch (err: any) {
      console.log(`Error deleting ${coll}:`, err.message);
    }
  }

  console.log('--- Database Counts After Wipe ---');
  console.log('Contacts:', await prisma.contact.count());
  console.log('Conversations:', await prisma.conversation.count());
  console.log('GroupParticipants:', await prisma.groupParticipant.count());
  console.log('Messages:', await prisma.message.count());
}

resetAllData().catch(console.error).finally(() => prisma.$disconnect());
