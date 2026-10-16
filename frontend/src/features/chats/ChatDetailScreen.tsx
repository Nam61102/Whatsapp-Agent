import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  Image,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { socketService } from '../../shared/services/socket';
import { Message } from '../../shared/types';
import { resolveContactIdentity, resolveDisplayName, isHumanName } from '../../shared/utils/nameResolver';
import { IconText } from '../../shared/components/IconText';
import { Sticker } from '../../shared/components/Sticker';

export const ChatDetailScreen = ({ route, navigation }: any) => {
  const { chatId, contactName, contactId, conversation: routeConv, initialText, avatarUrl, highlightMessageId, fromItem } = route.params || {};
  const [conversation, setConversation] = useState<any>(routeConv || null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState(initialText || '');
  // The Action Center card this chat was opened from. It is closed once a reply is sent.
  const pendingCardRef = React.useRef<{ id: string; category?: string } | null>(fromItem || null);
  useEffect(() => {
    pendingCardRef.current = fromItem || null;
  }, [fromItem?.id]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    if (initialText) {
      setInputText(initialText);
    }
  }, [initialText]);

  useEffect(() => {
    if (chatId) {
      apiClient.get(`/chats/${chatId}`).then((res: any) => {
        if (res) setConversation(res);
      }).catch(() => {});

      apiClient.post(`/chats/${chatId}/read`).catch(() => {});
    }
  }, [chatId]);

  const messagePushName = React.useMemo(() => {
    if (!messages || !messages.length) return null;
    for (const m of messages) {
      if (!m.isFromMe) {
        const candidate = (m as any).metadata?.senderName || (m as any).senderContact?.pushName || (m as any).senderContact?.displayName;
        if (candidate && isHumanName(candidate)) {
          return candidate.trim();
        }
      }
    }
    return null;
  }, [messages]);

  const canonicalIdentity = resolveContactIdentity(conversation || routeConv, messagePushName || contactName);
  const storedChatTitle = (conversation?.title || '').trim();
  const isGroupChat = conversation?.chatType === 'GROUP' || conversation?.chatType === 'CHANNEL';
  const resolvedHeaderName = storedChatTitle || (isGroupChat ? canonicalIdentity.displayName : 'Unknown');
  const headerAvatarUrl = avatarUrl || conversation?.avatarUrl || conversation?.contact?.profilePhotoUrl;

  const fetchMessages = useCallback(async () => {
    try {
      const response: any = await apiClient.get(`/chats/${chatId}/messages?limit=50`);
      // Server returns newest first; show oldest at top and newest at bottom, like WhatsApp.
      setMessages([...(response.messages || [])].reverse());
      setHasMore(Boolean(response.hasMore));
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const loadOlderMessages = async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const oldestId = messages[0]?.id;
      const response: any = await apiClient.get(
        `/chats/${chatId}/messages?limit=50&before=${oldestId}`
      );
      if (response.messages && response.messages.length > 0) {
        setMessages((prev) => [...[...response.messages].reverse(), ...prev]);
        setHasMore(Boolean(response.hasMore));
      } else {
        setHasMore(false);
      }
    } catch (err) {
      console.error('Failed to load older messages:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Opening a chat only shows a reply that was already prepared (free). The AI is asked for a new
  // one only when the user taps Refresh.
  const fetchSuggestions = useCallback(async (generate: boolean = false) => {
    setSuggestionsLoading(true);
    try {
      const res: any = generate
        ? await apiClient.post(`/ai/chats/${chatId}/reply-suggestions`)
        : await apiClient.get(`/ai/chats/${chatId}/reply-suggestions`);
      setSuggestions((res.suggestions || []).map((x: any) => ({ ...x, text: x.text ?? x.suggestion })));
    } catch (err) {
      console.warn('AI suggestions not ready:', err);
    } finally {
      setSuggestionsLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    fetchMessages();
    fetchSuggestions();

    const handleIncomingMessage = (data: any) => {
      if (data && data.chatId === chatId && data.message) {
        setMessages((prev) => {
          if (
            prev.some(
              (m) =>
                m.id === data.message.id ||
                m.whatsappMessageId === data.message.whatsappMessageId ||
                (m.id.startsWith('temp_') && m.textContent === data.message.textContent)
            )
          ) {
            return prev.map((m) =>
              m.id.startsWith('temp_') && m.textContent === data.message.textContent
                ? data.message
                : m
            );
          }
          return [...prev, data.message];
        });
        if (!data.message.isFromMe) {
          fetchSuggestions();
        }
      }
    };

    const handlePresenceUpdate = (data: any) => {
      if (data && (data.chatId === chatId || data.remoteJid === conversation?.externalChatId)) {
        setIsTyping(Boolean(data.isTyping));
      }
    };

    const unsubNew = socketService.on('message.new', handleIncomingMessage);
    const unsubMsgNew = socketService.on('message:new', handleIncomingMessage);
    const unsubChatNew = socketService.on('chat.message.new', handleIncomingMessage);
    const unsubPresence = socketService.on('presence:update', handlePresenceUpdate);

    const unsubStatus = socketService.on('message.status', (data: any) => {
      if (data && data.chatId === chatId) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId
              ? { ...m, status: data.status, currentStatus: data.status }
              : m
          )
        );
      }
    });

    const unsubDelivered = socketService.on('message.delivered', (data: any) => {
      if (data && data.chatId === chatId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === data.messageId ? { ...m, status: 'DELIVERED' } : m))
        );
      }
    });

    const unsubRead = socketService.on('message.read', (data: any) => {
      if (data && data.chatId === chatId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === data.messageId ? { ...m, status: 'READ' } : m))
        );
      }
    });

    return () => {
      unsubNew();
      unsubMsgNew();
      unsubChatNew();
      unsubPresence();
      unsubStatus();
      unsubDelivered();
      unsubRead();
    };
  }, [chatId, fetchMessages, fetchSuggestions, conversation?.externalChatId]);

  const handleSend = async (textToSend?: string) => {
    const text = (textToSend || inputText).trim();
    if (!text) return;

    const tempId = `temp_${Date.now()}`;
    const optimisticMessage: Message = {
      id: tempId,
      whatsappAccountId: '',
      conversationId: chatId,
      whatsappMessageId: tempId,
      senderType: 'ME',
      messageType: 'TEXT',
      textContent: text,
      isFromMe: true,
      status: 'SENDING',
      messageTimestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);
    setInputText('');
    setSending(true);

    try {
      const card = pendingCardRef.current;
      const res: any = await apiClient.post(`/chats/${chatId}/messages`, {
        text,
        ...(card ? { actionItemId: card.id, actionCategory: card.category } : {}),
      });
      if (card) pendingCardRef.current = null; // closed on the server; later messages do not touch it
      setMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...res, status: 'SENT' } : m))
      );
    } catch (err) {
      console.error('Send message failed:', err);
    } finally {
      setSending(false);
    }
  };

  const renderStatusTicks = (status?: string) => {
    switch (status) {
      case 'SENDING':
        return <Text style={styles.tickText}>⏳</Text>;
      case 'SENT':
        return <Text style={styles.tickText}>✓</Text>;
      case 'DELIVERED':
        return <Text style={styles.tickText}>✓✓</Text>;
      case 'READ':
        return <Text style={[styles.tickText, styles.blueTick]}>✓✓</Text>;
      default:
        return <Text style={styles.tickText}>✓</Text>;
    }
  };

  const renderMessageItem = ({ item }: { item: any }) => {
    const isMe = item.isFromMe;
    const time = new Date(item.messageTimestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const rawSender = item.metadata?.senderName || item.senderContact?.displayName;
    const isGroup = item.metadata?.isGroup;
    const senderName = resolveDisplayName(item.senderContact, rawSender, false);

    const isHighlighted = highlightMessageId && item.id === highlightMessageId;

    return (
      <View
        style={[
          styles.messageRow,
          isMe ? styles.messageRowMe : styles.messageRowOther,
        ]}
      >
        <View
          style={[
            styles.bubble,
            isMe ? styles.bubbleMe : styles.bubbleOther,
            isHighlighted && { borderWidth: 2, borderColor: '#F59E0B', backgroundColor: isMe ? '#FEF3C7' : '#FFFBEB' },
          ]}
        >
          {!isMe && isGroup && senderName && (
            <Text style={styles.senderNameHeader}>{senderName}</Text>
          )}
          <Text style={styles.messageText}>{item.textContent}</Text>
          <View style={styles.metaRow}>
            <Text style={styles.messageTime}>{time}</Text>
            {isMe && (
              <View style={styles.tickWrapper}>
                {renderStatusTicks(item.currentStatus || item.status)}
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerProfile}
          onPress={() => {
            if (contactId) {
              navigation.navigate('ContactsTab', {
                screen: 'ContactProfile',
                params: { contactId, contactName: resolvedHeaderName },
              });
            }
          }}
        >
          <View style={styles.headerAvatar}>
            {headerAvatarUrl ? (
              <Image source={{ uri: headerAvatarUrl }} style={styles.headerAvatarImage} />
            ) : (
              <Text style={styles.headerAvatarText}>
                {(resolvedHeaderName || 'C').charAt(0).toUpperCase()}
              </Text>
            )}
          </View>
          <View>
            <Text style={styles.headerName}>{resolvedHeaderName || 'Chat'}</Text>
            <Text style={[styles.headerSub, isTyping && styles.typingSub]}>
              {isTyping ? 'typing...' : 'WhatsApp Conversation'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Message List */}
      <KeyboardAvoidingView
        style={styles.chatArea}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {loading ? (
          <View style={styles.centerLoading}>
            <ActivityIndicator size="large" color={Colors.primary} />
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessageItem}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
            onLayout={() => flatListRef.current?.scrollToEnd({ animated: false })}
            ListHeaderComponent={
              hasMore ? (
                <TouchableOpacity
                  style={styles.loadMoreButton}
                  onPress={loadOlderMessages}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : (
                    <Text style={styles.loadMoreText}>Load Earlier Messages</Text>
                  )}
                </TouchableOpacity>
              ) : null
            }
          />
        )}

        {/* Nothing prepared for this chat: let the user ask for a reply on purpose */}
        {suggestions.length === 0 && messages.length > 0 && !messages[messages.length - 1]?.isFromMe && (
          <TouchableOpacity
            style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 6 }}
            onPress={() => fetchSuggestions(true)}
            disabled={suggestionsLoading}
          >
            <Text style={styles.refreshSugText}>{suggestionsLoading ? 'Thinking...' : '✨ Suggest a reply'}</Text>
          </TouchableOpacity>
        )}

        {/* AI Reply Suggestions Drawer */}
        {suggestions.length > 0 && (
          <View style={styles.suggestionsContainer}>
            <View style={styles.suggestionsHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Sticker name="brain" size={24} style={{ marginRight: 6 }} />
                <Text style={styles.suggestionsTitle}>AI Suggested Replies</Text>
              </View>
              <TouchableOpacity onPress={() => fetchSuggestions(true)} disabled={suggestionsLoading}>
                <Text style={styles.refreshSugText}>
                  {suggestionsLoading ? 'Thinking...' : 'Refresh ↻'}
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.suggestionsScroll}>
              {suggestions.map((sug, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.suggestionPill}
                  onPress={() => setInputText(sug.suggestion || sug.text)}
                >
                  <Text style={styles.sugTone}>{sug.tone || 'Friendly'}</Text>
                  <Text style={styles.sugBody} numberOfLines={2}>
                    {sug.suggestion || sug.text}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Input Bar */}
        <View style={styles.inputBar}>
          <TextInput
            style={styles.textInput}
            placeholder="Type a message..."
            placeholderTextColor={Colors.textMuted}
            value={inputText}
            onChangeText={setInputText}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
            onPress={() => handleSend()}
            disabled={!inputText.trim() || sending}
          >
            <Text style={styles.sendIcon}>➤</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ECE5DD',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: Colors.primary,
  },
  backButton: {
    paddingRight: 10,
    paddingLeft: 4,
  },
  backButtonText: {
    fontSize: 32,
    color: '#FFF',
    fontWeight: '300',
  },
  headerProfile: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#22C55E',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    overflow: 'hidden',
  },
  headerAvatarImage: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  headerAvatarText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  headerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFF',
  },
  headerSub: {
    fontSize: 11,
    color: '#DCFCE7',
  },
  typingSub: {
    color: '#86EFAC',
    fontWeight: '700',
    fontStyle: 'italic',
  },
  chatArea: {
    flex: 1,
  },
  centerLoading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  messageList: {
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  loadMoreButton: {
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  loadMoreText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.primary,
  },
  messageRow: {
    marginVertical: 4,
    flexDirection: 'row',
  },
  messageRowMe: {
    justifyContent: 'flex-end',
  },
  messageRowOther: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  bubbleMe: {
    backgroundColor: Colors.outgoingBubble,
    borderTopRightRadius: 2,
  },
  bubbleOther: {
    backgroundColor: Colors.incomingBubble,
    borderTopLeftRadius: 2,
  },
  senderNameHeader: {
    fontSize: 12,
    fontWeight: '700',
    color: '#D97706',
    marginBottom: 3,
  },
  messageText: {
    fontSize: 15,
    color: Colors.text,
    lineHeight: 20,
  },
  metaRow: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
  },
  messageTime: {
    fontSize: 11,
    color: Colors.textMuted,
    marginRight: 4,
  },
  tickWrapper: {
    marginLeft: 2,
  },
  tickText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  blueTick: {
    color: '#34B7F1',
  },
  suggestionsContainer: {
    backgroundColor: '#F8FAFC',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  suggestionsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  suggestionsTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.secondary,
  },
  refreshSugText: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  suggestionsScroll: {
    flexDirection: 'row',
  },
  suggestionPill: {
    backgroundColor: '#FFF',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    maxWidth: 220,
  },
  sugTone: {
    fontSize: 10,
    fontWeight: '700',
    color: Colors.secondary,
    textTransform: 'uppercase',
  },
  sugBody: {
    fontSize: 13,
    color: Colors.text,
    marginTop: 2,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#F3F6F8',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#FFF',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 100,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendButtonDisabled: {
    backgroundColor: '#A0AEC0',
  },
  sendIcon: {
    color: '#FFF',
    fontSize: 16,
    marginLeft: 2,
  },
});
