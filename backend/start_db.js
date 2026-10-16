const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function ensureMongoRunning() {
  if (
    process.env.DATABASE_URL &&
    !process.env.DATABASE_URL.includes('localhost') &&
    !process.env.DATABASE_URL.includes('127.0.0.1')
  ) {
    return;
  }
  if (process.platform !== 'win32' || !fs.existsSync('C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe')) {
    return;
  }

  const isRunning = await checkPort(27018);
  if (isRunning) {
    console.log('[MongoDB] Replica set rs0 on port 27018 is active.');
    return;
  }

  console.log('[MongoDB] Starting dedicated MongoDB replica set rs0 on port 27018...');
  const mongoDbPath = path.join(__dirname, 'mongo_rs');
  if (!fs.existsSync(mongoDbPath)) {
    fs.mkdirSync(mongoDbPath, { recursive: true });
  }

  const mongodPath = 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe';
  const child = spawn(mongodPath, [
    '--port', '27018',
    '--dbpath', mongoDbPath,
    '--replSet', 'rs0'
  ], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Wait until port 27018 is ready
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await checkPort(27018)) {
      console.log('[MongoDB] MongoDB replica set started successfully on port 27018.');
      return;
    }
  }
  console.warn('[MongoDB] mongod process launched, waiting for port 27018 listener...');
}

if (require.main === module) {
  ensureMongoRunning().catch(console.error);
}

module.exports = { ensureMongoRunning };
