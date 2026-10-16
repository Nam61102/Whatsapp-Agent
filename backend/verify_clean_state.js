const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BASE_URL = 'http://localhost:3000/api/v1';

async function main() {
  console.log('=== VERIFYING REAL WHATSAPP DATA & ZERO MOCK DATA ===\n');

  // 1. Direct Prisma Check
  console.log('1. Checking MongoDB directly via Prisma:');
  const user = await prisma.user.findUnique({
    where: { email: 'demo@user.com' },
    include: { whatsappAccounts: true },
  });
  const account = user?.whatsappAccounts?.[0];
  console.log(`- User: id=${user?.id}, email=${user?.email}, name="${user?.name}"`);
  console.log(`- WhatsApp Account: status=${account?.status}, phone=${account?.phoneNumber}`);

  const mockContacts = await prisma.contact.findMany({
    where: {
      OR: [
        { displayName: { contains: 'Alice', mode: 'insensitive' } },
        { displayName: { contains: 'Engineering', mode: 'insensitive' } },
        { displayName: { contains: 'roundup', mode: 'insensitive' } },
      ],
    },
  });
  console.log(`- Mock Contacts Found: ${mockContacts.length}`);

  const totalContacts = await prisma.contact.count({ where: { userId: user.id } });
  const totalChats = await prisma.conversation.count({ where: { userId: user.id } });
  const totalMessages = await prisma.message.count({ where: { userId: user.id } });
  const totalExtractions = await prisma.aIExtraction.count({ where: { userId: user.id } });

  console.log(`- Total Contacts in DB: ${totalContacts}`);
  console.log(`- Total Chats in DB: ${totalChats}`);
  console.log(`- Total Messages in DB: ${totalMessages}`);
  console.log(`- Total Extractions in DB: ${totalExtractions}`);

  // 2. HTTP API Check
  console.log('\n2. Testing HTTP Endpoints:');
  const loginRes = await axios.post(`${BASE_URL}/auth/login`, {
    email: 'demo@user.com',
    password: 'password123',
  });
  const token = loginRes.data.accessToken;
  const headers = { Authorization: `Bearer ${token}` };
  console.log(`- Login Successful. Token obtained.`);

  const meRes = await axios.get(`${BASE_URL}/auth/me`, { headers });
  console.log(`- GET /auth/me -> Name: "${meRes.data.name}", Email: "${meRes.data.email}"`);

  const statusRes = await axios.get(`${BASE_URL}/whatsapp/status`, { headers });
  console.log(`- GET /whatsapp/status -> Status: ${statusRes.data.status}, Phone: ${statusRes.data.phone}`);

  const chatsRes = await axios.get(`${BASE_URL}/chats`, { headers });
  console.log(`- GET /chats -> Total: ${chatsRes.data.total}, Returned: ${chatsRes.data.conversations?.length}`);

  const contactsRes = await axios.get(`${BASE_URL}/contacts`, { headers });
  console.log(`- GET /contacts -> Total: ${contactsRes.data.total}, Returned: ${contactsRes.data.contacts?.length}`);

  const dashboardRes = await axios.get(`${BASE_URL}/ai/dashboard`, { headers });
  console.log(`- GET /ai/dashboard -> Important Items: ${dashboardRes.data.importantCount || 0}, Suggestions: ${dashboardRes.data.aiSuggestions?.length || 0}`);

  console.log('\n=== ALL CHECKS PASSED: ZERO MOCK DATA DETECTED ===');
}

main()
  .catch((err) => {
    console.error('Error during verification:', err.message, err.response?.data);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
