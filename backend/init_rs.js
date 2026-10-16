const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27018/admin?directConnection=true');
  try {
    await client.connect();
    console.log('Connected to standalone mongod on 27018');
    const db = client.db('admin');
    const result = await db.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: '127.0.0.1:27018' }],
      },
    });
    console.log('Replica set initialized successfully:', result);
  } catch (err) {
    if (err.message && err.message.includes('already initialized')) {
      console.log('Replica set already initialized.');
    } else {
      console.error('Error initializing replica set:', err);
    }
  } finally {
    await client.close();
  }
}

main();
