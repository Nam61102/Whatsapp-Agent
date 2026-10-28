import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Modal,
  Platform,
  Alert,
  AppState,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { AuthStorage } from '../../shared/services/authStorage';
import { socketService } from '../../shared/services/socket';
import { resolveDisplayName } from '../../shared/utils/nameResolver';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SyncProgressBar } from '../../shared/components/SyncProgressBar';
import { consumeFirstSync } from '../../shared/utils/firstSync';
import { IconText } from '../../shared/components/IconText';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../../shared/components/Avatar';
import { Illustration } from '../../shared/components/Illustration';
import { Sticker } from '../../shared/components/Sticker';
import { formatDueDate } from '../../shared/utils/dates';
import { BadgeLabel } from '../../shared/components/BadgeLabel';
import { MorningBriefingCard } from './components/MorningBriefingCard';
import { openGoogleCalendar } from '../../shared/utils/calendarSync';
import { useFocusEffect } from '@react-navigation/native';

const formatCountdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const DashboardScreen = ({ navigation }: any) => {
  const [user, setUser] = useState<any>(AuthStorage.getUser());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [whatsappStatus, setWhatsappStatus] = useState<string>('DISCONNECTED');
  const [waStats, setWaStats] = useState<any>(null);
  const [syncProgress, setSyncProgress] = useState<any>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dashboardData, setDashboardData] = useState<any>({
    importantToday: { birthdays: [], meetings: [], tasks: [], payments: [], travel: [] },
    aiSuggestions: [],
    recentInsights: [],
  });
  const [recentChats, setRecentChats] = useState<any[]>([]);
  const [briefingRefreshCount, setBriefingRefreshCount] = useState(0);

  // Countdown of the first sync after linking WhatsApp. It runs once; null when there is none.
  const [clock, setClock] = useState(Date.now());
  const [firstSyncEnd, setFirstSyncEnd] = useState<number | null>(null);
  const syncingRef = React.useRef(false);




    // Load cached dashboard data on launch so UI displays instantly without a flash of empty state
  useEffect(() => {
    (async () => {
      try {
        const cachedDash = await AsyncStorage.getItem('cached_dashboard_data');
        if (cachedDash) {
          const parsed = JSON.parse(cachedDash);
          if (parsed && typeof parsed === 'object') setDashboardData(parsed);
        }
        const cachedChats = await AsyncStorage.getItem('cached_recent_chats');
        if (cachedChats) {
          const parsedChats = JSON.parse(cachedChats);
          if (Array.isArray(parsedChats)) setRecentChats(parsedChats);
        }
      } catch {}
    })();
  }, []);

  // Only the newest request may write state; a slow older response cannot replace newer data.
  const dashboardSeq = React.useRef(0);

  const fetchDashboard = useCallback(async () => {
    setBriefingRefreshCount((c) => c + 1);
    const seq = ++dashboardSeq.current;
    try {
      // Each part fills in as soon as ITS request answers; the screen never waits for the slowest one.
      // A failed request leaves what is already shown untouched.
      const live = () => seq === dashboardSeq.current;
      const part = (p: Promise<any>, apply: (r: any) => void) =>
        p
          .then((r) => {
            if (live() && r) apply(r);
          })
          .catch(() => {})
          .finally(() => {
            if (live()) setLoading(false);
          });
      await Promise.all([
        part(apiClient.get('/ai/dashboard'), (r) => {
          if (typeof r === 'object' && ('actionCenterItems' in r || r.aiEnabled === false)) {
            setDashboardData(r);
            AsyncStorage.setItem('cached_dashboard_data', JSON.stringify(r)).catch(() => {});
          }
        }),
        part(apiClient.get('/chats?limit=5'), (r) => {
          if (r.conversations) {
            setRecentChats(r.conversations);
            AsyncStorage.setItem('cached_recent_chats', JSON.stringify(r.conversations)).catch(() => {});
          }
        }),
        part(apiClient.get('/whatsapp/status'), (r) => {
          if (r.status) setWhatsappStatus(r.status);
          if (r.stats) setWaStats(r.stats);
        }),
        part(apiClient.get('/whatsapp/sync-progress'), (r) => setSyncProgress(r)),
        part(apiClient.get('/auth/me'), (r) => {
          setUser(r);
          AuthStorage.setUser(r);
        }),
      ]);

    } catch (err) {
      console.error('Error fetching dashboard data:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Manual re-sync only (button in the sync card or in Settings). Nothing re-syncs on a timer.
  const doResync = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      await apiClient.post('/whatsapp/resync', {}, { timeout: 120000 });
      await fetchDashboard();
    } catch (err: any) {
      const msg = 'Re-sync Error: ' + (err?.message || 'Failed to re-sync');
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Re-sync Error', err?.message || 'Failed to re-sync');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };

  // First sync after linking WhatsApp: the card opens once, its countdown runs once.
  // A reload, a reconnect or a later login never opens it again.
  useEffect(() => {
    let cancelled = false;
    consumeFirstSync().then((first) => {
      if (cancelled || !first) return;
      setFirstSyncEnd(first.endsAt);
      setClock(Date.now());
      setShowSyncModal(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The clock only ticks while that countdown is running.
  useEffect(() => {
    if (firstSyncEnd === null) return;
    const tick = setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= firstSyncEnd) setFirstSyncEnd(null);
    }, 1000);
    return () => clearInterval(tick);
  }, [firstSyncEnd]);

  const showFirstSyncTimer = firstSyncEnd !== null;
  const firstSyncRemainingMs = firstSyncEnd !== null ? Math.max(0, firstSyncEnd - clock) : 0;

  const syncProgressPercent = syncProgress?.progress || 0;

  // What the card shows. 100% only when the server says the sync really finished; "nothing running" is not "done".
  const syncPhase: 'running' | 'done' | 'idle' =
    syncing || syncProgress?.status === 'SYNCING' || (syncProgress?.status && !['COMPLETED', 'IDLE'].includes(syncProgress.status) && syncProgress.progress > 0 && syncProgress.progress < 100)
      ? 'running'
      : syncProgress?.status === 'COMPLETED'
      ? 'done'
      : 'idle';
  const syncShownPercent = syncPhase === 'done' ? 100 : syncPhase === 'running' ? Math.min(99, syncProgress?.progress || 0) : 0;
  // Chats arrive with the contact list, but the messages inside them are sent by WhatsApp only once, when the
  // account is linked. Chats without messages mean that batch never arrived, and Re-sync cannot bring it back.
  const connectedNow = whatsappStatus === 'CONNECTED' || whatsappStatus === 'READY';
  const missingMessages = connectedNow && syncPhase !== 'running' && (waStats?.chats ?? 0) > 5 && (waStats?.messages ?? 0) < 5;
  const syncShownMessage =
    syncPhase === 'idle'
      ? whatsappStatus === 'CONNECTED' || whatsappStatus === 'READY'
        ? 'WhatsApp is connected. No sync is running right now.'
        : 'WhatsApp is not connected.'
      : syncProgress?.message || (syncPhase === 'done' ? 'WhatsApp data is up to date.' : 'Synchronizing...');

  useEffect(() => {
    navigation.setOptions({
      headerTitle: 'Dashboard',
      headerRight: () => (
        <TouchableOpacity
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.22)',
            paddingHorizontal: 12,
            paddingVertical: 5,
            borderRadius: 16,
            marginRight: 10,
            borderWidth: 1,
            borderColor: 'rgba(255, 255, 255, 0.35)',
          }}
          onPress={() => setShowSyncModal(true)}
          activeOpacity={0.7}
        >
          {whatsappStatus === 'SYNCING' ? (
            <ActivityIndicator size="small" color="#34D399" style={{ marginRight: 6 }} />
          ) : (
            <Text style={{ color: '#34D399', fontSize: 12, fontWeight: '800', marginRight: 4 }}>↻</Text>
          )}
          <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>
            {whatsappStatus === 'SYNCING'
              ? `Syncing (${syncProgressPercent}%)`
              : 'Sync Status'}
          </Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, whatsappStatus, syncProgressPercent]);

  const fetchTimeoutRef = React.useRef<any>(null);
  const fetchDashboardRef = React.useRef(fetchDashboard);

  useEffect(() => {
    fetchDashboardRef.current = fetchDashboard;
  }, [fetchDashboard]);

  const debouncedFetchDashboard = useCallback(() => {
    if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
    fetchTimeoutRef.current = setTimeout(() => {
      if (fetchDashboardRef.current) fetchDashboardRef.current();
    }, 800);
  }, []);

  // Dismissing is an explicit action saved on the server; if saving fails the card comes back.
  const handleDismissItem = async (item: any) => {
    const snapshot = dashboardData;
    setDashboardData((prev: any) => ({
      ...prev,
      actionCenterItems: (prev.actionCenterItems || []).filter((i: any) => i.id !== item.id),
      totalActionItems: Math.max(0, (prev.totalActionItems || 1) - 1),
    }));

    try {
      await apiClient.delete(`/extractions/${item.id}?category=${item.category}`);
    } catch (err) {
      console.warn('Failed to dismiss action item:', err);
      setDashboardData(snapshot);
    }
  };

  useEffect(() => {
    fetchDashboard();

    const unsubEvents = [
      socketService.on('dashboard:updated', debouncedFetchDashboard),
      socketService.on('whatsapp:data_reset', () => {
        setWhatsappStatus('DISCONNECTED');
        setSyncProgress(null);
        setShowSyncModal(false);
        fetchDashboardRef.current();
      }),
      socketService.on('ai:extraction', debouncedFetchDashboard),
      socketService.on('ai:extraction-updated', debouncedFetchDashboard),
      socketService.on('ai:suggestion', debouncedFetchDashboard),
      socketService.on('ai.extraction.created', debouncedFetchDashboard),
      socketService.on('message:new', debouncedFetchDashboard),
      socketService.on('chat.message.new', debouncedFetchDashboard),
      socketService.on('conversation:updated', debouncedFetchDashboard),
      socketService.on('whatsapp.status', (data: any) => {
        if (data?.status) {
          if (data.status === 'DISCONNECTED') {
            setShowSyncModal(false);
            setSyncProgress(null);
          }
          setWhatsappStatus((prev) => (prev === data.status ? prev : data.status));
        }
      }),
      socketService.on('sync:progress', (data: any) => {
        if (!data || data.status === 'IDLE') {
          setSyncProgress(null);
          return;
        }
        // The first sync is finished: the one-time countdown ends with it.
        if (data.status === 'COMPLETED') setFirstSyncEnd(null);
        setSyncProgress((prev: any) => {
          if (prev?.progress === data.progress && prev?.currentStage === data.currentStage) return prev;
          return data;
        });
      }),
      socketService.on('whatsapp.sync', (data: any) => {
        if (!data || data.stage === 'idle') {
          setSyncProgress(null);
          return;
        }
        const syncState = data?.syncState || data;
        if (!syncState) return;
        if (syncState.status === 'COMPLETED') setFirstSyncEnd(null);
        setSyncProgress((prev: any) => {
          if (prev?.progress === syncState.progress && prev?.currentStage === syncState.currentStage) return prev;
          return syncState;
        });
      }),
    ];

    return () => {
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
      unsubEvents.forEach((unsub) => {
        if (typeof unsub === 'function') unsub();
      });
    };
  }, [debouncedFetchDashboard]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchDashboard();
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  const handleUseSuggestion = (suggestion: any) => {
    navigation.navigate('ChatsTab', {
      screen: 'ChatDetail',
      params: {
        chatId: suggestion.conversationId,
        contactName: suggestion.conversation?.contact?.displayName || suggestion.conversation?.title || 'Chat',
        initialText: suggestion.suggestion || suggestion.text,
      },
    });
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading AI Intelligence Dashboard...</Text>
      </View>
    );
  }

  const { birthdays, meetings, tasks, payments, travel } =
    dashboardData.importantToday || {};

  const allImportant = [
    ...(birthdays || []).map((b: any) => ({ ...b, typeBadge: '🎂 Birthday', color: '#E91E63' })),
    ...(meetings || []).map((m: any) => ({ ...m, typeBadge: '📅 Meeting', color: '#1976D2' })),
    ...(payments || []).map((p: any) => ({ ...p, typeBadge: '💰 Payment', color: '#388E3C' })),
    ...(tasks || []).map((t: any) => ({ ...t, typeBadge: '✅ Task', color: '#F59E0B' })),
    ...(travel || []).map((tr: any) => ({ ...tr, typeBadge: '✈️ Travel', color: '#8E24AA' })),
  ];

  const getStatusDetails = () => {
    switch (whatsappStatus) {
      case 'CONNECTED':
      case 'READY':
        return { label: 'WhatsApp Online', dotColor: '#16A34A', bgColor: '#DCFCE7', textColor: '#166534' };
      case 'SYNCING':
        return {
          label: `Syncing ${syncProgress?.progress || 0}%`,
          dotColor: '#F59E0B',
          bgColor: '#FEF3C7',
          textColor: '#92400E',
        };
      case 'QR_PENDING':
      case 'PAIRING_CODE_PENDING':
      case 'AUTHENTICATING':
        return { label: 'Action Required', dotColor: '#F59E0B', bgColor: '#FEF3C7', textColor: '#92400E' };
      default:
        return { label: 'WhatsApp Offline', dotColor: '#DC2626', bgColor: '#FEE2E2', textColor: '#991B1B' };
    }
  };

  const statusInfo = getStatusDetails();

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />}
    >
      {/* Elevated Hero Card with 2D Cartoon Robot Mascot */}
      <View style={styles.heroCard}>
        <View style={styles.heroTextContent}>
          <View style={[styles.heroStatusBadge, { backgroundColor: statusInfo.bgColor }]}>
            <View style={[styles.heroStatusDot, { backgroundColor: statusInfo.dotColor }]} />
            <Text style={[styles.heroStatusText, { color: statusInfo.textColor }]}>
              {statusInfo.label}
            </Text>
          </View>
          <Text style={styles.heroGreeting}>{getGreeting()}</Text>
          <Text style={styles.heroUserName}>{user?.name || 'Vaibhav'}</Text>
          <Text style={styles.heroSubtitle}>Your daily communication overview</Text>
        </View>
        <View style={styles.heroMascotWrap}>
          <Sticker name="robot" size={82} />
        </View>
      </View>

      {/* Dynamic Sync Banner */}
      {whatsappStatus === 'SYNCING' && syncProgress && (
        <TouchableOpacity
          style={styles.syncBanner}
          onPress={() => setShowSyncModal(true)}
        >
          <View style={styles.syncBannerTop}>
            <IconText icon="flash" style={styles.syncBannerTitle}>{`WhatsApp Sync in Background (${syncProgress.progress || 0}%)`}</IconText>
            <Text style={styles.syncBannerAction}>Details ›</Text>
          </View>
          <Text style={styles.syncBannerMsg}>{syncProgress.message || 'Syncing messages & extracting intelligence...'}</Text>
          <View style={styles.syncMiniBar}>
            <View style={[styles.syncMiniFill, { width: `${Math.min(100, Math.max(0, syncProgress.progress || 0))}%` }]} />
          </View>
        </TouchableOpacity>
      )}

      {/* Sync Details Modal */}
      <Modal
        visible={showSyncModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowSyncModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowSyncModal(false)}
        >
          <View style={styles.modalContent} onStartShouldSetResponder={() => true}>
            <View style={styles.modalHeaderRow}>
              <IconText icon="flash" style={styles.modalHeaderTitle}>WhatsApp Sync Status</IconText>
              <TouchableOpacity onPress={() => setShowSyncModal(false)} style={styles.closeCircle}>
                <Ionicons name="close" size={16} color="#64748B" />
              </TouchableOpacity>
            </View>

            {/* Overall Sync Progress Banner */}
            <View style={[styles.syncProgressBox, { minHeight: 96, justifyContent: 'center' }]}>
              <View style={styles.syncBoxTopRow}>
                <View style={styles.syncBoxLeft}>
                  <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center', marginRight: 8 }}>
                    {syncPhase === 'running' ? (
                      <ActivityIndicator size="small" color="#34D399" />
                    ) : syncPhase === 'done' ? (
                      <Ionicons name="checkmark-circle" size={20} color="#34D399" />
                    ) : (
                      <Ionicons name="pause-circle-outline" size={20} color="#A7F3D0" />
                    )}
                  </View>
                  <Text style={styles.syncBoxMessage} numberOfLines={1}>
                    {syncShownMessage}
                  </Text>
                </View>
                <Text style={styles.syncBoxPercentage}>
                  {syncPhase === 'idle' ? '—' : `${syncShownPercent}%`}
                </Text>
              </View>
              <View style={styles.syncBoxTrack}>
                <View
                  style={[
                    styles.syncBoxFill,
                    {
                      width: `${syncShownPercent}%`,
                    },
                  ]}
                />
              </View>
            </View>

            {/* First sync after linking: one countdown, shown once */}
            {showFirstSyncTimer && (
              <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#BBF7D0' }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <IconText icon="timer-outline" style={{ fontSize: 14, fontWeight: '700', color: '#08463E' }}>First sync, time left</IconText>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: '#08463E', fontVariant: ['tabular-nums'] as any, minWidth: 70, textAlign: 'right' }}>
                    {formatCountdown(firstSyncRemainingMs)}
                  </Text>
                </View>
                <Text style={{ fontSize: 12, color: '#0B5D52', marginTop: 6 }}>
                  Your WhatsApp data is loading for the first time. You can close this card; everything keeps running in the background.
                </Text>
              </View>
            )}

            {missingMessages && (
              <View style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FDE68A' }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: '#92400E', marginBottom: 4 }}>Messages did not arrive</Text>
                <Text style={{ fontSize: 13, color: '#78350F', lineHeight: 19 }}>
                  Your {waStats.chats} chats and {waStats.contacts} contacts are here, but WhatsApp has only sent {waStats.messages} messages. WhatsApp
                  sends message history just once, when you link the account, and Re-sync cannot fetch it again. To receive it: unlink
                  WhatsApp in Settings, then link it again and keep the app open for a couple of minutes.
                </Text>
                <TouchableOpacity
                  style={{ marginTop: 10, backgroundColor: '#B45309', borderRadius: 10, paddingVertical: 11, alignItems: 'center' }}
                  onPress={() => {
                    setShowSyncModal(false);
                    navigation.navigate('SettingsTab');
                  }}
                >
                  <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 14 }}>Go to Settings to link again</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Concurrent Multi-process Progress Bars */}
            {syncProgress && (
              <View style={styles.multiStageContainer}>
                {/* Contacts Stage */}
                {(syncProgress.contacts?.total > 0 || syncProgress.currentStage === 'CONTACTS') && (
                  <View style={styles.subStageBox}>
                    <View style={styles.subStageRow}>
                      <IconText icon="people" style={styles.subStageLabel}>Contacts Sync</IconText>
                      <Text style={styles.subStagePct}>
                        {syncProgress.contacts?.percentage ?? 100}% ({syncProgress.contacts?.processed || 0}/{syncProgress.contacts?.total || 0})
                      </Text>
                    </View>
                    <View style={styles.subStageTrack}>
                      <View
                        style={[
                          styles.subStageFill,
                          { width: `${Math.min(100, syncProgress.contacts?.percentage ?? 100)}%` },
                        ]}
                      />
                    </View>
                  </View>
                )}

                {/* Conversations Stage */}
                {(syncProgress.conversations?.total > 0 || syncProgress.currentStage === 'CONVERSATIONS') && (
                  <View style={styles.subStageBox}>
                    <View style={styles.subStageRow}>
                      <IconText icon="chatbubble-ellipses" style={styles.subStageLabel}>Conversations Sync</IconText>
                      <Text style={styles.subStagePct}>
                        {syncProgress.conversations?.percentage ?? 100}% ({syncProgress.conversations?.processed || 0}/{syncProgress.conversations?.total || 0})
                      </Text>
                    </View>
                    <View style={styles.subStageTrack}>
                      <View
                        style={[
                          styles.subStageFill,
                          { width: `${Math.min(100, syncProgress.conversations?.percentage ?? 100)}%` },
                        ]}
                      />
                    </View>
                  </View>
                )}

                {/* Messages Stage */}
                {(syncProgress.messages?.total > 0 || syncProgress.currentStage === 'MESSAGES') && (
                  <View style={styles.subStageBox}>
                    <View style={styles.subStageRow}>
                      <IconText icon="mail" style={styles.subStageLabel}>Message History Sync</IconText>
                      <Text style={styles.subStagePct}>
                        {syncProgress.messages?.percentage ?? 0}% ({syncProgress.messages?.processed || 0}/{syncProgress.messages?.total || 0})
                      </Text>
                    </View>
                    <View style={styles.subStageTrack}>
                      <View
                        style={[
                          styles.subStageFill,
                          { width: `${Math.min(100, syncProgress.messages?.percentage ?? 0)}%` },
                        ]}
                      />
                    </View>
                  </View>
                )}

                {/* AI Intelligence Extractions Stage */}
                {(syncProgress.aiExtraction?.total > 0 || syncProgress.currentStage === 'AI_EXTRACTION' || syncProgress.currentStage === 'AI_ANALYSIS') && (
                  <View style={styles.subStageBox}>
                    <View style={styles.subStageRow}>
                      <IconText icon="sparkles" style={styles.subStageLabel}>AI Profile Intelligence</IconText>
                      <Text style={styles.subStagePct}>
                        {syncProgress.aiExtraction?.percentage ?? 0}% ({syncProgress.aiExtraction?.processed || 0}/{syncProgress.aiExtraction?.total || 0})
                      </Text>
                    </View>
                    <View style={styles.subStageTrack}>
                      <View
                        style={[
                          styles.subStageFill,
                          { width: `${Math.min(100, syncProgress.aiExtraction?.percentage ?? 0)}%` },
                        ]}
                      />
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* Action Buttons */}
            <View style={styles.modalActionsStack}>
              <TouchableOpacity
                style={[styles.resyncButton, syncing && { opacity: 0.7 }]}
                onPress={doResync}
                disabled={syncing}
              >
                {syncing ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <IconText center icon="refresh" style={styles.resyncButtonText}>Re-sync WhatsApp Data</IconText>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.bgRunButton}
                onPress={() => setShowSyncModal(false)}
              >
                <IconText center icon="play-forward" style={styles.bgRunButtonText}>Run in Background</IconText>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* AI Off Banner / Highlights Section */}
      {dashboardData.aiEnabled === false || dashboardData.tokenStats?.autoAIAnalysis === false ? (
        <View style={styles.aiOffCard}>
          <Illustration name="ai" size={170} />
          <Text style={styles.aiOffTitle}>AI Analysis is Off</Text>
          <Text style={styles.aiOffSub}>
            Turn on AI Analysis in Settings to analyze your WhatsApp messages and generate important insights and reply suggestions.
          </Text>
          <TouchableOpacity
            style={styles.turnOnAiBtn}
            onPress={() => navigation.navigate('SettingsTab')}
          >
            <Text style={styles.turnOnAiBtnText}>Turn On AI</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <MorningBriefingCard
            onNavigateToActionCenter={() => navigation.navigate('ExtractionsTab')}
            refreshTrigger={briefingRefreshCount}
          />
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View>
                <IconText icon="flash" style={styles.sectionTitle}>AI Action Center</IconText>
              <Text style={styles.sectionSub}>High-value items requiring your action</Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('ExtractionsTab')}>
              <Text style={styles.seeAllText}>View All ({dashboardData.totalActionItems || 0}) ›</Text>
            </TouchableOpacity>
          </View>

          {!dashboardData.actionCenterItems || dashboardData.actionCenterItems.length === 0 ? (
            <View style={styles.emptyCard}>
              <Illustration name="done" size={110} />
              <Text style={styles.emptyTitle}>Everything caught up!</Text>
              <Text style={styles.emptySub}>No pending replies, follow-ups, or birthdays requiring action right now.</Text>
            </View>
          ) : (
            dashboardData.actionCenterItems.map((item: any) => {
              const isReplyNeeded = item.category === 'REPLY_NEEDED';
              const isFollowUp = item.category === 'FOLLOW_UP';
              const isBirthday = item.category === 'BIRTHDAY';

              const itemSticker: any = isBirthday
                ? 'birthday'
                : item.category === 'MEETING' || item.category === 'APPOINTMENT' || item.category === 'TASK'
                ? 'calendar'
                : item.category === 'PAYMENT'
                ? 'wallet'
                : item.category === 'TRAVEL'
                ? 'travel'
                : 'brain';

              const catTheme = (() => {
                switch (item.category) {
                  case 'BIRTHDAY':
                  case 'BIRTHDAY_WISH':
                    return {
                      cardBg: '#FFF6F9',
                      cardBorder: '#FBCFE8',
                      badgeBg: '#FCE7F3',
                      badgeBorder: '#F472B6',
                      badgeText: '#BE185D',
                      boxBg: '#FFFFFF',
                      boxBorder: '#FCE7F3',
                      pillBorder: '#FBCFE8',
                    };
                  case 'TASK':
                    return {
                      cardBg: '#FFFDF2',
                      cardBorder: '#FDE68A',
                      badgeBg: '#FEF3C7',
                      badgeBorder: '#FBBF24',
                      badgeText: '#92400E',
                      boxBg: '#FFFFFF',
                      boxBorder: '#FEF3C7',
                      pillBorder: '#FDE68A',
                    };
                  case 'MEETING':
                  case 'APPOINTMENT':
                    return {
                      cardBg: '#F4FAFF',
                      cardBorder: '#BAE6FD',
                      badgeBg: '#E0F2FE',
                      badgeBorder: '#60A5FA',
                      badgeText: '#0369A1',
                      boxBg: '#FFFFFF',
                      boxBorder: '#E0F2FE',
                      pillBorder: '#BAE6FD',
                    };
                  case 'FOLLOW_UP':
                    return {
                      cardBg: '#F5F9FF',
                      cardBorder: '#BFDBFE',
                      badgeBg: '#DBEAFE',
                      badgeBorder: '#60A5FA',
                      badgeText: '#1E40AF',
                      boxBg: '#FFFFFF',
                      boxBorder: '#DBEAFE',
                      pillBorder: '#BFDBFE',
                    };
                  case 'PAYMENT':
                    return {
                      cardBg: '#F2FCF6',
                      cardBorder: '#BBF7D0',
                      badgeBg: '#DCFCE7',
                      badgeBorder: '#4ADE80',
                      badgeText: '#15803D',
                      boxBg: '#FFFFFF',
                      boxBorder: '#DCFCE7',
                      pillBorder: '#BBF7D0',
                    };
                  case 'TRAVEL':
                    return {
                      cardBg: '#FAF5FF',
                      cardBorder: '#E9D5FF',
                      badgeBg: '#F3E8FF',
                      badgeBorder: '#C084FC',
                      badgeText: '#7E22CE',
                      boxBg: '#FFFFFF',
                      boxBorder: '#F3E8FF',
                      pillBorder: '#E9D5FF',
                    };
                  default:
                    return {
                      cardBg: '#F2FBF8',
                      cardBorder: '#A7F3D0',
                      badgeBg: '#DCFCE7',
                      badgeBorder: '#34D399',
                      badgeText: '#065F46',
                      boxBg: '#FFFFFF',
                      boxBorder: '#D1FAE5',
                      pillBorder: '#A7F3D0',
                    };
                }
              })();

              return (
                <View
                  key={`${item.category}:${item.id}`}
                  style={[
                    styles.actionCard,
                    {
                      backgroundColor: catTheme.cardBg,
                      borderColor: catTheme.cardBorder,
                    },
                  ]}
                >
                  {/* Card Header */}
                  <View style={styles.actionCardHeader}>
                    <View style={styles.actionHeaderLeft}>
                      <Sticker name={itemSticker} size={30} style={{ marginRight: 4 }} />
                      <View style={[styles.actionBadge, { backgroundColor: catTheme.badgeBg, borderColor: catTheme.badgeBorder }]}>
                        <BadgeLabel label={item.badgeLabel} color={catTheme.badgeText} style={styles.actionBadgeText} />
                      </View>
                      <Text style={styles.actionTimeText}>
                        {item.timeAgo ||
                          (item.eventDate
                            ? formatDueDate(item.eventDate)
                            : 'Recent')}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={styles.dismissCircleBtn}
                      onPress={() => handleDismissItem(item)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="close" size={15} color="#94A3B8" />
                    </TouchableOpacity>
                  </View>

                  {/* Sender & Group Information Row */}
                  <View style={styles.senderPillRow}>
                    <View style={[styles.senderPill, { borderColor: catTheme.pillBorder }]}>
                      <Ionicons name="person-outline" size={12} color="#075E54" style={{ marginRight: 4 }} />
                      <Text style={styles.senderPillText} numberOfLines={1}>
                        {item.senderName || item.contactName || 'Contact'}
                      </Text>
                    </View>
                    {item.groupName && (
                      <View style={[styles.senderPill, styles.groupPill, { borderColor: catTheme.pillBorder }]}>
                        <Ionicons name="people-outline" size={12} color="#475569" style={{ marginRight: 4 }} />
                        <Text style={[styles.senderPillText, { color: '#475569' }]} numberOfLines={1}>
                          {item.groupName}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* Title and Summary */}
                  <Text style={styles.actionTitle}>{item.title}</Text>
                  <Text style={styles.actionSummary}>{item.summary}</Text>

                  {/* Source Message Box */}
                  {item.sourceMessageText && (
                    <View style={[styles.sourceBox, { backgroundColor: catTheme.boxBg, borderColor: catTheme.boxBorder }]}>
                      <View style={styles.boxHeaderRow}>
                        <Ionicons name="chatbubble-outline" size={12} color="#64748B" style={{ marginRight: 5 }} />
                        <Text style={styles.sourceLabel}>Original Message</Text>
                      </View>
                      <Text style={styles.sourceText} numberOfLines={3}>
                        "{item.sourceMessageText}"
                      </Text>
                    </View>
                  )}

                  {/* Prepared Reply Box */}
                  {item.suggestedReply && (
                    <View style={[styles.aiReplyBox, { backgroundColor: '#FFFFFF', borderColor: '#A7F3D0' }]}>
                      <View style={styles.boxHeaderRow}>
                        <Ionicons name="sparkles" size={12} color="#0D9488" style={{ marginRight: 5 }} />
                        <Text style={styles.aiReplyLabel}>Prepared Response</Text>
                      </View>
                      <Text style={styles.aiReplyText} numberOfLines={3}>
                        "{item.suggestedReply}"
                      </Text>
                    </View>
                  )}

                  {/* Actions Row with Harmonious Palette */}
                  <View style={styles.actionBtnRow}>
                    {isReplyNeeded && (
                      <>
                        <TouchableOpacity
                          style={styles.btnSecondary}
                          onPress={() =>
                            navigation.navigate('ChatsTab', {
                              screen: 'ChatDetail',
                              params: {
                                chatId: item.conversationId,
                                contactName: item.contactName,
                                initialText: item.suggestedReply,
                                fromItem: { id: item.id, category: item.category },
                              },
                            })
                          }
                        >
                          <IconText center icon="create-outline" style={styles.btnSecondaryText}>Edit Reply</IconText>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.btnPrimary}
                          onPress={() =>
                            navigation.navigate('ChatsTab', {
                              screen: 'ChatDetail',
                              params: {
                                chatId: item.conversationId,
                                contactName: item.contactName,
                                initialText: item.suggestedReply,
                                fromItem: { id: item.id, category: item.category },
                              },
                            })
                          }
                        >
                          <IconText center icon="send" style={styles.btnPrimaryText}>Send</IconText>
                        </TouchableOpacity>
                      </>
                    )}

                    {isFollowUp && item.suggestedReply && (
                      <>
                        <TouchableOpacity
                          style={styles.btnSecondary}
                          onPress={() =>
                            navigation.navigate('ChatsTab', {
                              screen: 'ChatDetail',
                              params: {
                                chatId: item.conversationId,
                                contactName: item.contactName,
                                initialText: item.suggestedReply,
                                fromItem: { id: item.id, category: item.category },
                              },
                            })
                          }
                        >
                          <IconText center icon="create-outline" style={styles.btnSecondaryText}>Edit Reply</IconText>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.btnPrimary}
                          onPress={() =>
                            navigation.navigate('ChatsTab', {
                              screen: 'ChatDetail',
                              params: {
                                chatId: item.conversationId,
                                contactName: item.contactName,
                                initialText: item.suggestedReply,
                                fromItem: { id: item.id, category: item.category },
                              },
                            })
                          }
                        >
                          <IconText center icon="send" style={styles.btnPrimaryText}>Send</IconText>
                        </TouchableOpacity>
                      </>
                    )}

                    {isFollowUp && !item.suggestedReply && (
                      <TouchableOpacity
                        style={[styles.btnPrimary, { flex: 1 }]}
                        onPress={() =>
                          navigation.navigate('ChatsTab', {
                            screen: 'ChatDetail',
                            params: {
                              chatId: item.conversationId,
                              contactName: item.contactName,
                              initialText: '',
                              fromItem: { id: item.id, category: item.category },
                            },
                          })
                        }
                      >
                        <IconText center icon="chatbubble-ellipses" style={styles.btnPrimaryText}>Reply</IconText>
                      </TouchableOpacity>
                    )}

                    {isBirthday && item.isForCurrentUser !== false && item.suggestedReply && (
                      <TouchableOpacity
                        style={[styles.btnPrimary, { flex: 1 }]}
                        onPress={() =>
                          navigation.navigate('ChatsTab', {
                            screen: 'ChatDetail',
                            params: {
                              chatId: item.conversationId,
                              contactName: item.contactName,
                              initialText: item.suggestedReply,
                              fromItem: { id: item.id, category: item.category },
                            },
                          })
                        }
                      >
                        <IconText center icon="gift" style={styles.btnPrimaryText}>Reply & Wish Back</IconText>
                      </TouchableOpacity>
                    )}

                    {(item.category === 'MEETING' || item.category === 'APPOINTMENT' || item.category === 'EVENT' || item.eventDate) && (
                      <TouchableOpacity
                        style={[styles.btnCalendar, { flex: 1 }]}
                        onPress={() =>
                          openGoogleCalendar({
                            title: item.title,
                            description: item.summary || item.sourceMessageText,
                            startDate: item.eventDate,
                          })
                        }
                      >
                        <IconText center icon="calendar" style={styles.btnCalendarText}>Add to Calendar</IconText>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>
        </>
      )}

      {/* Recent Conversations */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <View>
            <IconText icon="chatbubbles" style={styles.sectionTitle}>Recent Chats</IconText>
            <Text style={styles.sectionSub}>Latest synchronized conversations</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('ChatsTab')}>
            <Text style={styles.seeAllText}>Open Chats ›</Text>
          </TouchableOpacity>
        </View>

        {recentChats.length === 0 ? (
          <View style={styles.emptyCard}>
            <Illustration name="chat" size={110} />
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptySub}>
              When your WhatsApp messages sync, your recent conversations will appear here.
            </Text>
          </View>
        ) : (
          <View style={styles.chatsCardContainer}>
            {recentChats.map((chat, idx) => {
              const isGroup = chat.chatType === 'GROUP' || chat.isGroup || chat.whatsappChatJid?.includes('@g.us');
              const storedChatTitle = typeof chat.title === 'string' ? chat.title.trim() : '';
              const resolvedChatTitle = storedChatTitle || resolveDisplayName(chat.contact, chat.title, isGroup) || 'WhatsApp Chat';
              const isLast = idx === recentChats.length - 1;

              return (
                <React.Fragment key={chat.id}>
                  <TouchableOpacity
                    style={styles.chatListItem}
                    activeOpacity={0.7}
                    onPress={() =>
                      navigation.navigate('ChatsTab', {
                        screen: 'ChatDetail',
                        params: {
                          chatId: chat.id,
                          contactName: resolvedChatTitle,
                        },
                      })
                    }
                  >
                    <Avatar
                      name={resolvedChatTitle}
                      uri={chat.avatarUrl || chat.contact?.profilePhotoUrl}
                      size={44}
                      group={isGroup}
                      style={{ marginRight: 12 }}
                    />
                    <View style={styles.chatInfo}>
                      <View style={styles.chatTitleRow}>
                        <Text style={styles.chatName} numberOfLines={1}>
                          {resolvedChatTitle}
                        </Text>
                        {isGroup && (
                          <View style={styles.groupBadge}>
                            <Text style={styles.groupBadgeText}>Group</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.chatLastMsg} numberOfLines={1}>
                        {chat.lastMessageText && chat.lastMessageText !== '[Chat initialized]'
                          ? chat.lastMessageText
                          : 'No messages yet'}
                      </Text>
                    </View>
                    {chat.unreadCount > 0 ? (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadCount}>{chat.unreadCount}</Text>
                      </View>
                    ) : (
                      <Ionicons name="chevron-forward" size={16} color="#CBD5E1" />
                    )}
                  </TouchableOpacity>
                  {!isLast && <View style={styles.chatDivider} />}
                </React.Fragment>
              );
            })}
          </View>
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 18,
    paddingBottom: 40,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },
  loadingText: {
    marginTop: 12,
    color: Colors.textSecondary,
    fontSize: 14,
  },
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.04,
    shadowRadius: 10,
    elevation: 2,
  },
  heroTextContent: {
    flex: 1,
    paddingRight: 10,
  },
  heroStatusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  heroStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 6,
  },
  heroStatusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  heroGreeting: {
    fontSize: 13,
    color: Colors.textMuted,
    fontWeight: '600',
  },
  heroUserName: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    letterSpacing: -0.3,
    marginVertical: 2,
  },
  heroSubtitle: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
    fontWeight: '500',
  },
  heroMascotWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    paddingTop: 10,
  },
  greeting: {
    fontSize: 14,
    color: Colors.textSecondary,
    fontWeight: '500',
  },
  userName: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  syncNavBtn: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  syncNavBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.text,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E6F4F1',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.accentDark,
    marginRight: 6,
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.secondary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalHeaderTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.text,
  },
  closeCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F1F5F9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeCircleText: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '700',
  },
  syncProgressBox: {
    backgroundColor: '#064E3B',
    borderRadius: 12,
    padding: 16,
    marginBottom: 18,
  },
  syncBoxTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  syncBoxLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  checkMark: {
    color: '#34D399',
    fontSize: 16,
    fontWeight: '800',
    marginRight: 8,
  },
  syncBoxMessage: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  syncBoxPercentage: {
    color: '#34D399',
    fontSize: 14,
    fontWeight: '800',
  },
  syncBoxTrack: {
    height: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  syncBoxFill: {
    height: '100%',
    backgroundColor: '#34D399',
    borderRadius: 3,
  },
  multiStageContainer: {
    marginTop: 14,
    marginBottom: 16,
    gap: 8,
  },
  subStageBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: '#F1F5F9',
  },
  subStageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  subStageLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748B',
  },
  subStagePct: {
    fontSize: 11,
    fontWeight: '700',
    color: '#16A34A',
  },
  subStageTrack: {
    height: 5,
    backgroundColor: '#E2E8F0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  subStageFill: {
    height: '100%',
    backgroundColor: '#16A34A',
    borderRadius: 3,
  },
  modalActionsStack: {
    gap: 10,
  },
  resyncButton: {
    backgroundColor: '#059669',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resyncButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  bgRunButton: {
    backgroundColor: '#F1F5F9',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  bgRunButtonText: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '600',
  },
  syncBanner: {
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  syncBannerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  syncBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E40AF',
  },
  syncBannerAction: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2563EB',
  },
  syncBannerMsg: {
    fontSize: 12,
    color: '#3B82F6',
    marginBottom: 8,
  },
  syncMiniBar: {
    height: 4,
    backgroundColor: '#DBEAFE',
    borderRadius: 2,
    overflow: 'hidden',
  },
  syncMiniFill: {
    height: '100%',
    backgroundColor: '#2563EB',
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.text,
  },
  seeAllText: {
    fontSize: 13,
    color: Colors.secondary,
    fontWeight: '600',
  },
  emptyCard: {
    backgroundColor: Colors.cardBackground,
    borderRadius: 14,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  emptyEmoji: {
    fontSize: 32,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.text,
  },
  emptySub: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 18,
  },
  eventCard: {
    backgroundColor: Colors.cardBackground,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  eventHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  typeTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  typeTagText: {
    fontSize: 12,
    fontWeight: '700',
  },
  eventDate: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '500',
  },
  eventTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 4,
  },
  eventSummary: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  sectionSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  actionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  actionCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  actionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    flexWrap: 'wrap',
  },
  actionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3.5,
    borderRadius: 9,
    borderWidth: 1,
  },
  actionBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  actionTimeText: {
    fontSize: 11.5,
    color: '#94A3B8',
    fontWeight: '600',
  },
  dismissCircleBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  senderPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  senderPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  groupPill: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
  },
  senderPillText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1E293B',
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  actionSummary: {
    fontSize: 13.5,
    color: '#475569',
    lineHeight: 19,
    marginBottom: 10,
  },
  sourceBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  boxHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  sourceLabel: {
    fontSize: 11,
    color: '#64748B',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  sourceText: {
    fontSize: 13,
    color: '#1E293B',
    lineHeight: 18,
    fontStyle: 'italic',
  },
  aiReplyBox: {
    backgroundColor: '#F0FDF4',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  aiReplyLabel: {
    fontSize: 11,
    color: '#0F766E',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  aiReplyText: {
    fontSize: 13,
    color: '#065F46',
    fontWeight: '600',
    lineHeight: 18,
  },
  actionBtnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  btnSecondary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  btnSecondaryText: {
    color: '#334155',
    fontSize: 13,
    fontWeight: '700',
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: Colors.primary,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 2,
  },
  btnPrimaryText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  btnCalendar: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: '#0284C7',
    shadowColor: '#0284C7',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 5,
    elevation: 2,
  },
  btnCalendarText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
  },
  suggestionCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  sugHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sugContact: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.primaryDark,
  },
  sugToneBadge: {
    fontSize: 11,
    backgroundColor: '#DCFCE7',
    color: Colors.primaryDark,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    fontWeight: '600',
  },
  sugText: {
    fontSize: 14,
    color: Colors.text,
    fontStyle: 'italic',
    marginBottom: 12,
  },
  sendSugButton: {
    backgroundColor: Colors.secondary,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  sendSugText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: '700',
  },
  chatsCardContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 8,
    elevation: 1,
  },
  chatListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  chatTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  groupBadge: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 6,
  },
  groupBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748B',
  },
  chatDivider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginLeft: 72,
  },
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.cardBackground,
    padding: 14,
    borderRadius: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700',
  },
  chatInfo: {
    flex: 1,
  },
  chatName: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
  },
  chatLastMsg: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  unreadBadge: {
    backgroundColor: Colors.unreadBadge,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadCount: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  aiOffCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  aiOffEmoji: {
    fontSize: 36,
    marginBottom: 10,
  },
  aiOffTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.text,
    marginBottom: 8,
  },
  aiOffSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  turnOnAiBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
  },
  turnOnAiBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
});
