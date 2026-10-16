require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function main() {
  console.log('Testing DATABASE_URL:', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,
      },
    },
    log: ['error', 'warn'],
  });

  try {
    await prisma.$connect();
    console.log('Connected to Supabase PostgreSQL successfully!');
    const users = await prisma.user.count();
    console.log('User count in Supabase:', users);
    await prisma.$disconnect();
  } catch (err) {
    console.error('Connection failed:', err);
  }
}

main();
