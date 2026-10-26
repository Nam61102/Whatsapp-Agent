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
  if (process.platform !== 'win32') {
    return;
  }

  const isRunning = await checkPort(27018);
  if (!isRunning) {
    const serverRoot = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MongoDB', 'Server');
    const versions = fs.existsSync(serverRoot)
      ? fs.readdirSync(serverRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(serverRoot, entry.name, 'bin', 'mongod.exe'))
        .filter((candidate) => fs.existsSync(candidate))
      : [];
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    if (versions.length === 0) {
      throw new Error(`MongoDB Server was not found under ${serverRoot}`);
    }

    console.log('[MongoDB] Starting dedicated MongoDB replica set rs0 on port 27018...');
    const mongoDbPath = path.join(__dirname, 'mongo_rs');
    if (!fs.existsSync(mongoDbPath)) {
      fs.mkdirSync(mongoDbPath, { recursive: true });
    }

    const child = spawn(versions[0], [
      '--port', '27018',
      '--dbpath', mongoDbPath,
      '--replSet', 'rs0'
    ], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkPort(27018)) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      throw new Error('MongoDB did not start listening on port 27018');
    }
    console.log('[MongoDB] MongoDB started on port 27018.');
  } else {
    console.log('[MongoDB] MongoDB is already listening on port 27018.');
  }

  await ensureReplicaSet();
}

async function ensureReplicaSet() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient('mongodb://127.0.0.1:27018/admin?directConnection=true', {
    serverSelectionTimeoutMS: 5000,
  });

  try {
    await client.connect();
    const admin = client.db('admin');
    let status = await admin.command({ hello: 1 });

    if (status.setName && status.setName !== 'rs0') {
      throw new Error(`Expected MongoDB replica set rs0 on port 27018, found ${status.setName}`);
    }

    if (!status.setName) {
      try {
        await admin.command({
          replSetInitiate: {
            _id: 'rs0',
            members: [{ _id: 0, host: '127.0.0.1:27018' }],
          },
        });
      } catch (error) {
        if (error.codeName !== 'AlreadyInitialized' && !/already initialized/i.test(error.message)) {
          throw error;
        }
      }
    }

    for (let i = 0; i < 30; i++) {
      status = await admin.command({ hello: 1 });
      if (status.setName === 'rs0' && status.isWritablePrimary) {
        console.log('[MongoDB] Replica set rs0 is ready on port 27018.');
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error('MongoDB replica set rs0 did not become primary on port 27018');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  ensureMongoRunning().catch((error) => {
    console.error('[MongoDB] Startup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { ensureMongoRunning };
