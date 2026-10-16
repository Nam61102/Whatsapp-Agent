// Refined, high-polish palette for WhatsApp AI Assistant
// Brand: WhatsApp deep emerald teal + fresh mint accent + ultra-clean surfaces & vibrant cartoon stickers.
export const Colors = {
  // Brand
  primary: '#075E54', // Rich WhatsApp Forest Teal
  primaryDark: '#05463E',
  primaryLight: '#E8F5F2', // Crisp mint tint
  secondary: '#128C7E', // WhatsApp Classic Medium Teal
  accent: '#25D366', // WhatsApp Signature Vibrant Green
  accentDark: '#1EBE5D',
  accentLight: '#DCFCE7',

  // Surfaces
  background: '#F4F7F6', // Soft, clean off-white canvas
  cardBackground: '#FFFFFF',
  surfaceMuted: '#F8FAFC',
  surfaceHover: '#F1F5F9',

  // Text
  text: '#0F172A', // Deep slate obsidian
  textSecondary: '#334155', // Charcoal slate
  textMuted: '#64748B', // Cool grey
  textLight: '#94A3B8',

  // Lines & Borders
  border: '#E2E8F0',
  divider: '#E2E8F0',
  borderLight: '#EDF2F7',

  // Chat Bubbles
  outgoingBubble: '#E7FBD3', // WhatsApp pleasant mint-green bubble
  incomingBubble: '#FFFFFF', // Crisp card surface
  unreadBadge: '#25D366',
  unreadText: '#FFFFFF',

  // Semantic
  danger: '#EF4444',
  dangerLight: '#FEE2E2',
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  success: '#10B981',
  successLight: '#DCFCE7',
  info: '#3B82F6',
  infoLight: '#DBEAFE',

  // Extraction Categories with Sticker mappings
  categories: {
    BIRTHDAY: { bg: '#FCE7F3', border: '#FBCFE8', text: '#BE185D', icon: '🎂', sticker: 'birthday' as const },
    BIRTHDAY_WISH: { bg: '#FCE7F3', border: '#FBCFE8', text: '#BE185D', icon: '🎉', sticker: 'birthday' as const },
    MEETING: { bg: '#E0F2FE', border: '#BAE6FD', text: '#0369A1', icon: '📅', sticker: 'calendar' as const },
    APPOINTMENT: { bg: '#CCFBF1', border: '#99F6E4', text: '#0F766E', icon: '🩺', sticker: 'calendar' as const },
    TASK: { bg: '#FFEDD5', border: '#FED7AA', text: '#C2410C', icon: '✅', sticker: 'calendar' as const },
    PAYMENT: { bg: '#DCFCE7', border: '#BBF7D0', text: '#15803D', icon: '💰', sticker: 'wallet' as const },
    TRAVEL: { bg: '#F3E8FF', border: '#E9D5FF', text: '#7E22CE', icon: '✈️', sticker: 'travel' as const },
    IMPORTANT_EVENT: { bg: '#EDE9FE', border: '#DDD6FE', text: '#6D28D9', icon: '⭐', sticker: 'brain' as const },
    NORMAL_CHAT: { bg: '#F1F5F9', border: '#E2E8F0', text: '#475569', icon: '💬', sticker: 'chat' as const },
  },
};
