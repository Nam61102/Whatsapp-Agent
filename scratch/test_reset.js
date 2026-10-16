async function testReset() {
  try {
    console.log('Logging in...');
    let token = '';
    const loginRes = await fetch('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });
    
    if (loginRes.ok) {
      const data = await loginRes.json();
      token = data.token || data.accessToken;
    } else {
      console.log('Registering user...');
      const regRes = await fetch('http://localhost:3000/api/v1/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: 'password123', name: 'Test User' })
      });
      const data = await regRes.json();
      token = data.token || data.accessToken;
    }

    console.log('Got token:', token ? 'YES' : 'NO');

    console.time('reset-synced-data execution time');
    const resetRes = await fetch('http://localhost:3000/api/v1/whatsapp/reset-synced-data', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      }
    });
    console.timeEnd('reset-synced-data execution time');

    const resetData = await resetRes.json();
    console.log('Reset response status:', resetRes.status);
    console.log('Reset response data:', resetData);
  } catch (err) {
    console.error('Reset error:', err);
  }
}

testReset();
