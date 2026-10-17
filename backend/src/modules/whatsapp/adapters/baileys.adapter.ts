import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  WASocket,
  proto,
  WAMessageKey,
} from '@whiskeysockets/baileys';
import {
  ConnectionState,
  IWhatsAppAdapter,
  WhatsAppAdapterEvents,
} from './whatsapp-adapter.interface';
import { HistoryCache, CachedHistory } from './history-cache';
import { reconnectDelayMs, isTerminalClose } from './reconnect-policy';

const baileysLogger = pino({ level: 'silent' });

export function unwrapMessage(msg: any): { textContent: string; messageType: string; mediaUrl?: string } {
  if (!msg) return { textContent: '', messageType: 'TEXT' };

  let m = msg;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessageV2Extension?.message) m = m.viewOnceMessageV2Extension.message;
  if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;
  if (m.editedMessage?.message?.protocolMessage?.editedMessage) {
    m = m.editedMessage.message.protocolMessage.editedMessage;
  }

  if (m.conversation) return { textContent: m.conversation, messageType: 'TEXT' };
  if (m.extendedTextMessage?.text) return { textContent: m.extendedTextMessage.text, messageType: 'TEXT' };
  if (m.imageMessage) {
    const caption = m.imageMessage.caption || '';
    return {
      textContent: caption ? `📷 ${caption}` : '📷 Photo',
      messageType: 'IMAGE',
      mediaUrl: m.imageMessage.url || undefined,
    };
  }
  if (m.videoMessage) {
    const caption = m.videoMessage.caption || '';
    return {
      textContent: caption ? `🎥 ${caption}` : '🎥 Video',
      messageType: 'VIDEO',
      mediaUrl: m.videoMessage.url || undefined,
    };
  }
  if (m.audioMessage) return { textContent: '🎵 Audio message', messageType: 'AUDIO' };
  if (m.documentMessage) {
    return { textContent: `📄 ${m.documentMessage.fileName || 'Document'}`, messageType: 'DOCUMENT' };
  }
  if (m.stickerMessage) return { textContent: '🎨 Sticker', messageType: 'STICKER' };
  if (m.contactMessage || m.contactsArrayMessage) return { textContent: '📇 Contact card', messageType: 'CONTACT' };
  if (m.locationMessage || m.liveLocationMessage) return { textContent: '📍 Location', messageType: 'LOCATION' };
  if (m.reactionMessage) return { textContent: `Reaction: ${m.reactionMessage.text || ''}`, messageType: 'REACTION' };

  return { textContent: '', messageType: 'TEXT' };
}

@Injectable()
export class BaileysAdapter implements IWhatsAppAdapter {
  private readonly logger = new Logger(BaileysAdapter.name);
  private readonly emitter = new EventEmitter();
  private sockets: Map<string, WASocket> = new Map();
  private activeQrCodes: Map<string, string> = new Map();
  private connectionStates: Map<string, ConnectionState> = new Map();
  private messageFetcher?: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  private readonly historyCache = new HistoryCache();

  getCachedHistory(userId: string): CachedHistory {
    return this.historyCache.snapshot(userId);
  }

  seedHistoryCache(userId: string, data: CachedHistory) {
    this.historyCache.recordChats(userId, data.chats);
    this.historyCache.recordContacts(userId, data.contacts);
    this.historyCache.recordMessages(userId, data.messages, (m) => m?.conversation || '');
  }

  setMessageFetcher(fetcher: (key: WAMessageKey) => Promise<proto.IMessage | undefined>) {
    this.messageFetcher = fetcher;
  }

  on<K extends keyof WhatsAppAdapterEvents>(event: K, listener: WhatsAppAdapterEvents[K]): void {
    this.emitter.on(event, listener);
  }

  off<K extends keyof WhatsAppAdapterEvents>(event: K, listener: WhatsAppAdapterEvents[K]): void {
    this.emitter.off(event, listener);
  }

  private emit<K extends keyof WhatsAppAdapterEvents>(
    event: K,
    ...args: Parameters<WhatsAppAdapterEvents[K]>
  ) {
    this.emitter.emit(event, ...args);
  }

  getConnectionState(userId: string): ConnectionState {
    return this.connectionStates.get(userId) || 'DISCONNECTED';
  }

  getQRCode(userId: string): string | null {
    return this.activeQrCodes.get(userId) || null;
  }

  async initialize(userId: string): Promise<void> {
    const sessionDir = path.join(process.cwd(), 'sessions', userId);
    if (fs.existsSync(sessionDir) && !this.sockets.has(userId)) {
      const { state } = await useMultiFileAuthState(sessionDir);
      if (state.creds.registered || Boolean(state.creds.me)) {
        this.connect(userId, 'QR', false).catch((err) =>
          this.logger.error(`Session restoration error for ${userId}: ${err.message}`)
        );
      }
    }
  }

  async initializeRegisteredSessions(shouldRestore?: (userId: string) => Promise<boolean>): Promise<void> {
    const sessionsBase = path.join(process.cwd(), 'sessions');
    if (!fs.existsSync(sessionsBase)) return;

    try {
      const entries = fs.readdirSync(sessionsBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const userId = entry.name;
        if (!/^[0-9a-fA-F]{24}$/.test(userId)) continue;
        const credsPath = path.join(sessionsBase, userId, 'creds.json');
        if (fs.existsSync(credsPath)) {
          try {
            const credsRaw = fs.readFileSync(credsPath, 'utf-8');
            const creds = JSON.parse(credsRaw);
            const isRegistered = creds.registered || Boolean(creds.me);
            if (isRegistered && shouldRestore && !(await shouldRestore(userId))) {
              this.logger.warn(
                `Skipping saved WhatsApp session ${userId}: that user does not exist in the connected database. ` +
                  `Restoring it would save chats under a user nobody can log in as. (Session files are left untouched.)`
              );
            } else if (isRegistered) {
              this.logger.log(`Found active registered session for user ${userId}. Restoring connection...`);
              this.connect(userId, 'QR', false).catch((err) => {
                this.logger.error(`Error auto-restoring session for ${userId}: ${err.message}`);
              });
            }
          } catch (e: any) {
            this.logger.warn(`Could not read session creds for ${userId}: ${e.message}`);
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed reading sessions directory: ${err.message}`);
    }
  }

  async getGroupMetadata(userId: string, groupId: string): Promise<any> {
    const sock = this.sockets.get(userId);
    if (!sock) return null;
    try {
      return await sock.groupMetadata(groupId);
    } catch (err: any) {
      this.logger.warn(`Failed to fetch groupMetadata for ${groupId}: ${err.message}`);
      return null;
    }
  }

  async getNewsletterMetadata(
    userId: string,
    jid: string
  ): Promise<{ title?: string; description?: string; avatarUrl?: string } | null> {
    const sock = this.sockets.get(userId);
    if (!sock) return null;
    try {
      const res = await (sock as any).newsletterMetadata('jid', jid);
      if (!res) return null;
      const title =
        res.name ||
        res.thread_metadata?.name?.text ||
        res.metadata?.name ||
        null;
      const description =
        res.description ||
        res.thread_metadata?.description?.text ||
        null;
      const avatarUrl =
        res.picture ||
        res.thread_metadata?.picture?.direct_path ||
        res.preview ||
        null;

      return {
        title: typeof title === 'string' && title.trim() && title.trim() !== 'Unnamed Channel' ? title.trim() : undefined,
        description: typeof description === 'string' && description.trim() ? description.trim() : undefined,
        avatarUrl: typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : undefined,
      };
    } catch (err: any) {
      this.logger.debug(`Failed to fetch newsletterMetadata for ${jid}: ${err.message}`);
      return null;
    }
  }

  getSelfIdentity(userId: string): { id?: string; phoneNumber?: string; displayName?: string } | null {
    const sock = this.sockets.get(userId);
    if (!sock || !sock.user) return null;
    const rawJid = sock.user.id || '';
    const rawPhone = rawJid.split(':')[0] || rawJid.split('@')[0] || '';
    const phoneNumber = rawPhone ? `+${rawPhone}` : undefined;
    return {
      id: sock.user.id,
      phoneNumber,
      displayName: sock.user.name || undefined,
    };
  }

  async fetchGroups(userId: string): Promise<any[]> {
    const sock = this.sockets.get(userId);
    if (!sock) return [];
    try {
      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups || {});
      return groupList.map((g) => ({
        id: g.id,
        subject: g.subject || 'Unnamed Group',
        owner: g.owner,
        creation: g.creation,
        desc: g.desc,
        participantsCount: g.participants?.length || 0,
      }));
    } catch (err: any) {
      this.logger.warn(`Failed to fetch participating groups for ${userId}: ${err.message}`);
      return [];
    }
  }

  async resyncSession(userId: string): Promise<{ groupsCount: number }> {
    const sock = this.sockets.get(userId);
    if (!sock) return { groupsCount: 0 };

    let groupsCount = 0;
    try {
      this.logger.log(`[RESYNC] Fetching participating WhatsApp groups for ${userId}...`);
      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups || {});
      groupsCount = groupList.length;
      if (groupList.length > 0) {
        this.emit('groups.upsert', {
          userId,
          groups: groupList.map((g) => ({
            id: g.id,
            subject: g.subject || 'Unnamed Group',
            owner: g.owner,
            creation: g.creation,
            desc: g.desc,
            participantsCount: g.participants?.length || 0,
          })),
        });
      }
    } catch (err: any) {
      this.logger.warn(`Failed to fetch groups during resync: ${err.message}`);
    }

    try {
      this.logger.log(`[RESYNC] Triggering WhatsApp app state resync with full snapshot for ${userId}...`);
      if ((sock as any).authState?.keys?.set) {
        await (sock as any).authState.keys.set({
          'app-state-sync-version': {
            critical_block: null,
            critical_unblock_low: null,
            regular_high: null,
            regular_low: null,
            regular: null,
          },
        });
      }
      await sock.resyncAppState(
        ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
        true
      );
      try {
        (sock.ev as any).flush?.();
      } catch {}
      this.logger.log(`[RESYNC] App state resync completed for ${userId}`);
    } catch (err: any) {
      this.logger.warn(`Failed to resync app state: ${err.message}`);
    }

    return { groupsCount };
  }

  async fetchChatHistory(userId: string, externalChatId: string, count: number = 50): Promise<void> {
    const sock = this.sockets.get(userId);
    if (!sock) return;

    try {
      this.logger.log(`[Baileys] Requesting message history for chat ${externalChatId} (user: ${userId})...`);
      const oldestMsgKey = {
        remoteJid: externalChatId,
        fromMe: false,
        id: `req_${Date.now()}`,
      };
      await (sock as any).fetchMessageHistory(count, oldestMsgKey, Date.now());
      this.logger.log(`[Baileys] Message history requested for chat ${externalChatId}`);
    } catch (err: any) {
      this.logger.warn(`[Baileys] Failed to fetch message history for ${externalChatId}: ${err.message}`);
    }
  }

  private knownLidMappings = new Map<string, string>();

  /** Side tasks must never stop WhatsApp events from reaching the sync pipeline. */
  private runSideEffect(label: string, fn: () => void) {
    try {
      fn();
    } catch (err: any) {
      this.logger.error(`[SIDE_EFFECT] ${label} failed: ${err?.message || err}`);
    }
  }

  /**
   * WhatsApp now identifies many people by an internal LID instead of their phone
   * number. Message keys carry the phone number alongside the LID (senderPn /
   * participantPn), which is the only source for the mapping. Emit each new or
   * changed pair once so the chat list can be matched to the phonebook.
   */
  private captureLidMappings(userId: string, messages: any[]) {
    for (const m of messages || []) {
      const key = m?.key;
      if (!key) continue;
      const pairs: Array<[string | undefined, string | undefined]> = [];
      if (key.remoteJid?.endsWith('@lid') && !key.fromMe) pairs.push([key.remoteJid, key.senderPn]);
      if (key.participantLid && key.participantPn) pairs.push([key.participantLid, key.participantPn]);
      if (key.senderLid && key.senderPn) pairs.push([key.senderLid, key.senderPn]);

      for (const [lid, pn] of pairs) {
        if (!lid?.endsWith('@lid') || !pn?.endsWith('@s.whatsapp.net')) continue;
        const cacheKey = `${userId}|${lid}`;
        if (this.knownLidMappings.get(cacheKey) === pn) continue;
        this.knownLidMappings.set(cacheKey, pn);
        this.emit('lid-mapping.update', { userId, lid, phoneJid: pn });
      }
    }
  }

  private reconnectAttempts = new Map<string, number>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  private scheduleReconnect(userId: string, method: 'QR' | 'PAIRING_CODE', immediate: boolean) {
    if (this.reconnectTimers.has(userId)) return;
    const attempt = this.reconnectAttempts.get(userId) || 0;
    this.reconnectAttempts.set(userId, attempt + 1);
    const delay = reconnectDelayMs(attempt, immediate);
    this.logger.log(`[Lifecycle: RECONNECTING] Attempt ${attempt + 1} for ${userId} in ${delay}ms`);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(userId);
      try {
        await this.connect(userId, method, false);
      } catch (err: any) {
        this.logger.error(`Reconnection attempt ${attempt + 1} failed for ${userId}: ${err.message}`);
        this.connectionStates.set(userId, 'INITIALIZING');
        this.scheduleReconnect(userId, method, false);
      }
    }, delay);
    this.reconnectTimers.set(userId, timer);
  }

  private resetReconnectState(userId: string) {
    this.reconnectAttempts.delete(userId);
    const timer = this.reconnectTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(userId);
  }

  async clearSession(userId: string): Promise<void> {
    this.historyCache.clear(userId);
    const sessionDir = path.join(process.cwd(), 'sessions', userId);
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        this.logger.log(`Cleared session directory for user ${userId}`);
      } catch (err: any) {
        this.logger.warn(`Failed to clear session directory for user ${userId}: ${err.message}`);
      }
    }
  }

  async connect(
    userId: string,
    method: 'QR' | 'PAIRING_CODE' = 'QR',
    forceFresh: boolean = false
  ): Promise<{ status: ConnectionState; qrCode?: string }> {
    const existingState = this.connectionStates.get(userId);
    const existingSock = this.sockets.get(userId);

    // CRITICAL: If an active connection already exists, DO NOT destroy it on app reload
    if (
      existingSock &&
      !forceFresh &&
      (existingState === 'CONNECTED' ||
        existingState === 'READY' ||
        existingState === 'AUTHENTICATING' ||
        existingState === 'SYNCING')
    ) {
      this.logger.log(
        `Active Baileys socket already exists for ${userId} [State: ${existingState}]. Preserving existing connection.`
      );
      return {
        status: existingState,
        qrCode: this.activeQrCodes.get(userId) || undefined,
      };
    }

    if (existingSock) {
      try {
        existingSock.ev.removeAllListeners('connection.update');
        existingSock.end(undefined);
      } catch {}
      this.sockets.delete(userId);
    }

    const sessionDir = path.join(process.cwd(), 'sessions', userId);

    if (forceFresh) this.resetReconnectState(userId);

    if (forceFresh && fs.existsSync(sessionDir)) {
      this.historyCache.clear(userId);
      try {
        this.logger.log(`Clearing session files for fresh connect for ${userId}`);
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (err: any) {
        this.logger.warn(`Failed to clear session directory for ${userId}: ${err.message}`);
      }
    }

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1043857760] as [number, number, number],
    }));

    const initialState: ConnectionState = method === 'PAIRING_CODE' ? 'PAIRING_CODE_PENDING' : 'QR_PENDING';
    this.connectionStates.set(userId, initialState);

    this.logger.log(
      `Initializing Baileys socket for ${userId} [Mode: ${method}, Version: ${version.join('.')}, Registered: ${Boolean(
        state.creds.registered
      )}]`
    );

    const sock = makeWASocket({
      version,
      logger: baileysLogger as any,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
      },
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false, // CRITICAL: Prevents sending presence before security keys are finalized
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      getMessage: async (key) => {
        if (this.messageFetcher && key) {
          try {
            const msg = await this.messageFetcher(key);
            if (msg) return msg;
          } catch {}
        }
        return proto.Message.fromObject({});
      },
    });

    this.sockets.set(userId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin, isOnline, receivedPendingNotifications } = update;

      if (qr && method === 'QR') {
        const qrCodeDataUrl = await QRCode.toDataURL(qr);
        this.activeQrCodes.set(userId, qrCodeDataUrl);
        this.connectionStates.set(userId, 'QR_PENDING');
        this.logger.log(`[Lifecycle: QR_GENERATED] New QR code generated for user ${userId}`);

        this.emit('connection.update', {
          userId,
          status: 'QR_PENDING',
          qrCode: qrCodeDataUrl,
        });
      }

      if (connection === 'connecting') {
        this.connectionStates.set(userId, 'AUTHENTICATING');
        this.logger.log(`[Lifecycle: AUTHENTICATION_STARTED] Socket connecting for user ${userId}`);
        this.emit('connection.update', { userId, status: 'AUTHENTICATING' });
      }

      if (connection === 'open') {
        this.logger.log(
          `[Lifecycle: CONNECTION_OPEN] Baileys connection OPEN for user ${userId} [IsNewLogin: ${Boolean(
            isNewLogin
          )}, IsOnline: ${Boolean(isOnline)}]`
        );
        this.activeQrCodes.delete(userId);
        this.connectionStates.set(userId, 'CONNECTED');
        this.resetReconnectState(userId);

        const rawJid = sock.user?.id || '';
        const rawPhone = rawJid.split(':')[0] || rawJid.split('@')[0] || '';
        const phoneNumber = rawPhone ? `+${rawPhone}` : undefined;
        const displayName = sock.user?.name || `WhatsApp User`;

        this.emit('connection.update', {
          userId,
          status: 'CONNECTED',
          phoneNumber,
          displayName,
        });

        // Automatically fetch and synchronize all participating groups with human-readable titles
        setTimeout(async () => {
          try {
            this.logger.log(`Fetching participating WhatsApp groups for ${userId}...`);
            const groups = await sock.groupFetchAllParticipating();
            const groupList = Object.values(groups || {});
            this.logger.log(`Found ${groupList.length} participating groups for ${userId}`);
            if (groupList.length > 0) {
              this.emit('groups.upsert', {
                userId,
                groups: groupList.map((g) => ({
                  id: g.id,
                  subject: g.subject || 'Unnamed Group',
                  owner: g.owner,
                  creation: g.creation,
                  desc: g.desc,
                  participantsCount: g.participants?.length || 0,
                })),
              });
            }
          } catch (err: any) {
            this.logger.warn(`Failed to fetch groups on connection open: ${err.message}`);
          }

          try {
            this.logger.log(`Triggering WhatsApp app state resync for ${userId}...`);
            await sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true).catch((err: any) => this.logger.warn(`App state resync notice: ${err.message}`));
            try {
              (sock.ev as any).flush?.();
            } catch {}
            this.logger.log(`App state resync triggered for ${userId}`);
          } catch (err: any) {
            this.logger.warn(`App state resync notice: ${err.message}`);
          }
        }, 1500);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const errorMsg = (lastDisconnect?.error as any)?.message || 'Connection closed';
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
        const isRegistered = Boolean(state.creds.registered);

        // Like WhatsApp Web: any drop while the session is still linked is retried
        // forever with backoff. Only logout and takeover by another device stop it.
        const shouldReconnect = isRestartRequired || !isTerminalClose(statusCode, isRegistered);

        this.logger.warn(
          `[Lifecycle: CONNECTION_CLOSED] User: ${userId}, Registered: ${isRegistered}, StatusCode: ${statusCode}, Error: ${errorMsg}, Reconnecting: ${shouldReconnect}`
        );

        // Detach connection.update listener to prevent duplicate events during socket renewal
        try {
          sock.ev.removeAllListeners('connection.update');
        } catch {}

        this.sockets.delete(userId);

        if (shouldReconnect) {
          this.connectionStates.set(userId, 'INITIALIZING');
          this.scheduleReconnect(userId, method, isRestartRequired);
        } else {
          this.connectionStates.set(userId, 'DISCONNECTED');
          this.activeQrCodes.delete(userId);
          if (isLoggedOut || statusCode === 401) {
            this.historyCache.clear(userId);
            try {
              if (fs.existsSync(sessionDir)) {
                this.logger.log(`Clearing 401/loggedOut session folder for user ${userId}`);
                fs.rmSync(sessionDir, { recursive: true, force: true });
              }
            } catch {}
          }
          this.emit('connection.update', {
            userId,
            status: 'DISCONNECTED',
            lastError: errorMsg || 'Connection closed',
          });
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      this.runSideEffect('history cache (live messages)', () =>
        this.historyCache.recordMessages(userId, messages, (msg) => unwrapMessage(msg).textContent)
      );
      this.runSideEffect('lid mappings', () => this.captureLidMappings(userId, messages));
      for (const m of messages) {
        if (!m.message) continue;
        const remoteJid = m.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const { textContent, messageType, mediaUrl } = unwrapMessage(m.message);

        const fromMe = Boolean(m.key.fromMe);
        // Do NOT default pushName to raw JID digits
        const pushName = m.pushName || (fromMe ? 'You' : undefined);
        const msgTimestamp = new Date(Number(m.messageTimestamp || 0) * 1000 || Date.now());

        this.emit('message.received', {
          userId,
          externalMessageId: m.key.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          remoteJid,
          senderJid: m.key.participant || remoteJid,
          pushName,
          textContent,
          isFromMe: fromMe,
          timestamp: msgTimestamp,
          rawMessage: {
            ...m,
            unwrappedType: messageType,
            mediaUrl,
          },
        });
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!u.key.remoteJid || !u.key.id) continue;
        let statusStr: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' = 'SENT';
        if (u.update.status === proto.WebMessageInfo.Status.DELIVERY_ACK) statusStr = 'DELIVERED';
        if (u.update.status === proto.WebMessageInfo.Status.READ || u.update.status === proto.WebMessageInfo.Status.PLAYED) statusStr = 'READ';
        if (u.update.status === proto.WebMessageInfo.Status.ERROR) statusStr = 'FAILED';

        this.emit('message.status', {
          userId,
          externalMessageId: u.key.id,
          remoteJid: u.key.remoteJid,
          status: statusStr,
          timestamp: new Date(),
        });
      }
    });

    sock.ev.on('groups.update', (groupUpdates) => {
      for (const g of groupUpdates) {
        if (!g.id) continue;
        this.emit('groups.update', {
          userId,
          groupId: g.id,
          subject: g.subject,
          desc: g.desc,
        });
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      if (chats && chats.length > 0) {
        this.historyCache.recordChats(userId, chats);
        this.emit('chats.upsert', {
          userId,
          chats: chats.map((c) => ({
            id: c.id,
            name: c.name || undefined,
            unreadCount: c.unreadCount || undefined,
            conversationTimestamp: typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : (typeof c.conversationTimestamp === 'object' ? Number(c.conversationTimestamp) : undefined),
          })),
        });
      }
    });

    sock.ev.on('chats.update', (updates) => {
      if (updates && updates.length > 0) {
        this.historyCache.recordChats(userId, updates as any[]);
        this.emit('chats.upsert', {
          userId,
          chats: updates
            .filter((c) => c.id && c.id !== 'status@broadcast')
            .map((c) => ({
              id: c.id!,
              name: c.name || undefined,
              unreadCount: c.unreadCount || undefined,
              conversationTimestamp: typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : (typeof c.conversationTimestamp === 'object' ? Number(c.conversationTimestamp) : undefined),
            })),
        });
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      if (contacts && contacts.length > 0) {
        this.historyCache.recordContacts(userId, contacts);
        this.emit('contacts.upsert', {
          userId,
          contacts: contacts.map((c) => ({
            id: c.id,
            lid: c.lid,
            jid: c.jid,
            name: c.name,
            notify: c.notify,
            verifiedName: c.verifiedName,
          })),
        });
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      if (updates && updates.length > 0) {
        this.historyCache.recordContacts(userId, updates as any[]);
        this.emit('contacts.upsert', {
          userId,
          contacts: updates
            .filter((c) => c.id && c.id !== 'status@broadcast')
            .map((c) => ({
              id: c.id!,
              lid: c.lid || undefined,
              jid: c.jid || undefined,
              name: c.name || undefined,
              notify: c.notify || undefined,
              verifiedName: c.verifiedName || undefined,
            })),
        });
      }
    });

    sock.ev.on('messaging-history.set', (payload: any) => {
      this.logger.log(
        `[Baileys] messaging-history.set received for ${userId}: ${payload.chats?.length || 0} chats, ${payload.contacts?.length || 0} contacts, ${payload.messages?.length || 0} messages [SyncType: ${payload.syncType}]`
      );
      this.runSideEffect('history cache (chats)', () => this.historyCache.recordChats(userId, payload.chats || []));
      this.runSideEffect('history cache (contacts)', () => this.historyCache.recordContacts(userId, payload.contacts || []));
      this.runSideEffect('history cache (messages)', () =>
        this.historyCache.recordMessages(userId, payload.messages || [], (msg) => unwrapMessage(msg).textContent)
      );
      this.runSideEffect('lid mappings', () => this.captureLidMappings(userId, payload.messages || []));
      this.emit('messaging-history.set', {
        userId,
        chats: (payload.chats || []).map((c: any) => ({
          id: c.id,
          name: c.name || undefined,
          unreadCount: c.unreadCount || undefined,
          conversationTimestamp:
            typeof c.conversationTimestamp === 'number'
              ? c.conversationTimestamp
              : typeof c.conversationTimestamp === 'object'
              ? Number(c.conversationTimestamp)
              : undefined,
        })),
        contacts: (payload.contacts || []).map((c: any) => ({
          id: c.id,
          lid: c.lid,
          jid: c.jid,
          name: c.name,
          notify: c.notify,
          verifiedName: c.verifiedName,
        })),
        messages: payload.messages || [],
        syncType: payload.syncType,
        progress: payload.progress,
        isLatest: payload.isLatest,
      });
    });

    sock.ev.on('message-receipt.update', (receipts: any[]) => {
      if (!receipts || receipts.length === 0) return;
      const parsedReceipts = receipts.map((r) => ({
        externalMessageId: r.key.id,
        remoteJid: r.key.remoteJid,
        receiptType: r.receipt?.receiptType || 'read',
        timestamp: new Date(Number(r.receipt?.readTimestamp || Date.now() / 1000) * 1000),
      }));
      this.emit('message-receipt.update', { userId, receipts: parsedReceipts });
    });

    sock.ev.on('group-participants.update', (update: { id: string; participants: string[]; action: any }) => {
      if (!update || !update.id) return;
      this.emit('group-participants.update', {
        userId,
        groupId: update.id,
        participants: update.participants || [],
        action: update.action,
      });
    });

    (sock.ev as any).on('lid-mapping.update', (mapping: any) => {
      if (!mapping || !mapping.lid || !mapping.phoneJid) return;
      this.emit('lid-mapping.update', {
        userId,
        lid: mapping.lid,
        phoneJid: mapping.phoneJid,
      });
    });

    sock.ev.on('messages.delete', (item: any) => {
      if (item && item.keys) {
        const messageIds = item.keys.map((k: any) => k.id).filter(Boolean);
        if (messageIds.length > 0) {
          this.emit('messages.delete', { userId, messageIds, remoteJid: item.keys[0]?.remoteJid });
        }
      }
    });

    sock.ev.on('chats.delete', (chatIds: string[]) => {
      if (chatIds && chatIds.length > 0) {
        this.historyCache.removeChats(userId, chatIds);
        this.emit('chats.delete', { userId, chatIds });
      }
    });

    sock.ev.on('presence.update', ({ id, presences }: any) => {
      if (!id || !presences) return;
      const contactPresence = presences[id] || Object.values(presences || {})[0];
      const lastKnownPresence = (contactPresence as any)?.lastKnownPresence || 'unavailable';
      const isTyping = lastKnownPresence === 'composing' || lastKnownPresence === 'recording';
      this.emit('presence.update', {
        userId,
        remoteJid: id,
        presence: lastKnownPresence,
        isTyping,
      });
    });

    if (state.creds.registered || Boolean(state.creds.me)) {
      this.connectionStates.set(userId, 'CONNECTED');
      return { status: 'CONNECTED' };
    }

    await new Promise((r) => setTimeout(r, 1200));
    const initialQr = this.activeQrCodes.get(userId);

    return {
      status: initialState,
      qrCode: initialQr || undefined,
    };
  }

  async requestPairingCode(userId: string, phoneNumber: string): Promise<string> {
    let cleanPhone = (phoneNumber || '').replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = cleanPhone.slice(1);
    }
    // Auto-prefix country code 91 if a 10-digit Indian phone number is supplied without country code
    if (cleanPhone.length === 10 && /^[6-9]/.test(cleanPhone)) {
      cleanPhone = `91${cleanPhone}`;
    }

    if (!cleanPhone || cleanPhone.length < 10 || cleanPhone.length > 15) {
      throw new Error('Invalid phone number. Please include country code e.g. +91 9876543210');
    }

    let sock = this.sockets.get(userId);
    const currentState = this.connectionStates.get(userId);

    // If no socket exists or currently in QR mode, initialize in PAIRING_CODE mode
    if (!sock || currentState !== 'PAIRING_CODE_PENDING') {
      await this.connect(userId, 'PAIRING_CODE', true);
      sock = this.sockets.get(userId);
    }

    if (!sock) {
      throw new Error('Failed to initialize Baileys pairing socket');
    }

    this.logger.log(`Requesting official Baileys pairing code for user ${userId} phone +${cleanPhone}`);
    
    // Wait briefly for socket WS handshake to complete before requesting pairing code
    await new Promise((r) => setTimeout(r, 2500));

    try {
      const rawCode = await sock.requestPairingCode(cleanPhone);
      const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      this.connectionStates.set(userId, 'PAIRING_CODE_PENDING');

      this.emit('connection.update', {
        userId,
        status: 'PAIRING_CODE_PENDING',
        pairingCode: formattedCode,
        phoneNumber: `+${cleanPhone}`,
      });

      return formattedCode;
    } catch (err: any) {
      this.logger.error(`Error requesting pairing code for user ${userId}: ${err.message}`);
      throw new Error(err.message || 'Failed to request WhatsApp pairing code from server');
    }
  }

  async sendMessage(userId: string, remoteJid: string, text: string): Promise<void> {
    const sock = this.sockets.get(userId);
    if (!sock) {
      throw new Error(`No active WhatsApp connection for user ${userId}. Please connect WhatsApp first.`);
    }
    await sock.sendMessage(remoteJid, { text });
    this.logger.log(`Message sent via Baileys to ${remoteJid}`);
  }

  async disconnect(userId: string): Promise<void> {
    this.resetReconnectState(userId);
    this.historyCache.clear(userId);
    const sock = this.sockets.get(userId);
    if (sock) {
      try {
        await sock.logout();
      } catch {}
      try {
        sock.end(undefined);
      } catch {}
      this.sockets.delete(userId);
    }

    this.activeQrCodes.delete(userId);
    this.connectionStates.set(userId, 'DISCONNECTED');

    const sessionDir = path.join(process.cwd(), 'sessions', userId);
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      } catch (e: any) {
        this.logger.warn(`Failed to clean session folder for ${userId}: ${e.message}`);
      }
    }

    this.emit('connection.update', { userId, status: 'DISCONNECTED' });
  }



  /** Asks WhatsApp for the LID of each phone number, so chats addressed by LID can be linked. */
  async lookupLidsForPhones(
    userId: string,
    phoneJids: string[]
  ): Promise<{ pairs: Array<{ phoneJid: string; lid: string }>; answered: number; error?: string }> {
    const sock = this.sockets.get(userId);
    if (!sock) return { pairs: [], answered: 0, error: 'WhatsApp is not connected' };
    if (phoneJids.length === 0) return { pairs: [], answered: 0 };
    try {
      const results = ((await sock.onWhatsApp(...phoneJids)) || []) as Array<{
        jid: string;
        exists: boolean;
        lid?: string;
      }>;
      const pairs = results
        .filter((r) => r.exists && r.lid && r.jid?.endsWith('@s.whatsapp.net'))
        .map((r) => ({ phoneJid: r.jid, lid: r.lid as string }));
      this.logger.log(
        `[LID_LOOKUP] asked ${phoneJids.length}, WhatsApp answered ${results.length}, with LID ${pairs.length}`
      );
      return { pairs, answered: results.length };
    } catch (err: any) {
      this.logger.warn(`[LID_LOOKUP] failed for ${phoneJids.length} numbers: ${err.message}`);
      return { pairs: [], answered: 0, error: err.message };
    }
  }

  async getProfilePictureUrl(userId: string, jid: string): Promise<string | null> {
    const sock = this.sockets.get(userId);
    if (!sock) return null;
    try {
      const url = await sock.profilePictureUrl(jid, 'image');
      return url || null;
    } catch {
      return null;
    }
  }
}
