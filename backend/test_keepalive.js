const { PrismaClient } = require('@prisma/client');

async function test() {
  const url = 'postgresql://postgres:Vaibhav%40963@db.myptmxxyzdksvrvvrfjw.supabase.co:5432/postgres?sslmode=require&connect_timeout=15&pool_timeout=30&keepalives=1&keepalives_idle=30';
  console.log('Testing with keepalives...');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const start = Date.now();
    await prisma.$connect();
    console.log(`Connected in ${((Date.now() - start)/1000).toFixed(1)}s!`);
    const count = await prisma.user.count();
    console.log('User count:', count);
    await prisma.$disconnect();
    console.log('Success!');
  } catch (err) {
    console.error('Failed:', err.message);
  }
}

test();
