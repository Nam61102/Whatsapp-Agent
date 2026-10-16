const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const http = require('http');

function post(url, data, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve(raw);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            resolve(raw);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  console.log('--- STARTING REAL WHATSAPP E2E AUDIT INSPECTION ---');

  // Login
  const loginRes = await post('http://localhost:3000/api/v1/auth/login', {
    email: 'demo@user.com',
    password: 'password123',
  });
  const token = loginRes.accessToken;
  const userId = loginRes.user?.id;
  console.log(`LoggedIn user: ${loginRes.user?.name} (${userId})`);

  // 1. Account & Status
  const statusRes = await get('http://localhost:3000/api/v1/whatsapp/status', token);
  console.log('\n=== 1. STATUS & COUNTS ===');
  console.log('Status stats:', JSON.stringify(statusRes.stats, null, 2));

  // 2. Saved Contacts
  console.log('\n=== 2. SAVED CONTACTS & NAME RESOLUTION ===');
  const savedContacts = await prisma.contact.findMany({
    where: { isGroup: false },
    take: 10,
    select: { id: true, displayName: true, pushName: true, verifiedName: true, phoneNumber: true, isSavedContact: true, lid: true, externalContactId: true }
  });
  console.log('Individual contacts sample:', JSON.stringify(savedContacts, null, 2));

  // 3. Unsaved Contact Check
  console.log('\n=== 3. UNSAVED CONTACT CHECK ===');
  const unsavedContacts = await prisma.contact.findMany({
    where: { isGroup: false, isSavedContact: false },
    take: 5,
    select: { id: true, displayName: true, pushName: true, phoneNumber: true, isSavedContact: true, externalContactId: true }
  });
  console.log('Unsaved contacts sample:', JSON.stringify(unsavedContacts, null, 2));

  // 4. Individual Chats
  console.log('\n=== 4. INDIVIDUAL CHATS ===');
  const indChats = await prisma.conversation.findMany({
    where: { chatType: 'INDIVIDUAL' },
    include: { contact: true, messages: { take: 3, orderBy: { messageTimestamp: 'desc' } } }
  });
  console.log('Individual chats count:', indChats.length);
  console.log('Individual chats sample:', JSON.stringify(indChats.map(c => ({
    id: c.id,
    title: c.title || c.contact?.displayName,
    externalChatId: c.externalChatId,
    messageCount: c.messages.length,
    lastMsg: c.lastMessageText
  })), null, 2));

  // 5. Message History & Direction (Incoming / Outgoing / Timestamps)
  console.log('\n=== 5. MESSAGE HISTORY & DIRECTION ===');
  const sampleChatMsgs = await prisma.message.findMany({
    take: 10,
    orderBy: { messageTimestamp: 'desc' },
    select: { id: true, externalMessageId: true, conversationId: true, isFromMe: true, senderType: true, textContent: true, messageTimestamp: true, currentStatus: true, metadata: true }
  });
  console.log('Recent 10 messages across DB:', JSON.stringify(sampleChatMsgs, null, 2));

  // 6. Self Chat
  console.log('\n=== 6. SELF CHAT CHECK ===');
  const selfChats = await prisma.conversation.findMany({
    where: { OR: [{ chatType: 'SELF' }, { isSelfChat: true }] },
    include: { contact: true }
  });
  console.log('Self chats count:', selfChats.length);
  console.log('Self chats details:', JSON.stringify(selfChats, null, 2));

  // 7. Groups
  console.log('\n=== 7. GROUPS CHECK ===');
  const groupChats = await prisma.conversation.findMany({
    where: { chatType: 'GROUP' },
    take: 5,
    orderBy: { lastMessageAt: 'desc' },
    include: { contact: true, participants: { take: 3, include: { contact: true } }, messages: { take: 2, orderBy: { messageTimestamp: 'desc' } } }
  });
  console.log('Sample group chats:', JSON.stringify(groupChats.map(g => ({
    id: g.id,
    title: g.title,
    externalChatId: g.externalChatId,
    lastMsg: g.lastMessageText,
    participantsCount: g.participants.length,
    messagesCount: g.messages.length,
    sampleMsgSenders: g.messages.map(m => ({ isFromMe: m.isFromMe, metadataSender: m.metadata?.senderName, text: m.textContent }))
  })), null, 2));

  // 8. Channels
  console.log('\n=== 8. CHANNELS CHECK ===');
  const channels = await prisma.conversation.findMany({
    where: { chatType: 'CHANNEL' },
    take: 5,
    select: { id: true, title: true, externalChatId: true, lastMessageText: true }
  });
  console.log('Channels count:', channels.length);
  console.log('Sample channels:', JSON.stringify(channels, null, 2));

  const unnamedChannels = await prisma.conversation.findMany({
    where: { title: 'Unnamed Channel' }
  });
  console.log('Unnamed channel records count:', unnamedChannels.length);

  // 9. LID Mapping Check
  console.log('\n=== 9. LID MAPPING CHECK ===');
  const lidMappings = await prisma.lIDMapping.findMany({ take: 5 });
  console.log('LID mappings in DB:', JSON.stringify(lidMappings, null, 2));

  // 10. Database Consistency Check
  console.log('\n=== 10. DATABASE CONSISTENCY CHECK ===');
  const allMsgs = await prisma.message.findMany({ select: { id: true, conversationId: true } });
  const convIds = new Set((await prisma.conversation.findMany({ select: { id: true } })).map(c => c.id));
  const orphanMsgs = allMsgs.filter(m => !convIds.has(m.conversationId)).length;
  console.log('Orphan messages count:', orphanMsgs);

  await prisma.$disconnect();
  console.log('--- END OF INSPECTION ---');
}

run().catch(console.error);
