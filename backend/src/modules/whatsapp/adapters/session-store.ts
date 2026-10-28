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

    let conn = await prisma.whatsAppConnection.findFirst({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });

    if (!conn) {
      conn = await prisma.whatsAppConnection.findFirst({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      });
    }

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
        isActive: true,
        lastHeartbeatAt: new Date(),
      },
    });

    logger.log(`[SessionStore] Backed up ${Object.keys(sessionFiles).length} session files to MongoDB for user ${userId}`);
  } catch (err: any) {
    logger.warn(`[SessionStore] Could not backup session for ${userId}: ${err.message}`);
  }
}

export async function restoreSessionForUserFromMongo(prisma: PrismaService, userId: string): Promise<boolean> {
  try {
    const sessionDir = path.join(process.cwd(), 'sessions', userId);
    const credsPath = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsPath)) return true;

    const connections = await prisma.whatsAppConnection.findMany({
      where: {
        userId,
        encryptedSessionData: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });

    for (const conn of connections) {
      if (!conn.encryptedSessionData) continue;
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

      if (!conn.isActive) {
        await prisma.whatsAppConnection.update({
          where: { id: conn.id },
          data: { isActive: true },
        }).catch(() => {});
      }

      logger.log(`[SessionStore] Restored ${Object.keys(files).length} session files for user ${userId}`);
      return true;
    }
  } catch (err: any) {
    logger.warn(`[SessionStore] Restore session for user ${userId} error: ${err.message}`);
  }
  return false;
}

export async function restoreAllSessionsFromMongo(prisma: PrismaService): Promise<number> {
  let restoredCount = 0;
  try {
    // Check all connections with encryptedSessionData, newest first
    const connections = await prisma.whatsAppConnection.findMany({
      where: {
        encryptedSessionData: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const restoredUsers = new Set<string>();

    for (const conn of connections) {
      if (!conn.encryptedSessionData) continue;
      const userId = conn.userId;
      if (restoredUsers.has(userId)) continue;

      const sessionDir = path.join(process.cwd(), 'sessions', userId);
      const credsPath = path.join(sessionDir, 'creds.json');
      if (fs.existsSync(credsPath)) {
        restoredUsers.add(userId);
        continue;
      }

      let meta: any = null;
      try {
        meta = JSON.parse(conn.encryptedSessionData);
      } catch {
        continue;
      }

      const files = meta?.sessionFiles;
      if (!files || !files['creds.json']) continue;

      restoredUsers.add(userId);

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      for (const [filename, content] of Object.entries(files)) {
        if (filename.endsWith('.json') && typeof content === 'string') {
          fs.writeFileSync(path.join(sessionDir, filename), content, 'utf-8');
        }
      }

      if (!conn.isActive) {
        await prisma.whatsAppConnection.update({
          where: { id: conn.id },
          data: { isActive: true },
        }).catch(() => {});
      }

      // Deactivate any orphaned/incomplete connections for this user
      await prisma.whatsAppConnection.updateMany({
        where: {
          userId,
          id: { not: conn.id },
          isActive: true,
        },
        data: { isActive: false },
      }).catch(() => {});

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
