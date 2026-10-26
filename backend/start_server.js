require('dotenv').config();

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

function checkExistingServer(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: 2000 },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            resolve(response.statusCode === 200 && health.ok === true ? 'healthy' : 'occupied');
          } catch {
            resolve('occupied');
          }
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('Health check timed out')));
    request.on('error', (error) => {
      if (error.code === 'ECONNREFUSED') {
        resolve('available');
      } else {
        reject(error);
      }
    });
  });
}

async function start() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const status = await checkExistingServer(port);
  if (status === 'healthy') {
    console.log(`[Backend] Already running and healthy on port ${port}; no second instance started.`);
    return;
  }
  if (status === 'occupied') {
    throw new Error(`Port ${port} is occupied by another service. Stop it or set a different PORT in .env.`);
  }

  const child = spawn(
    process.execPath,
    ['--max-old-space-size=380', '-r', 'dotenv/config', path.join(__dirname, 'dist', 'main.js')],
    { stdio: 'inherit', env: process.env }
  );

  child.on('error', (error) => {
    console.error('[Backend] Failed to launch:', error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      console.error(`[Backend] Server stopped by signal ${signal}.`);
      process.exitCode = 1;
    } else {
      process.exitCode = code === null ? 1 : code;
    }
  });
}

start().catch((error) => {
  console.error('[Backend] Startup failed:', error.message);
  process.exitCode = 1;
});
