import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const account = await prisma.whatsAppAccount.findFirst();
  if (!account) {
    console.log('No account found');
    return;
  }
  const accountId = account.id;
  const userId = account.userId;
  console.log('Account ID:', accountId, 'User ID:', userId);

  const sampleContact = await prisma.contact.findFirst();
  console.log('Sample contact:', sampleContact);

  // Test $runCommandRaw with $oid
  const res1 = await prisma.$runCommandRaw({
    delete: 'contacts',
    deletes: [
      {
        q: { whatsappAccountId: { $oid: accountId } },
        limit: 0,
      },
    ],
  });
  console.log('Delete result with { whatsappAccountId: { $oid: accountId } }:', res1);

  // Check count after res1
  const countAfter1 = await prisma.contact.count();
  console.log('Count after res1:', countAfter1);

  // Test deleteMany with prisma
  // const res2 = await prisma.contact.deleteMany({ where: { whatsappAccountId: accountId } });
  // console.log('DeleteMany result:', res2);
}

main().catch(console.error).finally(() => prisma.$disconnect());
