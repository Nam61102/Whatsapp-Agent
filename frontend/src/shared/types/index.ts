export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  phone?: string | null;
  whatsappAccount?: WhatsAppAccount | null;
  createdAt?: string;
}

export interface WhatsAppAccount {
  id: string;
  userId?: string;
  phone?: string | null;
  name?: string | null;
  status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'SYNCING';
  qrCode?: string | null;
  pairingCode?: string | null;
  lastSyncAt?: string | null;
  stats?: {
    contacts: number;
    chats: number;
    messages: number;
  };
}

export interface Contact {
  id: string;
  whatsappAccountId: string;
  whatsappContactId?: string;
  phoneNumber?: string | null;
  displayName: string;
  pushName?: string | null;
  verifiedName?: string | null;
  isSavedContact?: boolean;
  lid?: string | null;
  profilePhotoUrl?: string | null;
  about?: string | null;
  isBusiness: boolean;
  isGroup?: boolean;
  lastSeenAt?: string | null;
  aiProfile?: ContactAIProfile | null;
  conversations?: { id: string; lastMessageText?: string; lastMessageAt?: string }[];
}

export interface Conversation {
  id: string;
  whatsappAccountId: string;
  contactId: string;
  externalChatId?: string;
  whatsappChatId?: string;
  whatsappChatJid?: string;
  chatType: string;
  title?: string | null;
  avatarUrl?: string | null;
  isGroup?: boolean;
  isPinned?: boolean;
  isMuted?: boolean;
  isArchived?: boolean;
  isSelfChat?: boolean;
  unreadCount: number;
  lastMessageText?: string | null;
  lastMessageAt?: string | null;
  lastMessageSenderId?: string | null;
  contact: {
    id: string;
    displayName: string;
    pushName?: string | null;
    verifiedName?: string | null;
    isSavedContact?: boolean;
    phoneNumber?: string | null;
    profilePhotoUrl?: string | null;
    about?: string | null;
    isBusiness: boolean;
    aiProfile?: ContactAIProfile | null;
  };
}

export interface Message {
  id: string;
  whatsappAccountId: string;
  conversationId: string;
  whatsappMessageId?: string;
  externalMessageId?: string;
  senderType: 'ME' | 'CONTACT';
  messageType: 'TEXT' | 'IMAGE' | 'AUDIO' | 'DOCUMENT';
  textContent: string;
  mediaUrl?: string | null;
  isFromMe: boolean;
  currentStatus?: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  status: 'SENDING' | 'SENT' | 'DELIVERED' | 'READ';
  messageTimestamp: string;
  senderContact?: {
    id: string;
    displayName: string;
    profilePhotoUrl?: string | null;
  };
  metadata?: any;
  aiReplySuggestions?: { id: string; suggestion: string; tone: string }[];
}

export interface AIExtraction {
  id: string;
  whatsappAccountId: string;
  conversationId?: string | null;
  contactId?: string | null;
  messageId?: string | null;
  extractionType: string;
  title: string;
  summary: string;
  extractedData?: any;
  importanceScore: number;
  confidenceScore: number;
  eventDate?: string | null;
  status: 'ACTIVE' | 'RESOLVED' | 'DISMISSED';
  aiModel?: string;
  createdAt: string;
  contact?: {
    id: string;
    displayName: string;
    phoneNumber?: string | null;
    profilePhotoUrl?: string | null;
  };
  message?: {
    id: string;
    textContent: string;
    messageTimestamp: string;
  };
}

export interface ContactAIProfile {
  id: string;
  contactId: string;
  summary: string;
  likes?: string[];
  dislikes?: string[];
  interests?: string[];
  communicationStyle?: {
    tone: string;
    language: string;
    emojiUsage: string;
    averageLength?: string;
  };
  frequentlyDiscussedTopics?: string[];
  importantEvents?: string[];
  confidence: number;
  sourceMessageCount: number;
  generatedAt: string;
}

export interface AIReplySuggestion {
  id: string;
  conversationId: string;
  messageId: string;
  suggestion: string;
  tone: string;
  confidence: number;
  contextSummary?: string;
  conversation?: {
    contact: { displayName: string; id: string };
  };
}

export interface UserSettings {
  id: string;
  userId: string;
  retentionDays: number;
  autoAIAnalysis: boolean;
  notificationsEnabled: boolean;
}
