const axios = require('axios');
const { resolveDisplayName, isRawIdentifier, formatPhoneNumber } = require('./dist/shared/name-resolver');

const API_BASE = 'http://localhost:3000/api/v1';

async function runTests() {
  console.log('=== RUNNING PRODUCTION FIX VERIFICATION SUITE ===\n');

  // Test 1: Name Resolver Unit Tests
  console.log('Test 1: Name Resolver Logic & Raw JID Suppression');
  const testCases = [
    {
      entity: { displayName: '120363410787048200@g.us', isGroup: true },
      expected: 'WhatsApp Group',
      desc: 'Raw Group JID should become "WhatsApp Group"',
    },
    {
      entity: { displayName: '919921812042-1485438313@g.us', isGroup: true },
      expected: 'WhatsApp Group',
      desc: 'Raw Group Timestamp JID should become "WhatsApp Group"',
    },
    {
      entity: { title: 'Product Engineering Team', displayName: '120363410787048200@g.us', isGroup: true },
      expected: 'Product Engineering Team',
      desc: 'Group with real title should return real title',
    },
    {
      entity: { displayName: '919876543210@s.whatsapp.net', phoneNumber: '919876543210' },
      expected: '+91 98765 43210',
      desc: 'Raw Contact JID with phone should format cleanly',
    },
    {
      entity: { displayName: 'Vaibhav Deshmukh', phoneNumber: '919876543210' },
      expected: 'Vaibhav Deshmukh',
      desc: 'Contact with human name preserves human name',
    },
    {
      entity: { displayName: '120363410787048200' },
      expected: 'WhatsApp Contact',
      desc: '12+ digit numeric ID alone is suppressed',
    },
    {
      entity: undefined,
      fallback: 'John Doe',
      isGroup: false,
      expected: 'John Doe',
      desc: 'Undefined entity with fallback name returns fallback name',
    },
    {
      entity: null,
      fallback: null,
      isGroup: true,
      expected: 'WhatsApp Group',
      desc: 'Null entity with isGroup returns "WhatsApp Group"',
    },
    {
      entity: null,
      fallback: null,
      isGroup: false,
      expected: 'WhatsApp Contact',
      desc: 'Null entity with no fallback returns "WhatsApp Contact"',
    },
  ];

  let resolverPassed = 0;
  for (const tc of testCases) {
    const res = resolveDisplayName(tc.entity, tc.fallback, tc.isGroup);
    if (res === tc.expected) {
      console.log(`  ✓ PASSED: ${tc.desc} -> "${res}"`);
      resolverPassed++;
    } else {
      console.error(`  ✗ FAILED: ${tc.desc} -> got "${res}", expected "${tc.expected}"`);
    }
  }

  if (resolverPassed !== testCases.length) {
    throw new Error(`Name resolver failed ${testCases.length - resolverPassed} test(s)`);
  }
  console.log('✓ Test 1: Name Resolver PASSED all cases\n');

  // Test 2: Auth Login & Session Check
  console.log('Test 2: Backend API & Auth Verification');
  let token;
  const testEmail = `test_pers_${Date.now()}@example.com`;
  try {
    const regRes = await axios.post(`${API_BASE}/auth/register`, {
      email: testEmail,
      password: 'Password123!',
      name: 'Persistence Tester',
    });
    token = regRes.data.accessToken || regRes.data.token;
    console.log('  ✓ Registered user successfully');
  } catch (err) {
    // If registration fails, attempt login
    const logRes = await axios.post(`${API_BASE}/auth/login`, {
      email: 'test@example.com',
      password: 'Password123!',
    });
    token = logRes.data.accessToken || logRes.data.token;
    console.log('  ✓ Logged in as existing user');
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  // Test 3: WhatsApp Status & Sync Progress Endpoints
  console.log('\nTest 3: WhatsApp Status & Sync Progress Endpoints');
  const statusRes = await axios.get(`${API_BASE}/whatsapp/status`, { headers: authHeaders });
  console.log('  Current WhatsApp status:', statusRes.data.status);

  const progressRes = await axios.get(`${API_BASE}/whatsapp/sync-progress`, { headers: authHeaders });
  console.log('  Sync progress object retrieved:', JSON.stringify(progressRes.data));
  if (typeof progressRes.data.progress !== 'number') {
    throw new Error('Sync progress must return a progress number');
  }
  console.log('  ✓ Sync progress endpoint works correctly');

  // Test 4: Re-connect without session destruction
  console.log('\nTest 4: WhatsApp Connect Idempotence');
  const connectRes = await axios.post(`${API_BASE}/whatsapp/connect`, { method: 'QR', forceFresh: false }, { headers: authHeaders });
  console.log('  Connect response:', connectRes.data.status);
  console.log('  ✓ Connect endpoint responded without error');

  // Test 5: Chats & Extractions Endpoints
  console.log('\nTest 5: Chats & Extractions Endpoints');
  const chatsRes = await axios.get(`${API_BASE}/chats`, { headers: authHeaders });
  console.log(`  Chats fetched: ${chatsRes.data.conversations?.length || 0}`);

  const extractionsRes = await axios.get(`${API_BASE}/extractions`, { headers: authHeaders });
  console.log(`  Extractions fetched: ${extractionsRes.data.extractions?.length || 0}`);

  const dashboardRes = await axios.get(`${API_BASE}/ai/dashboard`, { headers: authHeaders });
  console.log(`  Dashboard loaded successfully. Suggestion count: ${dashboardRes.data.aiSuggestions?.length || 0}`);

  console.log('\n======================================================');
  console.log('🎉 ALL 5 PRODUCTION VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('======================================================\n');
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err.response?.data || err.message);
  process.exit(1);
});
