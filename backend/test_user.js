const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const u = await prisma.user.findUnique({ where: { id: '6ad230c039fd0869482bdac0' } });
  console.log('User 6ad230c039fd0869482bdac0:', u ? u.email : 'NOT FOUND');
  const wa = await prisma.whatsAppAccount.findMany({ where: { userId: '6ad230c039fd0869482bdac0' } });
  console.log('WhatsAppAccounts for 6ad230c039fd0869482bdac0:', wa);
}

main().finally(() => prisma.$disconnect());
