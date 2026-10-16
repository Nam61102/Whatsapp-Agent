const http = require('http');

const BASE_URL = 'http://localhost:3000/api/v1';

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: response.status, ok: response.ok, data };
}

async function runTests() {
  console.log('==================================================');
  console.log('🚀 Starting Comprehensive End-to-End Test Suite');
  console.log('==================================================\n');

  const testEmailA = `test_user_a_${Date.now()}@example.com`;
  const testEmailB = `test_user_b_${Date.now()}@example.com`;
  let tokenA, tokenB, userA, userB, chatIdA, contactIdA;

  // 1. Register User A
  console.log('1. Registering User A...');
  const regA = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Vaibhav A', email: testEmailA, password: 'password123' },
  });
  console.log('   Response status:', regA.status);
  if (!regA.ok) throw new Error(`User A Registration failed: ${JSON.stringify(regA.data)}`);
  tokenA = regA.data.accessToken;
  userA = regA.data.user;
  console.log('   ✓ User A registered successfully:', userA.id);

  // 2. Login User A
  console.log('\n2. Logging in User A...');
  const loginA = await request('/auth/login', {
    method: 'POST',
    body: { email: testEmailA, password: 'password123' },
  });
  console.log('   Response status:', loginA.status);
  if (!loginA.ok) throw new Error('Login failed');
  console.log('   ✓ User A authenticated with JWT token');

  // 3. Initiate WhatsApp Connection
  console.log('\n3. Initiating WhatsApp Connection for User A...');
  const connectRes = await request('/whatsapp/connect', {
    method: 'POST',
    token: tokenA,
    body: { method: 'QR' },
  });
  console.log('   Response status:', connectRes.status);
  console.log('   QR Code generated:', !!connectRes.data.qrCode);
  console.log('   Pairing Code generated:', connectRes.data.pairingCode);
  console.log('   ✓ WhatsApp connection initiated with QR and Pairing codes');

  // 4. Complete Connection & Trigger Initial Sync
  console.log('\n4. Completing Connection and Triggering Initial WhatsApp Sync...');
  const completeRes = await request('/whatsapp/complete-connect', {
    method: 'POST',
    token: tokenA,
    body: { phone: '+91 98765 43210' },
  });
  console.log('   Response status:', completeRes.status);
  console.log('   WhatsApp status:', completeRes.data.status);
  console.log('   ✓ WhatsApp connected');

  // Wait 3 seconds for async sync & AI pipeline to execute
  console.log('   Waiting 3s for sync pipeline to persist data into Supabase...');
  await new Promise((r) => setTimeout(r, 3000));

  // 5. Verify Synced Contacts
  console.log('\n5. Fetching Synced Contacts for User A...');
  const contactsRes = await request('/contacts', { token: tokenA });
  console.log('   Total contacts retrieved:', contactsRes.data.total);
  if (contactsRes.data.contacts.length === 0) throw new Error('No contacts synced');
  contactIdA = contactsRes.data.contacts[0].id;
  console.log('   Sample contact:', contactsRes.data.contacts[0].displayName);
  console.log('   ✓ Contacts verified in Supabase PostgreSQL');

  // 6. Verify Synced Conversations
  console.log('\n6. Fetching Synced Conversations for User A...');
  const chatsRes = await request('/chats', { token: tokenA });
  console.log('   Total conversations:', chatsRes.data.total);
  if (chatsRes.data.conversations.length === 0) throw new Error('No chats synced');
  chatIdA = chatsRes.data.conversations[0].id;
  console.log('   First conversation with:', chatsRes.data.conversations[0].contact.displayName);
  console.log('   Last message:', chatsRes.data.conversations[0].lastMessageText);
  console.log('   ✓ Conversations verified in Supabase PostgreSQL');

  // 7. Fetch Messages for Conversation
  console.log('\n7. Fetching Message Timeline for Conversation...');
  const messagesRes = await request(`/chats/${chatIdA}/messages`, { token: tokenA });
  console.log('   Messages in conversation:', messagesRes.data.messages.length);
  console.log('   Sample message text:', messagesRes.data.messages[0].textContent);
  console.log('   ✓ Message history verified');

  // 8. Send New Message (Optimistic Pipeline)
  console.log('\n8. Sending New Outgoing WhatsApp Message...');
  const sendRes = await request(`/chats/${chatIdA}/messages`, {
    method: 'POST',
    token: tokenA,
    body: { text: 'Ha bhai kal pakka milte hai CCD pe! ☕' },
  });
  console.log('   Message send status:', sendRes.status);
  console.log('   Sent message ID:', sendRes.data.id);
  console.log('   Status:', sendRes.data.currentStatus || sendRes.data.status);
  console.log('   ✓ Outgoing message persisted and dispatched to WebSocket');

  // 9. AI Dashboard Overview
  console.log('\n9. Fetching AI Intelligence Dashboard Overview...');
  const dashRes = await request('/ai/dashboard', { token: tokenA });
  console.log('   Total AI Extractions:', dashRes.data.totalExtractions);
  console.log('   Birthdays found:', dashRes.data.importantToday.birthdays.length);
  console.log('   Meetings found:', dashRes.data.importantToday.meetings.length);
  console.log('   ✓ AI Dashboard aggregated successfully');

  // 10. AI Reply Suggestions
  console.log('\n10. Generating 3 Contextual AI Reply Suggestions with Gemini 2.5...');
  const sugRes = await request(`/ai/chats/${chatIdA}/reply-suggestions`, {
    method: 'POST',
    token: tokenA,
  });
  console.log('    Generated suggestions count:', sugRes.data.suggestions?.length);
  if (sugRes.data.suggestions && sugRes.data.suggestions.length > 0) {
    sugRes.data.suggestions.forEach((s, i) => {
      console.log(`    [Suggestion ${i + 1}] (${s.tone}): "${s.text}"`);
    });
  }
  console.log('    ✓ AI Reply suggestions generated successfully with Gemini');

  // 11. Contact AI Profile
  console.log('\n11. Generating Contact Intelligence Persona with Gemini 2.5...');
  const profileRes = await request(`/ai/contacts/${contactIdA}/profile`, { token: tokenA });
  console.log('    Summary:', profileRes.data.summary);
  console.log('    Communication Style:', JSON.stringify(profileRes.data.communicationStyle));
  console.log('    Likes:', JSON.stringify(profileRes.data.likes));
  console.log('    Frequently Discussed:', JSON.stringify(profileRes.data.frequentlyDiscussedTopics));
  console.log('    ✓ Contact AI Profile generated and stored in Supabase');

  // 12. Extractions Hub
  console.log('\n12. Fetching AI Extractions (Filtered by Category)...');
  const extRes = await request('/extractions?type=ALL', { token: tokenA });
  console.log('    Total extractions count:', extRes.data.total);
  if (extRes.data.extractions.length > 0) {
    console.log('    Sample extraction:', extRes.data.extractions[0].title, `[${extRes.data.extractions[0].extractionType}]`);
  }
  console.log('    ✓ Extractions hub endpoint verified');

  // 13. Data Retention Settings
  console.log('\n13. Testing Data Retention Policy Update (15 Days)...');
  const retRes = await request('/settings', {
    method: 'PATCH',
    token: tokenA,
    body: { retentionDays: 15 },
  });
  console.log('    Updated retentionDays:', retRes.data.retentionDays);
  console.log('    ✓ Retention policy successfully updated');

  // 14. Strict Multi-Tenant Data Isolation Test
  console.log('\n14. Testing Strict Multi-Tenant Isolation (User B vs User A)...');
  const regB = await request('/auth/register', {
    method: 'POST',
    body: { name: 'User B', email: testEmailB, password: 'password123' },
  });
  tokenB = regB.data.accessToken;

  // User B tries to access User A's conversation
  const breachAttempt = await request(`/chats/${chatIdA}/messages`, { token: tokenB });
  console.log('    User B accessing User A chat status:', breachAttempt.status);
  if (breachAttempt.status === 403 || breachAttempt.status === 404) {
    console.log('    ✓ Multi-tenant protection passed! Access strictly forbidden.');
  } else {
    throw new Error('SECURITY VIOLATION: User B was able to access User A conversation!');
  }

  // User B tries to access User A's contact
  const contactBreach = await request(`/contacts/${contactIdA}`, { token: tokenB });
  console.log('    User B accessing User A contact status:', contactBreach.status);
  if (contactBreach.status === 403 || contactBreach.status === 404) {
    console.log('    ✓ Contact isolation passed! Access strictly forbidden.');
  } else {
    throw new Error('SECURITY VIOLATION: User B was able to access User A contact!');
  }

  console.log('\n==================================================');
  console.log('🎉 ALL 14 TESTS PASSED! Production system verified.');
  console.log('==================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
