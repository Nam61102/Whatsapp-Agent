import { backupSessionToMongo, restoreAllSessionsFromMongo, clearSessionFromMongo } from './adapters/session-store';
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../gateway/events.gateway';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { WhatsAppEventService } from './whatsapp-event.service';
import { ConnectionState } from './adapters/whatsapp-adapter.interface';
import { DeviceContactsService } from '../../shared/device-contacts.service';
import { AIQueueService } from '../ai/ai-queue.service';
import { withTimeout } from '../../shared/with-timeout';

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly baileysAdapter: BaileysAdapter,
    private readonly eventService: WhatsAppEventService,
    private readonly deviceContacts: DeviceContactsService,
    private readonly aiQueueService: AIQueueService
  ) {
    this.setupAdapterListeners();
    this.baileysAdapter.setMessageFetcher(async (key) => {
      if (!key.id) return undefined;
      try {
        const msg = await this.prisma.message.findFirst({
          where: { externalMessageId: key.id },
          select: { metadata: true },
        });
        if (msg?.metadata && (msg.metadata as any).rawMessage?.message) {
          return (msg.metadata as any).rawMessage.message;
        }
      } catch {}
      return undefined;
    });
  }

  async onModuleInit() {
    this.logger.log('WhatsAppService initialized. WhatsApp provider mode: REAL (Baileys)');
    // Automatically restore registered Baileys sessions across server restarts
    // Long retention needs the full WhatsApp history; a short one only needs the recent part, which arrives much faster.
    this.baileysAdapter.setFullHistoryPolicy(async (_userId: string) => {
      return true;
    });
    setTimeout(async () => {
      try {
        await restoreAllSessionsFromMongo(this.prisma);
      } catch (e: any) {
        this.logger.warn(`Session restore from MongoDB error: ${e.message}`);
      }
      // Only sessions whose user exists in the connected database are restored. A session folder that
      // belongs to another database (for example the local one while using the cloud one) is skipped.
      const userExists = async (id: string) => {
        try {
          return Boolean(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }));
        } catch {
          return true; // cannot tell (database briefly unreachable): keep the session, never lock a real user out
        }
      };
      this.baileysAdapter.initializeRegisteredSessions(userExists).catch((err) => {
        this.logger.error(`Error auto-restoring WhatsApp sessions: ${err.message}`);
      });
      this.eventService.backfillChatTitles().catch((err: any) => {
        this.logger.warn(`Chat title backfill failed: ${err.message}`);
      });
    }, 1200);

    // Repair LID links every 6 hours for every connected account, so they never stay stale.
    setInterval(async () => {
      const connected = await this.prisma.whatsAppAccount.findMany({
        where: { status: 'CONNECTED' },
        select: { id: true, userId: true },
      });
      for (const acc of connected) {
        this.linkSavedContactsToLids(acc.userId, acc.id).catch((err: any) =>
          this.logger.warn(`[LID_LINK] scheduled run failed: ${err.message}`)
        );
      }
    }, 6 * 60 * 60 * 1000);
  }

  async onModuleDestroy() {
    // Sockets cleaned up via adapter teardown
  }

  getSyncProgress(userId: string) {
    return this.eventService.getSyncProgress(userId);
  }

  private historyQueues = new Map<string, Promise<void>>();
  private linkingNow = new Set<string>();
  private linkTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Runs the LID link once contacts stop arriving. Contacts come in over several
   * events after a link, so each new event pushes the run back instead of racing it.
   */
  private scheduleLinkSync(userId: string, accountId: string, delayMs = 15000) {
    const existing = this.linkTimers.get(accountId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.linkTimers.delete(accountId);
      this.linkSavedContactsToLids(userId, accountId).catch((err: any) =>
        this.logger.warn(`[LID_LINK] Failed for user ${userId}: ${err.message}`)
      );
    }, delayMs);
    this.linkTimers.set(accountId, timer);
  }

  private enqueueHistory(userId: string, task: () => Promise<void>) {
    const previous = this.historyQueues.get(userId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((err: any) => {
        this.logger.error(`[HISTORY_SYNC] Failed for user ${userId}: ${err?.stack || err?.message || err}`);
      });
    this.historyQueues.set(userId, next);
  }

  private setupAdapterListeners() {
    this.baileysAdapter.on('connection.update', async (update) => {
      const { userId, ...rest } = update;
      if (!userId) return;

      const account = await this.getOrCreateAccount(userId);
      const isConnected = update.status === 'CONNECTED' || update.status === 'READY';
      const isConnecting =
        update.status === 'QR_PENDING' ||
        update.status === 'PAIRING_CODE_PENDING' ||
        update.status === 'AUTHENTICATING';

      let conn = await this.prisma.whatsAppConnection.findFirst({
        where: { whatsappAccountId: account.id, isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (!conn) {
        conn = await this.prisma.whatsAppConnection.create({
          data: {
            userId: account.userId,
            whatsappAccountId: account.id,
            providerSessionId: userId,
            connectionStatus: update.status,
            isActive: isConnected || isConnecting,
            ...(isConnected ? { connectedAt: new Date(), lastHeartbeatAt: new Date() } : {}),
          },
        });
      } else {
        let meta: any = {};
        try {
          if (conn.encryptedSessionData) meta = JSON.parse(conn.encryptedSessionData);
        } catch {}
        if (update.phoneNumber) meta.phoneNumber = update.phoneNumber;
        if (isConnected) meta.connectedAt = new Date().toISOString();

        await this.prisma.whatsAppConnection.update({
          where: { id: conn.id },
          data: {
            connectionStatus: update.status,
            isActive: isConnected || isConnecting,
            encryptedSessionData: JSON.stringify(meta),
            ...(isConnected ? { connectedAt: new Date(), lastHeartbeatAt: new Date() } : {}),
          },
        });
      }

      await this.eventService.handleConnectionUpdate(userId, account.id, rest);

      if (update.status === 'CONNECTED') {
        this.scheduleLinkSync(userId, account.id);
        backupSessionToMongo(this.prisma, userId).catch(() => {});
      }
    });

    this.baileysAdapter.on('message.received', async (payload) => {
      const { userId, ...rest } = payload;
      if (!userId) return;

      try {
        const account = await this.getOrCreateAccount(userId);
        await this.eventService.handleIncomingMessage(userId, account.id, rest);
      } catch (err: any) {
        this.logger.error(`[MESSAGE_RECEIVED] Failed for user ${userId}: ${err?.stack || err?.message || err}`);
      }
    });

    this.baileysAdapter.on('message.status', async (payload) => {
      const { userId, ...rest } = payload;
      if (!userId) return;

      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleMessageStatus(userId, account.id, rest);
    });

    this.baileysAdapter.on('contacts.upsert', async (payload) => {
      const { userId, contacts } = payload;
      if (!userId || !contacts || contacts.length === 0) return;

      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleContactsUpsert(userId, account.id, contacts);
      this.scheduleLinkSync(userId, account.id);
    });

    this.baileysAdapter.on('groups.upsert', async (payload) => {
      const { userId, groups } = payload;
      if (!userId || !groups || groups.length === 0) return;

      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleGroupsUpsert(userId, account.id, groups);
    });

    this.baileysAdapter.on('groups.update', async (payload) => {
      const { userId, groupId, subject, desc } = payload;
      if (!userId || !groupId) return;

      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleGroupUpdate(userId, account.id, { groupId, subject, desc });
    });

    this.baileysAdapter.on('chats.upsert', async (payload) => {
      const { userId, chats } = payload;
      if (!userId || !chats || chats.length === 0) return;

      try {
        const account = await this.getOrCreateAccount(userId);
        await this.eventService.handleChatsUpsert(userId, account.id, chats);
      } catch (err: any) {
        this.logger.error(`[CHATS_UPSERT] Failed for user ${userId}: ${err?.stack || err?.message || err}`);
      }
    });

    this.baileysAdapter.on('messaging-history.set', (payload) => {
      const { userId, ...rest } = payload;
      if (!userId) return;

      // WhatsApp sends history in several batches. Run them one after another per user,
      // so a later (older) batch never overtakes the newer one still being saved.
      this.enqueueHistory(userId, async () => {
        const account = await this.getOrCreateAccount(userId);
        await this.eventService.handleMessagingHistorySet(userId, account.id, rest);
        this.scheduleLinkSync(userId, account.id);
      });
    });

    this.baileysAdapter.on('message-receipt.update', async (payload) => {
      const { userId, receipts } = payload;
      if (!userId || !receipts || receipts.length === 0) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleMessageReceiptUpdate(userId, account.id, receipts);
    });

    this.baileysAdapter.on('group-participants.update', async (payload) => {
      const { userId, groupId, participants, action } = payload;
      if (!userId || !groupId) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleGroupParticipantsUpdate(userId, account.id, { groupId, participants, action });
    });

    this.baileysAdapter.on('lid-mapping.update', async (payload) => {
      const { userId, lid, phoneJid } = payload;
      if (!userId || !lid || !phoneJid) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleLidMappingUpdate(userId, account.id, { lid, phoneJid });
    });

    this.baileysAdapter.on('messages.delete', async (payload) => {
      const { userId, messageIds, remoteJid } = payload;
      if (!userId || !messageIds || messageIds.length === 0) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleMessagesDelete(userId, account.id, { messageIds, remoteJid });
    });

    this.baileysAdapter.on('chats.delete', async (payload) => {
      const { userId, chatIds } = payload;
      if (!userId || !chatIds || chatIds.length === 0) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handleChatsDelete(userId, account.id, chatIds);
    });

    this.baileysAdapter.on('presence.update', async (payload) => {
      const { userId, remoteJid, presence, isTyping } = payload;
      if (!userId || !remoteJid) return;
      const account = await this.getOrCreateAccount(userId);
      await this.eventService.handlePresenceUpdate(userId, account.id, { remoteJid, presence, isTyping });
    });
  }

  private async resolveUserId(userId: string): Promise<string> {
    if (!userId) return userId;
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(userId);
    try {
      const user = await this.prisma.user.findFirst({
        where: isObjectId
          ? { OR: [{ id: userId }, { authUserId: userId }] }
          : { authUserId: userId },
        select: { id: true },
      });
      return user ? user.id : userId;
    } catch (err) {
      return userId;
    }
  }

  async getOrCreateAccount(userId: string) {
    const realUserId = await this.resolveUserId(userId);
    let account = await this.prisma.whatsAppAccount.findFirst({
      where: { userId: realUserId },
    });

    if (!account) {
      account = await this.prisma.whatsAppAccount.create({
        data: {
          userId: realUserId,
          status: 'DISCONNECTED',
          displayName: 'Primary WhatsApp',
          provider: 'BAILEYS',
        },
      });
    }

    return account;
  }

  async getStatus(userId: string, clientSessionId?: string) {
    const account = await this.getOrCreateAccount(userId);
    // All of these are independent, so they run together: one round trip to the database instead of seven.
    const own = { userId: account.userId, whatsappAccountId: account.id };
    const active = { ...own, lastMessageAt: { not: null } } as const;
    const [countContacts, countGroups, countIndividualChats, countChannelChats, countChats, countMessages, activeConnection] = await Promise.all([
      // Only count contacts truly saved in the connected WhatsApp's address book
      this.prisma.contact.count({ where: { ...own, isGroup: false, isSavedContact: true } }),
      this.prisma.conversation.count({ where: { ...active, chatType: 'GROUP' } }),
      this.prisma.conversation.count({ where: { ...active, chatType: 'INDIVIDUAL' } }),
      this.prisma.conversation.count({ where: { ...active, chatType: 'CHANNEL' } }),
      this.prisma.conversation.count({ where: active }),
      this.prisma.message.count({ where: own }),
      this.prisma.whatsAppConnection.findFirst({
        where: { ...own, isActive: true },
        orderBy: { createdAt: 'desc' },
        select: {
        id: true,
        connectionStatus: true,
        connectionType: true,
        providerSessionId: true,
        encryptedSessionData: true,
        isActive: true,
        connectedAt: true,
        lastHeartbeatAt: true,
        createdAt: true,
      },
      }),
    ]);

    const currentQr = this.baileysAdapter.getQRCode(account.userId);
    const liveStatus = this.baileysAdapter.getConnectionState(account.userId);
    const isActuallyConnected =
      liveStatus === 'CONNECTED' ||
      liveStatus === 'READY' ||
      liveStatus === 'SYNCING' ||
      (account.status === 'CONNECTED' && activeConnection?.connectionStatus === 'CONNECTED');

    let alreadyConnectedOnOtherDevice = false;
    let connectedDevice: any = null;

    if (isActuallyConnected && activeConnection) {
      let sessionMeta: any = null;
      try {
        if (activeConnection.encryptedSessionData) {
          sessionMeta = JSON.parse(activeConnection.encryptedSessionData);
        }
      } catch {}

      const activeSessionId = sessionMeta?.clientSessionId || activeConnection.providerSessionId;

      if (activeSessionId && clientSessionId && activeSessionId !== clientSessionId) {
        alreadyConnectedOnOtherDevice = true;
        connectedDevice = {
          phoneNumber: account.phoneNumber || sessionMeta?.phoneNumber || 'Linked WhatsApp',
          displayName: account.displayName || 'Primary WhatsApp',
          deviceInfo: sessionMeta?.deviceInfo || 'Another Web / Mobile Device',
          clientIp: sessionMeta?.clientIp || null,
          connectedAt: activeConnection.connectedAt || activeConnection.createdAt,
        };
      }
    }

    return {
      id: account.id,
      status: liveStatus !== 'DISCONNECTED' ? liveStatus : account.status,
      phoneNumber: account.phoneNumber,
      displayName: account.displayName,
      lastSyncAt: account.lastSyncAt,
      qrCode: currentQr || null,
      connection: activeConnection
        ? {
            id: activeConnection.id,
            connectionStatus: activeConnection.connectionStatus,
            connectionType: activeConnection.connectionType,
            isActive: activeConnection.isActive,
            connectedAt: activeConnection.connectedAt,
            lastHeartbeatAt: activeConnection.lastHeartbeatAt,
          }
        : null,
      alreadyConnectedOnOtherDevice,
      isCurrentDeviceConnected: isActuallyConnected && !alreadyConnectedOnOtherDevice,
      connectedDevice,
      stats: {
        contacts: countContacts,
        groups: countGroups,
        individualChats: countIndividualChats,
        channelChats: countChannelChats,
        chats: countChats,
        messages: countMessages,
      },
    };
  }

  async initiateConnect(
    userId: string,
    method: 'QR' | 'PAIRING_CODE' = 'QR',
    forceTakeover: boolean = false,
    clientSessionId?: string,
    deviceInfo?: string,
    clientIp?: string
  ) {
    const account = await this.getOrCreateAccount(userId);
    const liveStatus = this.baileysAdapter.getConnectionState(account.userId);

    const activeConnection = await this.prisma.whatsAppConnection.findFirst({
      where: { whatsappAccountId: account.id, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    let sessionMeta: any = null;
    try {
      if (activeConnection?.encryptedSessionData) {
        sessionMeta = JSON.parse(activeConnection.encryptedSessionData);
      }
    } catch {}

    const isConnected =
      liveStatus === 'CONNECTED' ||
      liveStatus === 'READY' ||
      liveStatus === 'SYNCING' ||
      (account.status === 'CONNECTED' && activeConnection?.connectionStatus === 'CONNECTED');

    const activeSessionId = sessionMeta?.clientSessionId || activeConnection?.providerSessionId;

    // Enforce single connection: block if another session holds active connection
    if (isConnected && activeSessionId && clientSessionId && activeSessionId !== clientSessionId) {
      if (!forceTakeover) {
        this.logger.warn(
          `User ${userId} attempted connection from session ${clientSessionId}, but account is already active on session ${activeSessionId} (${account.phoneNumber})`
        );
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          alreadyConnected: true,
          message: `Another device is already connected to this WhatsApp account (${account.phoneNumber || 'Active'}). Single connection only is permitted.`,
          connectedPhoneNumber: account.phoneNumber,
          connectedDevice: {
            phoneNumber: account.phoneNumber,
            displayName: account.displayName,
            deviceInfo: sessionMeta?.deviceInfo || 'Another Web / Mobile Device',
            clientIp: sessionMeta?.clientIp || null,
            connectedAt: activeConnection?.connectedAt || activeConnection?.createdAt,
          },
        });
      } else {
        this.logger.log(
          `[TAKEOVER] Session takeover: disconnecting previous session ${activeSessionId} for user ${userId}. New session: ${clientSessionId}`
        );
        this.eventsGateway.sendToUser(userId, 'whatsapp.session_taken_over', {
          message: 'Your WhatsApp session was disconnected because another device logged in and took over the connection.',
          newDevice: deviceInfo || 'Another Device',
          timestamp: new Date(),
        });
        await this.prisma.whatsAppConnection.updateMany({
          where: { whatsappAccountId: account.id, isActive: true },
          data: { isActive: false, connectionStatus: 'DISCONNECTED', disconnectedAt: new Date() },
        });
        await this.baileysAdapter.disconnect(account.userId).catch(() => {});
      }
    }

    // If connection is already active on this same session and not forcing fresh, preserve state
    if (
      !forceTakeover &&
      (liveStatus === 'CONNECTED' ||
        liveStatus === 'READY' ||
        liveStatus === 'AUTHENTICATING' ||
        liveStatus === 'SYNCING')
    ) {
      this.logger.log(
        `Account ${account.id} for user ${userId} is already active on this device [State: ${liveStatus}]. Returning existing state.`
      );
      return this.getStatus(userId, clientSessionId);
    }

    if (forceTakeover) {
      await this.prisma.whatsAppConnection.updateMany({
        where: { whatsappAccountId: account.id, isActive: true },
        data: { isActive: false, connectionStatus: 'DISCONNECTED' },
      });
    }

    const newSessionMeta = {
      clientSessionId,
      deviceInfo: deviceInfo || 'Web/Mobile Client',
      clientIp: clientIp || null,
      phoneNumber: account.phoneNumber,
      connectedAt: new Date().toISOString(),
    };

    await this.prisma.whatsAppConnection.create({
      data: {
        userId: account.userId,
        whatsappAccountId: account.id,
        providerSessionId: clientSessionId || userId,
        encryptedSessionData: JSON.stringify(newSessionMeta),
        connectionStatus: method === 'PAIRING_CODE' ? 'PAIRING_CODE_PENDING' : 'QR_PENDING',
        connectionType: method,
        isActive: true,
        qrCreatedAt: new Date(),
      },
    });

    const res = await this.baileysAdapter.connect(account.userId, method, forceTakeover);

    await this.prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { status: res.status },
    });

    return {
      status: res.status,
      method,
      qrCode: res.qrCode || null,
    };
  }

  async requestPairingCode(
    userId: string,
    phoneNumber: string,
    forceTakeover: boolean = false,
    clientSessionId?: string,
    deviceInfo?: string,
    clientIp?: string
  ) {
    const account = await this.getOrCreateAccount(userId);

    const cleanPhone = phoneNumber.replace(/[^0-9+]/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Please enter a valid international phone number e.g. +919876543210');
    }

    const liveStatus = this.baileysAdapter.getConnectionState(account.userId);
    const activeConnection = await this.prisma.whatsAppConnection.findFirst({
      where: { whatsappAccountId: account.id, isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    let sessionMeta: any = null;
    try {
      if (activeConnection?.encryptedSessionData) {
        sessionMeta = JSON.parse(activeConnection.encryptedSessionData);
      }
    } catch {}

    const isConnected =
      liveStatus === 'CONNECTED' ||
      liveStatus === 'READY' ||
      liveStatus === 'SYNCING' ||
      (account.status === 'CONNECTED' && activeConnection?.connectionStatus === 'CONNECTED');

    const activeSessionId = sessionMeta?.clientSessionId || activeConnection?.providerSessionId;

    if (isConnected && activeSessionId && clientSessionId && activeSessionId !== clientSessionId) {
      if (!forceTakeover) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          alreadyConnected: true,
          message: `Another device is already connected to this WhatsApp account (${account.phoneNumber || 'Active'}). Single connection only is permitted.`,
          connectedPhoneNumber: account.phoneNumber,
          connectedDevice: {
            phoneNumber: account.phoneNumber,
            displayName: account.displayName,
            deviceInfo: sessionMeta?.deviceInfo || 'Another Web / Mobile Device',
            clientIp: sessionMeta?.clientIp || null,
            connectedAt: activeConnection?.connectedAt || activeConnection?.createdAt,
          },
        });
      } else {
        this.eventsGateway.sendToUser(userId, 'whatsapp.session_taken_over', {
          message: 'Your WhatsApp session was disconnected because another device logged in and took over the connection.',
          newDevice: deviceInfo || 'Another Device',
          timestamp: new Date(),
        });
        await this.prisma.whatsAppConnection.updateMany({
          where: { whatsappAccountId: account.id, isActive: true },
          data: { isActive: false, connectionStatus: 'DISCONNECTED', disconnectedAt: new Date() },
        });
        await this.baileysAdapter.disconnect(account.userId).catch(() => {});
      }
    }

    const newSessionMeta = {
      clientSessionId,
      deviceInfo: deviceInfo || 'Web/Mobile Client',
      clientIp: clientIp || null,
      phoneNumber: cleanPhone,
      connectedAt: new Date().toISOString(),
    };

    await this.prisma.whatsAppConnection.updateMany({
      where: { whatsappAccountId: account.id, isActive: true },
      data: { isActive: false, connectionStatus: 'DISCONNECTED' },
    });

    await this.prisma.whatsAppConnection.create({
      data: {
        userId: account.userId,
        whatsappAccountId: account.id,
        providerSessionId: clientSessionId || userId,
        encryptedSessionData: JSON.stringify(newSessionMeta),
        connectionStatus: 'PAIRING_CODE_PENDING',
        connectionType: 'PAIRING_CODE',
        isActive: true,
        qrCreatedAt: new Date(),
      },
    });

    await this.prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { status: 'PAIRING_CODE_PENDING' },
    });

    const pairingCode = await this.baileysAdapter.requestPairingCode(userId, cleanPhone);

    this.eventsGateway.sendToUser(userId, 'whatsapp.status', {
      status: 'PAIRING_CODE_PENDING',
      pairingCode,
      phoneNumber: cleanPhone,
    });

    return {
      status: 'PAIRING_CODE_PENDING',
      pairingCode,
      phoneNumber: cleanPhone,
    };
  }

  async disconnectOtherSession(userId: string, clientSessionId?: string, deviceInfo?: string) {
    return this.initiateConnect(userId, 'QR', true, clientSessionId, deviceInfo);
  }

  async sendWhatsAppMessage(userId: string, externalChatId: string, text: string) {
    await this.baileysAdapter.sendMessage(userId, externalChatId, text);
  }

  async disconnect(userId: string) {
    const account = await this.getOrCreateAccount(userId);
    const accountId = account.id;

    this.logger.log(`[DISCONNECT] Disconnecting WhatsApp and wiping all synced data for user ${userId} account ${accountId}`);

    // 1. Close Baileys socket and clear session files for user
    await this.baileysAdapter.disconnect(userId);
    await this.baileysAdapter.clearSession(userId);
    await clearSessionFromMongo(this.prisma, userId);

    // 2. Wipe all synced database data associated with this account
    //    (fire-and-forget; disconnect should never trigger an auto-resync)
    await this.resetSyncedData(userId, { autoResync: false });

    // 3. Mark connection and account DISCONNECTED
    await this.prisma.whatsAppConnection.updateMany({
      where: { whatsappAccountId: accountId, isActive: true },
      data: {
        isActive: false,
        connectionStatus: 'DISCONNECTED',
        disconnectedAt: new Date(),
      },
    });

    await this.prisma.whatsAppAccount.update({
      where: { id: accountId },
      data: {
        status: 'DISCONNECTED',
        phoneNumber: null,
        displayName: 'Primary WhatsApp',
        lastDisconnectedAt: new Date(),
      },
    });

    this.eventsGateway.sendToUser(userId, 'whatsapp.status', {
      status: 'DISCONNECTED',
    });
    this.eventsGateway.sendToUser(userId, 'whatsapp:data_reset', {
      whatsappAccountId: accountId,
      timestamp: new Date(),
    });

    return { status: 'DISCONNECTED', message: 'WhatsApp unlinked and all synced data wiped successfully.' };
  }

  /** Users whose wipe is running now; a second click must not start a competing wipe. */
  private readonly resetsInFlight = new Set<string>();

  async resetSyncedData(userId: string, options: { autoResync?: boolean } = {}) {
    if (this.resetsInFlight.has(userId)) {
      return { success: true, message: 'Clearing is already in progress. Please wait for it to finish.' };
    }
    const account = await this.getOrCreateAccount(userId);
    if (this.resetsInFlight.has(userId)) {
      return { success: true, message: 'Clearing is already in progress. Please wait for it to finish.' };
    }
    this.resetsInFlight.add(userId);
    const accountId = account.id;
    const autoResync = options.autoResync !== false;

    this.logger.log(
      `[RESET] Queueing async wipe of synced data for account ${accountId} (user: ${userId}, autoResync=${autoResync})`
    );

    // 1. Reset the sync progress bar + tell the UI to clear its lists IMMEDIATELY
    //    so the user never has to wait on the HTTP call.
    this.eventService.resetSyncProgress(userId);
    this.eventsGateway.sendToUser(userId, 'whatsapp:data_reset', {
      whatsappAccountId: accountId,
      timestamp: new Date(),
    });
    this.eventsGateway.sendToUser(userId, 'dashboard:updated', { type: 'RESET' });
    this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
      stage: 'clearing',
      progress: 5,
      message: 'Clearing previously synced data...',
    });

    // 2. Run the actual deletes in the background in dependency order (so FK/relation
    //    constraints never create retries). The HTTP call returns right away.
    Promise.resolve().then(async () => {
      const start = Date.now();
      try {
        // Snapshot what is in the DB into the on-disk history cache BEFORE wiping.
        // WhatsApp only sends chat history once (at device link), so this cache is
        // what lets us rebuild the lists afterwards. Skipped on disconnect, where
        // the session folder is being deleted.
        if (autoResync) {
          await this.seedHistoryCacheFromDb(userId, accountId).catch((err: any) =>
            this.logger.warn(`[RESET] Could not snapshot DB into history cache: ${err.message}`)
          );
        }

        // Each delete is isolated: a failure in one table (e.g. a stray cascade
        // issue) must NOT prevent the following tables from being wiped. In the
        // old code a single error aborted the whole sequence, leaving contacts behind.
        // Deleted straight on the database, one command per collection, in dependency order.
        // Prisma's deleteMany on MongoDB emulates cascades by looking up dependents of every
        // message inside a transaction; with tens of thousands of messages that hangs for minutes.
        const rawDelete = async (collection: string) => {
          const res: any = await this.prisma.$runCommandRaw({
            delete: collection,
            deletes: [{ q: { userId: { $oid: userId } }, limit: 0 }],
          });
          return { count: res?.n ?? 0 };
        };
        const tables: Array<{ name: string; run: () => Promise<any> }> = [
          'ai_extraction_sources',
          'ai_reply_suggestions',
          'ai_processing_jobs',
          'ai_extractions',
          'contact_ai_profiles',
          'message_statuses',
          'message_media',
          'messages',
          'conversation_summaries',
          'group_participants',
          'conversations',
          'provider_events',
          'sync_states',
          'contacts',
        ].map((name) => ({ name, run: () => rawDelete(name) }));
        for (const t of tables) {
          try {
            const res = await t.run();
            this.logger.log(`[RESET] Deleted ${res?.count ?? '?'} rows from ${t.name}`);
          } catch (err: any) {
            this.logger.error(`[RESET] FAILED to delete ${t.name}: ${err.message}`);
          }
        }

        // Second pass: any contact rows that survived the first attempt (e.g. because
        // a now-deleted cascade blocker had been in the way) must be removed too.
        try {
          const stuck = await this.prisma.contact.count({ where: { userId } });
          if (stuck > 0) {
            this.logger.warn(`[RESET] ${stuck} contact rows survived first pass — retrying wipe`);
            const retry = await this.prisma.contact.deleteMany({ where: { userId } });
            this.logger.log(`[RESET] Retry removed ${retry.count} residual contact rows`);
          }
        } catch (err: any) {
          this.logger.error(`[RESET] Contact retry wipe failed: ${err.message}`);
        }

        // NOTE: we do NOT clear the uploaded device phonebook here. The phonebook
        // belongs to the user's phone, not to WhatsApp synced data — wiping it
        // would require the mobile app to re-request Contacts permission and
        // re-upload. Keeping it means the Chats/Contacts endpoints can still
        // overlay the correct saved names onto the fresh sync.

        const [cC, convC, mC] = await Promise.all([
          this.prisma.contact.count({ where: { userId } }),
          this.prisma.conversation.count({ where: { userId } }),
          this.prisma.message.count({ where: { userId } }),
        ]);
        this.logger.log(
          `[RESET] Wipe finished in ${Date.now() - start}ms for user ${userId}. Residual counts: contacts=${cC}, conversations=${convC}, messages=${mC}`
        );

        this.eventsGateway.sendToUser(userId, 'whatsapp:stats', {
          contacts: 0,
          groups: 0,
          chats: 0,
          messages: 0,
        });
        this.eventsGateway.sendToUser(userId, 'whatsapp:data_reset', {
          whatsappAccountId: accountId,
          timestamp: new Date(),
          completed: true,
        });

        if (autoResync) {
          this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
            stage: 'syncing',
            progress: 10,
            message: 'Fetching fresh WhatsApp data (newest first)...',
          });

          // Rebuild from the on-disk history cache. WhatsApp does not resend history
          // on reconnect, so asking it again would only ever return live messages.
          const cached = this.baileysAdapter.getCachedHistory(userId);
          if (cached.chats.length > 0 || cached.messages.length > 0) {
            this.logger.log(
              `[RESET] Replaying cached history: ${cached.chats.length} chats, ${cached.contacts.length} contacts, ${cached.messages.length} messages`
            );
            await this.eventService.handleMessagingHistorySet(userId, accountId, {
              chats: cached.chats,
              contacts: cached.contacts,
              messages: cached.messages,
              isLatest: true,
              syncType: 'CACHE_REPLAY',
            });

            // The rebuilt messages are history, so live analysis ignores them. Analyse the last day,
            // capped, so the Action Center is not empty after a clear. Only messages with a real
            // signal reach the AI, so this stays cheap.
            this.aiQueueService
              .processUnprocessedMessagesOnAIEnable(userId, { maxAgeHours: 24, maxMessages: 60 })
              .catch((err: any) => this.logger.warn(`[RESET] Could not queue recent messages for AI: ${err.message}`));
          } else {
            this.logger.warn(`[RESET] History cache is empty for user ${userId}; nothing to replay.`);
            this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
              stage: 'syncing',
              progress: 10,
              message:
                'No saved chat history yet. WhatsApp only sends history when a device is linked - disconnect and link WhatsApp once to download your chats.',
            });
          }

          // Then refresh group names/participants from the live session.
          this.resyncData(userId).catch((err: any) =>
            this.logger.warn(`[RESET] Auto-resync failed: ${err.message}`)
          );
        }
      } catch (err: any) {
        this.logger.error(`[RESET] Background wipe error for user ${userId}: ${err.message}`);
        this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
          stage: 'error',
          progress: 0,
          message: `Failed to clear synced data: ${err.message}`,
        });
      } finally {
        this.resetsInFlight.delete(userId);
      }
    });

    return {
      success: true,
      message:
        'Clearing synced data in the background. Fresh WhatsApp data will stream in newest-first automatically.',
    };
  }

  private async seedHistoryCacheFromDb(userId: string, accountId: string) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const convs = await this.prisma.conversation.findMany({
      where: { userId, whatsappAccountId: accountId },
      select: { id: true, externalChatId: true, chatType: true, title: true, unreadCount: true, lastMessageAt: true },
    });
    const chatJidById = new Map(convs.map((c) => [c.id, c]));

    const chats = convs
      .filter((c) => c.lastMessageAt)
      .map((c) => ({
        id: c.externalChatId,
        name: c.chatType === 'GROUP' || c.chatType === 'CHANNEL' ? c.title || undefined : undefined,
        unreadCount: c.unreadCount,
        conversationTimestamp: Math.floor(c.lastMessageAt!.getTime() / 1000),
      }));

    const dbContacts = await this.prisma.contact.findMany({
      where: { userId, whatsappAccountId: accountId },
      select: {
        externalContactId: true,
        phoneNumber: true,
        lid: true,
        displayName: true,
        pushName: true,
        verifiedName: true,
        isSavedContact: true,
      },
    });
    const contacts = dbContacts.map((c) => {
      const isLidRow = c.externalContactId.endsWith('@lid');
      const digits = c.phoneNumber ? c.phoneNumber.replace(/\D/g, '') : '';
      return {
        id: c.externalContactId,
        lid: isLidRow ? c.externalContactId : c.lid || undefined,
        jid: digits ? `${digits}@s.whatsapp.net` : undefined,
        name: c.isSavedContact ? c.displayName : undefined,
        notify: c.pushName || undefined,
        verifiedName: c.verifiedName || undefined,
      };
    });

    const dbMessages = await this.prisma.message.findMany({
      where: { userId, whatsappAccountId: accountId, messageTimestamp: { gte: cutoff } },
      orderBy: { messageTimestamp: 'desc' },
      take: 30000,
      select: {
        externalMessageId: true,
        externalSenderId: true,
        isFromMe: true,
        textContent: true,
        messageTimestamp: true,
        conversationId: true,
        metadata: true,
      },
    });
    const messages = dbMessages.flatMap((m) => {
      const conv = chatJidById.get(m.conversationId);
      if (!conv || !m.textContent) return [];
      const isGroup = conv.chatType === 'GROUP';
      const senderName = (m.metadata as any)?.senderName;
      return [
        {
          key: {
            remoteJid: conv.externalChatId,
            id: m.externalMessageId,
            fromMe: m.isFromMe,
            participant:
              isGroup && m.externalSenderId && m.externalSenderId !== 'me' ? m.externalSenderId : undefined,
          },
          pushName: senderName && senderName !== 'You' ? senderName : undefined,
          messageTimestamp: Math.floor(m.messageTimestamp.getTime() / 1000),
          message: { conversation: m.textContent },
        },
      ];
    });

    this.baileysAdapter.seedHistoryCache(userId, { chats, contacts, messages });
    this.logger.log(
      `[RESET] Snapshot into history cache: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages`
    );
  }

  /**
   * Looks up the LID of every saved contact's phone number through WhatsApp, stores
   * each pair, and then stores chat titles. This is how a chat addressed by LID gets
   * its saved name without waiting for a new message.
   */
  async linkSavedContactsToLids(userId: string, accountId: string) {
    if (this.linkingNow.has(accountId)) {
      return { status: 'ALREADY_RUNNING' as const };
    }
    this.linkingNow.add(accountId);
    try {
      const contacts = await this.prisma.contact.findMany({
        where: { userId, whatsappAccountId: accountId, isSavedContact: true, isGroup: false, phoneNumber: { not: null } },
        select: { phoneNumber: true },
      });
      const phoneJids = [
        ...new Set(
          contacts
            .map((c) => (c.phoneNumber || '').replace(/\D/g, ''))
            .filter((d) => d.length >= 10)
            .map((d) => `${d}@s.whatsapp.net`)
        ),
      ];

      const BATCH = 20;
      let answered = 0;
      let linked = 0;
      const errors: string[] = [];
      for (let i = 0; i < phoneJids.length; i += BATCH) {
        const slice = phoneJids.slice(i, i + BATCH);
        let res = await this.baileysAdapter.lookupLidsForPhones(userId, slice);
        if (res.error) {
          await new Promise((r) => setTimeout(r, 3000));
          res = await this.baileysAdapter.lookupLidsForPhones(userId, slice);
        }
        if (res.error) errors.push(res.error);
        answered += res.answered;
        for (const p of res.pairs) {
          await this.prisma.lIDMapping
            .upsert({
              where: { whatsappAccountId_lid: { whatsappAccountId: accountId, lid: p.lid } },
              update: { phoneJid: p.phoneJid },
              create: { userId, whatsappAccountId: accountId, lid: p.lid, phoneJid: p.phoneJid },
            })
            .catch((err: any) => errors.push(`save ${p.lid}: ${err.message}`));
          linked++;
        }
        await new Promise((r) => setTimeout(r, 800));
      }

      await this.eventService.refreshChatTitles(userId, accountId);
      const report = {
        status: 'DONE' as const,
        savedContacts: phoneJids.length,
        whatsappAnswered: answered,
        linked,
        errors: [...new Set(errors)].slice(0, 5),
      };
      this.logger.log(`[LID_LINK] ${JSON.stringify(report)}`);
      return report;
    } finally {
      this.linkingNow.delete(accountId);
    }
  }

  async resyncData(userId: string) {
    const account = await this.getOrCreateAccount(userId);
    const accountId = account.id;

    this.logger.log(`[RESYNC] Initiating live WhatsApp reconciliation for account ${accountId} (user: ${userId})`);

    // Trigger live session resync and group participant backfill asynchronously in background
    const liveStatus = this.baileysAdapter.getConnectionState(account.userId);
    if (liveStatus === 'CONNECTED' || liveStatus === 'READY' || liveStatus === 'SYNCING') {
      Promise.resolve().then(async () => {
        // Every step has a time limit and the flow ALWAYS ends with a finished message, so the card can never
        // sit at "10%" forever when WhatsApp or the database stalls.
        let note = 'WhatsApp re-synchronization completed.';
        try {
          this.eventService.updateSyncProgress(userId, { status: 'SYNCING', currentStage: 'CONVERSATIONS', progress: 10, message: 'Asking WhatsApp for your groups and chats...' });
          await this.baileysAdapter.resyncSession(account.userId);
          this.eventService.updateSyncProgress(userId, { status: 'SYNCING', currentStage: 'CONVERSATIONS', progress: 60, message: 'Updating contacts and chats...' });
          await withTimeout(this.eventService.runSessionBackfill(userId, accountId), 15000, 'Updating contacts and chats').catch(() => {});
          this.aiQueueService.processUnprocessedMessagesOnAIEnable(userId, { maxAgeHours: 72, maxMessages: 100 }).catch(() => {});
        } catch (err: any) {
          this.logger.warn(`Background session resync error: ${err.message}`);
          note = `Re-sync finished with a problem (${err.message}). Your data is unchanged; try again in a minute.`;
        }
        try {
          const msgCount = await this.prisma.message.count({ where: { userId, whatsappAccountId: accountId } });
          this.eventService.updateSyncProgress(userId, {
            status: 'COMPLETED',
            currentStage: 'COMPLETED',
            progress: 100,
            message: note,
            messages: { total: msgCount, processed: msgCount, percentage: 100 },
            canContinueToApp: true,
            completedAt: new Date(),
          });
        } catch (err: any) {
          this.logger.warn(`Could not report re-sync result: ${err.message}`);
        }
      });
    }

    const status = await this.getStatus(userId);

    if (!(liveStatus === 'CONNECTED' || liveStatus === 'READY' || liveStatus === 'SYNCING')) {
      // Nothing to re-sync: there is no live WhatsApp connection on the server. Say so instead of showing progress.
      this.eventService.updateSyncProgress(userId, {
        status: 'COMPLETED',
        currentStage: 'COMPLETED',
        progress: 100,
        message: 'WhatsApp is not connected on the server right now. Open Settings and link WhatsApp again.',
        canContinueToApp: true,
        completedAt: new Date(),
      });
    }

    if (liveStatus === 'CONNECTED' || liveStatus === 'READY' || liveStatus === 'SYNCING') {
      this.eventsGateway.sendToUser(userId, 'whatsapp.sync', {
        stage: 'syncing',
        progress: 10,
        message: 'Re-synchronization started. WhatsApp data is syncing in the background.',
        stats: status.stats,
      });
    }

    return {
      success: true,
      message: 'Re-synchronization started successfully. WhatsApp contacts, groups, and messages are updating in the background.',
      status,
    };
  }

  async syncAccount(userId: string) {
    return this.resyncData(userId);
  }

  async fetchChatHistory(userId: string, externalChatId: string, count: number = 50) {
    const account = await this.getOrCreateAccount(userId);
    return this.baileysAdapter.fetchChatHistory(account.userId, externalChatId, count);
  }
}
