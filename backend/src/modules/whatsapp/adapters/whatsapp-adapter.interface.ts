export type ConnectionState =
  | 'DISCONNECTED'
  | 'INITIALIZING'
  | 'QR_PENDING'
  | 'PAIRING_CODE_PENDING'
  | 'AUTHENTICATING'
  | 'CONNECTED'
  | 'SYNCING'
  | 'READY'
  | 'DISCONNECTING'
  | 'FAILED'
  | 'EXPIRED';

export interface WhatsAppAdapterEvents {
  'connection.update': (data: {
    userId: string;
    status: ConnectionState;
    qrCode?: string;
    pairingCode?: string;
    phoneNumber?: string;
    displayName?: string;
    lastError?: string;
  }) => void;
  'message.received': (data: {
    userId: string;
    externalMessageId: string;
    remoteJid: string;
    senderJid?: string;
    pushName?: string;
    textContent?: string;
    isFromMe: boolean;
    timestamp: Date;
    rawMessage: any;
  }) => void;
  'message.status': (data: {
    userId: string;
    externalMessageId: string;
    remoteJid: string;
    status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
    timestamp: Date;
  }) => void;
  'contacts.upsert': (data: {
    userId: string;
    contacts: Array<{
      id: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
    }>;
  }) => void;
  'chats.upsert': (data: {
    userId: string;
    chats: Array<{
      id: string;
      name?: string;
      unreadCount?: number;
      conversationTimestamp?: number;
    }>;
  }) => void;
  'groups.upsert': (data: {
    userId: string;
    groups: Array<{
      id: string;
      subject: string;
      owner?: string;
      creation?: number;
      desc?: string;
      participantsCount?: number;
    }>;
  }) => void;
  'groups.update': (data: {
    userId: string;
    groupId: string;
    subject?: string;
    desc?: string;
  }) => void;
  'sync.progress': (data: {
    userId: string;
    stage: 'contacts' | 'chats' | 'messages' | 'ai' | 'completed';
    progress: number;
    message: string;
  }) => void;
  'messaging-history.set': (data: {
    userId: string;
    chats?: any[];
    contacts?: any[];
    messages?: any[];
    isLatest?: boolean;
    progress?: number;
    syncType?: any;
  }) => void;
  'message-receipt.update': (data: {
    userId: string;
    receipts: Array<{
      externalMessageId: string;
      remoteJid: string;
      receiptType: 'read' | 'read-self' | 'played' | 'delivered';
      timestamp: Date;
    }>;
  }) => void;
  'group-participants.update': (data: {
    userId: string;
    groupId: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
  }) => void;
  'lid-mapping.update': (data: {
    userId: string;
    lid: string;
    phoneJid: string;
  }) => void;
  'messages.delete': (data: {
    userId: string;
    messageIds: string[];
    remoteJid?: string;
  }) => void;
  'chats.delete': (data: {
    userId: string;
    chatIds: string[];
  }) => void;
  'presence.update': (data: {
    userId: string;
    remoteJid: string;
    presence: string;
    isTyping: boolean;
  }) => void;
}

export interface IWhatsAppAdapter {
  initialize(userId: string): Promise<void>;
  initializeRegisteredSessions(shouldRestore?: (userId: string) => Promise<boolean>): Promise<void>;
  connect(userId: string, method?: 'QR' | 'PAIRING_CODE', forceFresh?: boolean): Promise<{ status: ConnectionState; qrCode?: string }>;
  requestPairingCode(userId: string, phoneNumber: string): Promise<string>;
  sendMessage(userId: string, remoteJid: string, text: string): Promise<void>;
  getGroupMetadata(userId: string, groupId: string): Promise<any>;
  getNewsletterMetadata(userId: string, jid: string): Promise<{ title?: string; description?: string; avatarUrl?: string } | null>;
  fetchGroups(userId: string): Promise<any[]>;
  disconnect(userId: string): Promise<void>;
  getConnectionState(userId: string): ConnectionState;
  getQRCode(userId: string): string | null;
  resyncSession(userId: string): Promise<{ groupsCount: number }>;
  fetchChatHistory(userId: string, externalChatId: string, count?: number): Promise<void>;
  on<K extends keyof WhatsAppAdapterEvents>(event: K, listener: WhatsAppAdapterEvents[K]): void;
  off<K extends keyof WhatsAppAdapterEvents>(event: K, listener: WhatsAppAdapterEvents[K]): void;
}
