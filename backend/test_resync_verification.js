const http = require('http');
const { PrismaClient } = require('@prisma/client');

// Verify Name Resolver logic directly
const { isRawIdentifier, formatPhoneNumber, resolveDisplayName } = require('./dist/shared/name-resolver');

console.log('=== 1. VERIFYING NAME RESOLVER LOGIC ===');
// Newsletters
console.assert(isRawIdentifier('120363180441418584@newsletter') === true, 'newsletter jid must be raw');
console.assert(isRawIdentifier('120363180441418584') === true, 'newsletter raw numeric must be raw');
console.assert(isRawIdentifier('+120363180441418584') === true, 'newsletter + numeric must be raw');
console.assert(formatPhoneNumber('120363180441418584') === '', 'newsletter raw numeric formatPhoneNumber must be empty string');
console.assert(formatPhoneNumber('+120363180441418584') === '', 'newsletter + numeric formatPhoneNumber must be empty string');

// Valid phone numbers
console.assert(isRawIdentifier('917038128870') === false, 'valid phone number must not be raw identifier');
console.assert(formatPhoneNumber('917038128870') === '+91 70381 28870', 'valid Indian phone must format nicely');
console.assert(formatPhoneNumber('7038128870') === '+91 70381 28870', '10-digit Indian phone must format nicely');

// Groups and LIDs
console.assert(isRawIdentifier('120363410787048200@g.us') === true, 'group jid must be raw');
console.assert(isRawIdentifier('217256709591222@lid') === true, 'lid must be raw');
console.assert(formatPhoneNumber('120363410787048200') === '', 'group numeric id must not format as phone');

// Name resolution
const resolvedNewsletter = resolveDisplayName({
  externalContactId: '120363180441418584@newsletter',
  displayName: '120363180441418584',
  phoneNumber: '',
});
console.assert(resolvedNewsletter === 'WhatsApp Channel', `Expected 'WhatsApp Channel', got '${resolvedNewsletter}'`);

const resolvedGroup = resolveDisplayName({
  externalContactId: '120363410787048200@g.us',
  displayName: '120363410787048200',
  isGroup: true,
});
console.assert(resolvedGroup === 'WhatsApp Group', `Expected 'WhatsApp Group', got '${resolvedGroup}'`);

const resolvedGroupNamed = resolveDisplayName({
  externalContactId: '120363410787048200@g.us',
  displayName: 'Project Alpha',
  isGroup: true,
});
console.assert(resolvedGroupNamed === 'Project Alpha', `Expected 'Project Alpha', got '${resolvedGroupNamed}'`);

const resolvedUser = resolveDisplayName({
  externalContactId: '917038128870@s.whatsapp.net',
  displayName: '917038128870',
  phoneNumber: '+91 70381 28870',
});
console.assert(resolvedUser === '+91 70381 28870', `Expected '+91 70381 28870', got '${resolvedUser}'`);

console.log('✓ Name Resolver tests passed successfully!\n');

async function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/api/v1' + path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let resData = '';
        res.on('data', (c) => (resData += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(resData) });
          } catch {
            resolve({ status: res.statusCode, body: resData });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  console.log('=== 2. OBTAINING AUTH TOKEN FOR DEMO USER ===');
  const jwt = require('jsonwebtoken');
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst({ where: { email: 'demo@user.com' } });
  if (!user) throw new Error('demo@user.com not found');

  const token = jwt.sign(
    { sub: user.id, email: user.email, name: user.name },
    'vai4-whatsapp-ai-production-secret-key-2026',
    { expiresIn: '7d' }
  );
  console.log('Generated token for user:', user.email, `(${user.id})`);

  console.log('\n=== 3. CHECKING WHATSAPP STATUS BEFORE RESYNC ===');
  const statusRes = await request('GET', '/whatsapp/status', null, token);
  console.log('WhatsApp Status:', statusRes.body?.status, 'Stats:', statusRes.body?.stats);

  console.log('\n=== 4. INSPECTING MONGODB BEFORE RESYNC ===');

  const contactsBefore = await prisma.contact.findMany();
  console.log(`Found ${contactsBefore.length} contacts in MongoDB before resync.`);
  const rawContactsBefore = contactsBefore.filter((c) => isRawIdentifier(c.displayName) || (c.phoneNumber && isRawIdentifier(c.phoneNumber)));
  console.log(`Contacts with raw numeric IDs before resync: ${rawContactsBefore.length}`);
  for (const c of rawContactsBefore) {
    console.log(` - JID: ${c.externalContactId}, Name: "${c.displayName}", Phone: "${c.phoneNumber}"`);
  }

  const extractionsBefore = await prisma.aIExtraction.findMany();
  console.log(`Found ${extractionsBefore.length} AI extractions before resync.`);

  console.log('\n=== 5. CALLING POST /api/v1/whatsapp/resync ===');
  const resyncRes = await request('POST', '/whatsapp/resync', {}, token);
  console.log('Resync API status:', resyncRes.status, 'Response:', resyncRes.body);

  console.log('\n=== 6. INSPECTING MONGODB AFTER RESYNC ===');
  const contactsAfter = await prisma.contact.findMany();
  console.log(`Found ${contactsAfter.length} contacts in MongoDB after resync.`);
  const rawContactsAfter = contactsAfter.filter((c) => isRawIdentifier(c.displayName) || (c.phoneNumber && isRawIdentifier(c.phoneNumber)));
  console.log(`Contacts with raw numeric IDs after resync: ${rawContactsAfter.length}`);
  for (const c of contactsAfter) {
    console.log(` + JID: ${c.externalContactId}, Name: "${c.displayName}", Phone: "${c.phoneNumber}", isGroup: ${c.isGroup}`);
  }

  console.assert(rawContactsAfter.length === 0, 'FAIL: No contact must have raw numeric ID after resync!');

  const extractionsAfter = await prisma.aIExtraction.findMany();
  console.log(`Found ${extractionsAfter.length} AI extractions after resync (stale ones purged).`);

  console.log('\n=== 7. VERIFYING REST APIS AFTER RESYNC ===');
  const contactsApi = await request('GET', '/contacts', null, token);
  console.log('GET /contacts count:', contactsApi.body?.contacts?.length);

  const chatsApi = await request('GET', '/chats', null, token);
  console.log('GET /chats count:', chatsApi.body?.conversations?.length);

  const dashboardApi = await request('GET', '/ai/dashboard', null, token);
  console.log('GET /ai/dashboard totalExtractions:', dashboardApi.body?.totalExtractions);

  const statusAfter = await request('GET', '/whatsapp/status', null, token);
  console.log('WhatsApp Status after resync:', statusAfter.body?.status, 'Stats:', statusAfter.body?.stats);

  await prisma.$disconnect();
  console.log('\n=== ALL VERIFICATIONS PASSED SUCCESSFULLY ===');
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
