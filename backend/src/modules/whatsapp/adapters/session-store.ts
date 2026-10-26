import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

const logger = new Logger('SessionStore');

export async function backupSessionToMongo(prisma: PrismaService, userId: string): Promise<void> {
  try {
    const sessionDir = path.join(process.cwd(), 'sessions', userId);
    if (!fs.existsSync(sessionDir)) return;

    const files = fs.readdirSync(sessionDir);
    const sessionFiles: Record<string, string> = {};
    for (const file of files) {
      if (file.endsWith('.json')) {
        sessionFiles[file] = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
      }
    }

    if (!sessionFiles['creds.json']) return;

    const conn = await prisma.whatsAppConnection.findFirst({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!conn) return;

    let meta: any = {};
    try {
      if (conn.encryptedSessionData) {
        meta = JSON.parse(conn.encryptedSessionData);
      }
    } catch {}

    meta.sessionFiles = sessionFiles;

    await prisma.whatsAppConnection.update({
      where: { id: conn.id },
      data: {
        encryptedSessionData: JSON.stringify(meta),
        lastHeartbeatAt: new Date(),
      },
    });

    logger.log(`[SessionStore] Backed up ${Object.keys(sessionFiles).length} session files to MongoDB for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[SessionStore] Could not backup session for ${userId}: ${err.message}`);
  }
}

export async function restoreAllSessionsFromMongo(prisma: PrismaService): Promise<number> {
  let restoredCount = 0;
  try {
    const connections = await prisma.whatsAppConnection.findMany({
      where: {
        isActive: true,
        encryptedSessionData: { not: null },
      },
    });

    for (const conn of connections) {
      if (!conn.encryptedSessionData) continue;
      const userId = conn.userId;
      const sessionDir = path.join(process.cwd(), 'sessions', userId);
      const credsPath = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsPath)) continue;

      let meta: any = null;
      try {
        meta = JSON.parse(conn.encryptedSessionData);
      } catch {
        continue;
      }

      const files = meta?.sessionFiles;
      if (!files || !files['creds.json']) continue;

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      for (const [filename, content] of Object.entries(files)) {
        if (filename.endsWith('.json') && typeof content === 'string') {
          fs.writeFileSync(path.join(sessionDir, filename), content, 'utf-8');
        }
      }

      logger.log(`[SessionStore] Restored ${Object.keys(files).length} session files from MongoDB for user ${userId}`);
      restoredCount++;
    }
  } catch (err: any) {
    logger.warn(`[SessionStore] Restore all sessions error: ${err.message}`);
  }
  return restoredCount;
}

export async function clearSessionFromMongo(prisma: PrismaService, userId: string): Promise<void> {
  try {
    const conn = await prisma.whatsAppConnection.findFirst({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (conn) {
      let meta: any = {};
      try {
        if (conn.encryptedSessionData) {
          meta = JSON.parse(conn.encryptedSessionData);
        }
      } catch {}
      delete meta.sessionFiles;
      await prisma.whatsAppConnection.update({
        where: { id: conn.id },
        data: {
          encryptedSessionData: JSON.stringify(meta),
          connectionStatus: 'DISCONNECTED',
          isActive: false,
          disconnectedAt: new Date(),
        },
      });
    }
  } catch (err: any) {
    logger.warn(`[SessionStore] Clear session error for ${userId}: ${err.message}`);
  }
}
