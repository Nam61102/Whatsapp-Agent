const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  console.log('=== CLEANING MOCK AND FAKE DATA FROM DATABASE ===');

  // 1. Update any user named 'Demo User' to real name 'Vaibhav' (or 'User')
  const updatedUsers = await prisma.user.updateMany({
    where: { name: 'Demo User' },
    data: { name: 'Vaibhav' },
  });
  console.log(`Updated ${updatedUsers.count} users with name 'Demo User' -> 'Vaibhav'`);

  // 2. Clear all synced application data (contacts, conversations, messages, extractions, suggestions)
  const extSources = await prisma.aIExtractionSource.deleteMany({});
  const extractions = await prisma.aIExtraction.deleteMany({});
  const suggestions = await prisma.aIReplySuggestion.deleteMany({});
  const jobs = await prisma.aIProcessingJob.deleteMany({});
  const statuses = await prisma.messageStatus.deleteMany({});
  const media = await prisma.messageMedia.deleteMany({});
  const messages = await prisma.message.deleteMany({});
  const summaries = await prisma.conversationSummary.deleteMany({});
  const convos = await prisma.conversation.deleteMany({});
  const profiles = await prisma.contactAIProfile.deleteMany({});
  const contacts = await prisma.contact.deleteMany({});
  const events = await prisma.providerEvent.deleteMany({});

  console.log('Cleared:');
  console.log(` - Contacts: ${contacts.count}`);
  console.log(` - Conversations: ${convos.count}`);
  console.log(` - Messages: ${messages.count}`);
  console.log(` - AI Extractions: ${extractions.count}`);
  console.log(` - AI Suggestions: ${suggestions.count}`);

  // Confirm accounts and connections are preserved
  const accounts = await prisma.whatsAppAccount.findMany();
  console.log(`WhatsApp Accounts preserved: ${accounts.length}`);
  for (const a of accounts) {
    console.log(` - Account ID: ${a.id}, Phone: ${a.phoneNumber}, Status: ${a.status}`);
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } });
  console.log('Users remaining:');
  console.log(users);

  await prisma.$disconnect();
  console.log('=== DATABASE CLEAN COMPLETE ===');
}

clean().catch((err) => {
  console.error(err);
  process.exit(1);
});
