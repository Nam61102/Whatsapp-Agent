async function testResync() {
  try {
    const loginRes = await fetch('http://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
    });
    
    const data = await loginRes.json();
    const token = data.token || data.accessToken;

    console.time('resync execution time');
    const resyncRes = await fetch('http://localhost:3000/api/v1/whatsapp/resync', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      }
    });
    console.timeEnd('resync execution time');

    const resyncData = await resyncRes.json();
    console.log('Resync status:', resyncRes.status);
    console.log('Resync response:', resyncData);
  } catch (err) {
    console.error('Resync error:', err);
  }
}

testResync();
