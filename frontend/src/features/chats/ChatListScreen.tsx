import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Image,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { socketService } from '../../shared/services/socket';
import { Conversation } from '../../shared/types';
import { resolveDisplayName, onDeviceContactsUpdated, getDeviceContactsRevision } from '../../shared/utils/nameResolver';
import { SyncProgressBar } from '../../shared/components/SyncProgressBar';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../../shared/components/Avatar';
import { Illustration } from '../../shared/components/Illustration';
import { Sticker } from '../../shared/components/Sticker';

export const ChatListScreen = ({ navigation }: any) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [typingMap, setTypingMap] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deviceContactsRev, setDeviceContactsRev] = useState(getDeviceContactsRevision());

  useEffect(() => {
    return onDeviceContactsUpdated(() => {
      setDeviceContactsRev(getDeviceContactsRevision());
      // Backend has just received the phonebook — refetch so chat titles use it.
      fetchChats(search);
    });
  }, [search]);

  const [syncProgress, setSyncProgress] = useState<{
    stage: string;
    progress: number;
    message: string;
    status: string;
  } | null>(null);

  const maxProgressRef = useRef(0);
  const completedTimeoutRef = useRef<any>(null);

  const fetchChats = useCallback(async (searchQuery = '') => {
    try {
      const url = searchQuery
        ? `/chats?search=${encodeURIComponent(searchQuery)}`
        : '/chats';
      const response: any = await apiClient.get(url);
      const list: Conversation[] = response.conversations || [];
      list.sort(
        (a: any, b: any) =>
          new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
      );
      setConversations(list);
    } catch (err) {
      console.error('Failed to load chats:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleSyncProgress = useCallback((data: any) => {
    if (!data) return;
    const rawProgress = typeof data.progress === 'number' ? data.progress : 0;
    const stage = (data.currentStage || data.stage || 'SYNCING').toUpperCase();
    const status = data.status || (rawProgress >= 100 ? 'COMPLETED' : 'SYNCING');
    const message = data.message || `Synchronizing WhatsApp ${stage.toLowerCase()}...`;

    const nextProgress = Math.max(maxProgressRef.current, Math.min(100, Math.round(rawProgress)));
    maxProgressRef.current = nextProgress;

    if (status === 'COMPLETED' || nextProgress >= 100) {
      setSyncProgress({
        stage: 'COMPLETED',
        progress: 100,
        message: 'WhatsApp Synchronization Complete!',
        status: 'COMPLETED',
      });
      if (completedTimeoutRef.current) clearTimeout(completedTimeoutRef.current);
      completedTimeoutRef.current = setTimeout(() => {
        setSyncProgress(null);
        maxProgressRef.current = 0;
      }, 4000);
    } else {
      setSyncProgress({
        stage,
        progress: nextProgress,
        message,
        status,
      });
      // Safety auto-complete: If stuck at any percentage for more than 8s, auto-dismiss
      if (completedTimeoutRef.current) clearTimeout(completedTimeoutRef.current);
      completedTimeoutRef.current = setTimeout(() => {
        setSyncProgress({
          stage: 'COMPLETED',
          progress: 100,
          message: 'WhatsApp Synchronization Complete!',
          status: 'COMPLETED',
        });
        completedTimeoutRef.current = setTimeout(() => {
          setSyncProgress(null);
          maxProgressRef.current = 0;
        }, 2500);
      }, 8000);
    }
  }, [fetchChats, search]);

  const fetchTimeoutRef = React.useRef<any>(null);

  const debouncedFetchChats = useCallback((query = '') => {
    if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
    fetchTimeoutRef.current = setTimeout(() => {
      fetchChats(query);
    }, 2000);
  }, [fetchChats]);

  useEffect(() => {
    fetchChats(search);

    // The server announces each message under three event names; count it once.
    const seenMessageIds = new Set<string>();
    const handleNewMessage = (data: any) => {
      if (!data || !data.message) {
        debouncedFetchChats(search);
        return;
      }
      const { chatId, message } = data;
      const key = String(message.id || message.externalMessageId || `${chatId}:${message.messageTimestamp}`);
      if (seenMessageIds.has(key)) return;
      seenMessageIds.add(key);
      if (seenMessageIds.size > 500) seenMessageIds.delete(seenMessageIds.values().next().value as string);
      setConversations((prev) => {
        const existingIndex = prev.findIndex((c) => c.id === chatId || c.externalChatId === message.externalSenderId);
        const updatedText = message.textContent || '[Message]';
        const updatedTime = message.messageTimestamp || new Date().toISOString();

        if (existingIndex !== -1) {
          const existing = prev[existingIndex];
          const updatedConv = {
            ...existing,
            lastMessageText: updatedText,
            lastMessageAt: updatedTime,
            unreadCount: message.isFromMe ? 0 : (existing.unreadCount || 0) + 1,
          };
          const rest = prev.filter((_, idx) => idx !== existingIndex);
          return [updatedConv, ...rest];
        } else {
          // A chat we have not loaded yet: fetch now, no waiting.
          fetchChats(search);
          return prev;
        }
      });
    };

    const handlePresenceUpdate = (data: any) => {
      if (!data) return;
      const key = data.chatId || data.remoteJid;
      if (key) {
        setTypingMap((prev) => ({ ...prev, [key]: Boolean(data.isTyping) }));
      }
    };

    let throttleTimer: any = null;
    const refetchThrottled = () => {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        fetchChats(search);
      }, 800);
    };

    // Live updates carry raw database rows, which have not been through the saved-name
    // lookup. Only take activity fields from them and refetch so names stay resolved.
    const handleConvUpdated = (data: any) => {
      const updated = data?.conversation;
      if (updated?.id) {
        setConversations((prev) => {
          const index = prev.findIndex((c) => c.id === updated.id);
          if (index === -1) return prev;
          const copy = [...prev];
          copy[index] = {
            ...copy[index],
            lastMessageText: updated.lastMessageText ?? copy[index].lastMessageText,
            lastMessageAt: updated.lastMessageAt ?? copy[index].lastMessageAt,
            unreadCount: updated.unreadCount ?? copy[index].unreadCount,
            isPinned: updated.isPinned ?? copy[index].isPinned,
            isMuted: updated.isMuted ?? copy[index].isMuted,
          };
          return copy;
        });
      }
      refetchThrottled();
    };

    const handleChatsUpdated = () => refetchThrottled();

    const unsubEvents = [
      socketService.on('chats:updated', handleChatsUpdated),
      socketService.on('message:new', handleNewMessage),
      socketService.on('message.new', handleNewMessage),
      socketService.on('chat.message.new', handleNewMessage),
      socketService.on('conversation:updated', handleConvUpdated),
      socketService.on('presence:update', handlePresenceUpdate),
      socketService.on('sync:progress', handleSyncProgress),
      socketService.on('whatsapp.sync', handleSyncProgress),
      socketService.on('whatsapp:data_reset', () => {
        setSyncProgress(null);
        maxProgressRef.current = 0;
        debouncedFetchChats(search);
      }),
    ];

    return () => {
      if (throttleTimer) clearTimeout(throttleTimer);
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
      unsubEvents.forEach((u) => {
        if (typeof u === 'function') u();
      });
      if (completedTimeoutRef.current) clearTimeout(completedTimeoutRef.current);
    };
  }, [fetchChats, handleSyncProgress, search, debouncedFetchChats]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchChats(search);
  };

  const formatTime = (dateString?: string | null) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';
    const now = new Date();

    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    }

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      date.getDate() === yesterday.getDate() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getFullYear() === yesterday.getFullYear();

    if (isYesterday) {
      return 'Yesterday';
    }

    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    }

    return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  const renderChatItem = ({ item }: { item: any }) => {
    const isGroup = item.chatType === 'GROUP' || item.isGroup || item.externalChatId?.endsWith('@g.us');
    const isChannel = item.chatType === 'CHANNEL' || item.externalChatId?.endsWith('@newsletter');
    const isSelf = item.chatType === 'SELF' || Boolean(item.isSelfChat);
    const storedTitle = typeof item.title === 'string' ? item.title.trim() : '';
    const resolvedTitle = storedTitle || resolveDisplayName(item.contact || item, item.title, isGroup) || 'WhatsApp Chat';
    const title = isSelf && !resolvedTitle.includes('(You)') ? `${resolvedTitle} (You)` : resolvedTitle;
    const isTyping = Boolean(typingMap[item.id] || typingMap[item.externalChatId]);
    const photoUrl = item.avatarUrl || item.contact?.profilePhotoUrl;

    return (
      <TouchableOpacity
        style={styles.chatRow}
        activeOpacity={0.7}
        onPress={() =>
          navigation.navigate('ChatDetail', {
            chatId: item.id,
            contactName: title,
            contactPhone: item.contact?.phoneNumber,
            contactId: item.contact?.id,
            avatarUrl: photoUrl,
          })
        }
      >
        <Avatar name={title} uri={photoUrl} size={50} group={isGroup || isChannel} style={{ marginRight: 12 }} />

        <View style={styles.contentCol}>
          <View style={styles.topRow}>
            <View style={styles.nameContainer}>
              {item.isPinned && <Ionicons name="pin" size={13} color="#64748B" style={{ marginRight: 4 }} />}
              <Text style={styles.displayName} numberOfLines={1}>
                {title}
              </Text>
              {isSelf ? (
                <Text style={styles.selfBadge}>YOU</Text>
              ) : isGroup ? (
                <Text style={styles.groupBadge}>GROUP</Text>
              ) : isChannel ? (
                <Text style={styles.channelBadge}>CHANNEL</Text>
              ) : null}
              {item.isMuted && <Ionicons name="notifications-off" size={13} color="#94A3B8" style={{ marginLeft: 4 }} />}
            </View>
            <Text style={styles.timeText}>{formatTime(item.lastMessageAt)}</Text>
          </View>

          <View style={styles.bottomRow}>
            {isTyping ? (
              <Text style={styles.typingText} numberOfLines={1}>
                typing...
              </Text>
            ) : (
              <Text
                style={[
                  styles.lastMsgText,
                  (!item.lastMessageText ||
                    item.lastMessageText === '[Chat initialized]' ||
                    item.lastMessageText === '…') &&
                    styles.emptyMsgText,
                ]}
                numberOfLines={1}
              >
                {item.lastMessageText === '…'
                  ? 'Loading messages…'
                  : item.lastMessageText && item.lastMessageText !== '[Chat initialized]'
                  ? item.lastMessageText
                  : 'No messages yet'}
              </Text>
            )}
            {item.unreadCount > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadCountText}>{item.unreadCount}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {syncProgress && (
        <View style={{ paddingHorizontal: 12, paddingTop: 4 }}>
          <SyncProgressBar
            progress={syncProgress.progress}
            stage={syncProgress.stage}
            message={syncProgress.message}
            status={syncProgress.status}
          />
        </View>
      )}

      {/* Smart Assistant Tip Strip */}
      <View style={styles.assistantStrip}>
        <Sticker name="robot" size={36} style={{ marginRight: 10 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.assistantStripTitle}>Gemini AI Chat Assistant</Text>
          <Text style={styles.assistantStripSubtitle}>
            Live analysis active • Tap any conversation for AI suggestions
          </Text>
        </View>
      </View>

      <View style={styles.searchBarContainer}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={18} color={Colors.textMuted} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search chats, contacts, or messages..."
            placeholderTextColor={Colors.textLight}
            value={search}
            onChangeText={(text) => {
              setSearch(text);
              fetchChats(text);
            }}
          />
          {search ? (
            <TouchableOpacity onPress={() => { setSearch(''); fetchChats(''); }}>
              <Ionicons name="close-circle" size={18} color={Colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          renderItem={renderChatItem}
          extraData={deviceContactsRev}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Illustration name="chat" size={170} />
              <Text style={styles.emptyText}>No conversations found</Text>
              <Text style={styles.emptySub}>
                Connect WhatsApp to synchronize your active chats.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  assistantStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5F2',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#CCEBE5',
  },
  assistantStripTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.primary,
  },
  assistantStripSubtitle: {
    fontSize: 11,
    color: '#0D685C',
    marginTop: 1,
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  searchInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F6F8',
    borderRadius: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  searchInput: {
    flex: 1,
    paddingVertical: 9,
    fontSize: 14,
    color: Colors.text,
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F6F8',
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    overflow: 'hidden',
  },
  avatarImage: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  typingText: {
    fontSize: 14,
    color: '#22C55E',
    fontWeight: '600',
    fontStyle: 'italic',
    flex: 1,
  },
  groupAvatar: {
    backgroundColor: '#0F8F7E',
  },
  avatarText: {
    color: '#FFF',
    fontSize: 20,
    fontWeight: '700',
  },
  contentCol: {
    flex: 1,
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  nameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  displayName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
    flexShrink: 1,
  },
  groupBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: '#0F8F7E',
    backgroundColor: '#CCFBF1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 6,
  },
  channelBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: '#7C3AED',
    backgroundColor: '#EDE9FE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 6,
  },
  emptyMsgText: {
    color: Colors.textMuted,
    fontStyle: 'italic',
  },
  timeText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  lastMsgText: {
    fontSize: 14,
    color: Colors.textSecondary,
    flex: 1,
    marginRight: 8,
  },
  unreadBadge: {
    backgroundColor: Colors.unreadBadge,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadCountText: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  emptySub: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
  },
  pinIcon: {
    fontSize: 12,
  },
  muteIcon: {
    fontSize: 12,
  },
  selfBadge: {
    backgroundColor: '#007AFF',
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    marginLeft: 6,
    overflow: 'hidden',
  },
  syncBanner: {
    backgroundColor: '#075E54',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  syncBannerTextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  syncBannerText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  syncPercentText: {
    color: '#22C55E',
    fontSize: 13,
    fontWeight: '800',
  },
  progressBarTrack: {
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#22C55E',
    borderRadius: 2,
  },
});
