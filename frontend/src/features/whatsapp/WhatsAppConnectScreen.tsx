import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  ActivityIndicator,
  ScrollView,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { markFirstSyncPending, clearFirstSync } from '../../shared/utils/firstSync';
import { socketService } from '../../shared/services/socket';
import { AuthStorage } from '../../shared/services/authStorage';
import { Illustration } from '../../shared/components/Illustration';
import { Sticker } from '../../shared/components/Sticker';

// How much WhatsApp history the app keeps. The first sync only loads messages inside this window.
const RETENTION_CHOICES = [3, 7, 15, 30, 90, 365]; // Clean 6-option symmetric grid
const DEFAULT_RETENTION_DAYS = 365;

const getRetentionSubtext = (days: number): string => {
  if (days === 3) return 'Fastest';
  if (days === 7) return '1 Week';
  if (days === 15) return '2 Weeks';
  if (days === 30) return '1 Month';
  if (days === 60) return '2 Months';
  if (days === 90) return '3 Months';
  if (days >= 365) return '1 Year';
  return `${days} Days`;
};

export const WhatsAppConnectScreen = ({ navigation }: any) => {
  // True once a QR code / pairing code was shown in this session: the user is really linking.
  const sawLinkStepRef = React.useRef(false);

  // Data retention: saved the moment it is tapped, so it is already in place when the first sync runs.
  const [retentionDays, setRetentionDays] = useState<number>(DEFAULT_RETENTION_DAYS);
  const [retentionError, setRetentionError] = useState<string | null>(null);
  useEffect(() => {
    apiClient
      .get('/settings')
      .then((res: any) => {
        if (typeof res?.retentionDays === 'number') setRetentionDays(res.retentionDays);
      })
      .catch(() => {});
  }, []);
  const chooseRetention = async (days: number) => {
    if (days === retentionDays) return;
    const previous = retentionDays;
    setRetentionDays(days);
    setRetentionError(null);
    try {
      await apiClient.patch('/settings', { retentionDays: days });
    } catch {
      setRetentionDays(previous);
      setRetentionError('Could not save this choice. Please try again.');
    }
  };
  const [method, setMethod] = useState<'PAIRING_CODE' | 'QR'>('PAIRING_CODE');
  const [loading, setLoading] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('DISCONNECTED');
  const [alreadyConnectedDevice, setAlreadyConnectedDevice] = useState<{
    phoneNumber?: string;
    displayName?: string;
    deviceInfo?: string;
    connectedAt?: string;
  } | null>(null);
  const [syncProgress, setSyncProgress] = useState<{
    stage: string;
    progress: number;
    message: string;
    contactsCount?: number;
    groupsCount?: number;
    chatsCount?: number;
    messagesCount?: number;
    aiExtractionCount?: number;
    aiAnalysisCount?: number;
    contacts?: { total: number; processed: number; percentage: number };
    groups?: { total: number; processed: number; percentage: number };
    conversations?: { total: number; processed: number; percentage: number };
    messages?: { total: number; processed: number; percentage: number };
    aiExtraction?: { total: number; processed: number; percentage: number };
    aiAnalysis?: { total: number; processed: number; percentage: number };
    canContinueToApp?: boolean;
  } | null>(null);

  const handleLogout = () => {
    const doLogout = async () => {
      setLoading(true);
      try {
        await apiClient.post('/whatsapp/disconnect', {}, { timeout: 15000 }).catch(() => {});
        await clearFirstSync();
      } catch (err) {
        console.warn('WhatsApp disconnect on logout:', err);
      } finally {
        await AuthStorage.clear();
        socketService.disconnect();
        setLoading(false);
        navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm('Are you sure you want to log out of your account?')) {
        doLogout();
      }
    } else {
      Alert.alert('Log Out', 'Are you sure you want to log out of your account?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log Out', style: 'destructive', onPress: doLogout },
      ]);
    }
  };

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={handleLogout}
          style={styles.headerLogoutButton}
          activeOpacity={0.7}
        >
          <Ionicons name="log-out-outline" size={17} color="#FFFFFF" style={{ marginRight: 4 }} />
          <Text style={styles.headerLogoutText}>Logout</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, loading]);

  const fetchStatusAndConnect = async (targetMethod: 'QR' | 'PAIRING_CODE' = method) => {
    setLoading(true);
    try {
      // 1. Check current status from backend
      try {
        const current: any = await apiClient.get('/whatsapp/status');
        if (current.alreadyConnectedOnOtherDevice) {
          setStatus('ALREADY_CONNECTED_ON_OTHER_DEVICE');
          setAlreadyConnectedDevice(current.connectedDevice || null);
          return;
        }
        setAlreadyConnectedDevice(null);
        if (current.status === 'CONNECTED' || current.status === 'READY') {
          setStatus('CONNECTED');
          setTimeout(() => {
            navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
          }, 600);
          return;
        }
        if (current.status === 'SYNCING') {
          setStatus('SYNCING');
          const progressRes: any = await apiClient.get('/whatsapp/sync-progress').catch(() => null);
          if (progressRes) setSyncProgress(progressRes);
          return;
        }
        if (current.status === 'QR_PENDING' && current.qrCode) {
          sawLinkStepRef.current = true;
          setStatus('QR_PENDING');
          setQrCode(current.qrCode);
          return;
        }
      } catch (e: any) {
        if (e?.statusCode === 409 || e?.response?.data?.alreadyConnected) {
          setStatus('ALREADY_CONNECTED_ON_OTHER_DEVICE');
          setAlreadyConnectedDevice(e?.response?.data?.connectedDevice || null);
          return;
        }
      }

      // 2. Only initiate connection for QR mode if genuinely disconnected
      if (targetMethod === 'QR') {
        const res: any = await apiClient.post('/whatsapp/connect', { method: 'QR' });
        setStatus(res.status || 'QR_PENDING');
        if (res.qrCode) setQrCode(res.qrCode);
      }
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.response?.data?.alreadyConnected) {
        setStatus('ALREADY_CONNECTED_ON_OTHER_DEVICE');
        setAlreadyConnectedDevice(err?.response?.data?.connectedDevice || null);
      } else {
        console.error('Failed to initiate WhatsApp connection:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleForceTakeover = async () => {
    const proceed = async () => {
      setLoading(true);
      try {
        setAlreadyConnectedDevice(null);
        if (method === 'QR') {
          const res: any = await apiClient.post('/whatsapp/connect', {
            method: 'QR',
            forceTakeover: true,
          });
          setStatus(res.status || 'QR_PENDING');
          if (res.qrCode) setQrCode(res.qrCode);
        } else {
          if (!phoneNumber.trim()) {
            setStatus('DISCONNECTED');
            return;
          }
          const res: any = await apiClient.post('/whatsapp/pairing-code', {
            phoneNumber: phoneNumber.trim(),
            forceTakeover: true,
          });
          setStatus(res.status || 'PAIRING_CODE_PENDING');
          if (res.pairingCode) setPairingCode(res.pairingCode);
        }
      } catch (err: any) {
        const msg = err?.message || 'Failed to take over WhatsApp connection.';
        if (Platform.OS === 'web') window.alert(msg);
        else Alert.alert('Takeover Failed', msg);
      } finally {
        setLoading(false);
      }
    };

    const confirmMsg =
      'Disconnect WhatsApp on the other device and connect here? The other device will be disconnected immediately.';
    if (Platform.OS === 'web') {
      if (window.confirm(confirmMsg)) {
        proceed();
      }
    } else {
      Alert.alert('Disconnect Other Device?', confirmMsg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect & Connect Here', style: 'destructive', onPress: proceed },
      ]);
    }
  };

  useEffect(() => {
    socketService.connect();
    fetchStatusAndConnect(method);

    // Listen to authoritative real-time provider events
    const unsubStatus = socketService.on('whatsapp.status', (data) => {
      if (data.status) setStatus(data.status);
      if (data.status === 'QR_PENDING' || data.status === 'PAIRING_CODE_PENDING' || data.status === 'AUTHENTICATING') {
        sawLinkStepRef.current = true;
      }
      if (data.qrCode) setQrCode(data.qrCode);
      if (data.pairingCode) setPairingCode(data.pairingCode);

      if (data.status === 'DISCONNECTED') {
        setSyncProgress(null);
        setQrCode(null);
        setPairingCode(null);
      }

      if (data.status === 'CONNECTED' || data.status === 'READY') {
        // Only a real link counts (a QR / pairing code was shown in this session). A routine
        // 'connected' event on reload or reconnect must never start a first sync.
        markFirstSyncPending().catch(() => {});
        sawLinkStepRef.current = false;
        apiClient.get('/auth/me').then((me: any) => {
          if (me) AuthStorage.setUser(me);
        }).catch(() => {});

        setTimeout(() => {
          navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
        }, 1200);
      }
    });

    const unsubTakeover = socketService.on('whatsapp.session_taken_over', (data: any) => {
      const msg =
        data?.message ||
        'Your WhatsApp connection was disconnected because another device logged in and took over the connection.';
      if (Platform.OS === 'web') {
        window.alert(`[WhatsApp Disconnected]\n\n${msg}`);
      } else {
        Alert.alert('WhatsApp Disconnected', msg);
      }
      setStatus('DISCONNECTED');
      setQrCode(null);
      setPairingCode(null);
      setSyncProgress(null);
      setAlreadyConnectedDevice(null);
    });

    const unsubSyncProgress = socketService.on('sync:progress', (data) => {
      if (!data || data.status === 'IDLE') {
        setSyncProgress(null);
      } else {
        setSyncProgress(data);
      }
    });

    const unsubSync = socketService.on('whatsapp.sync', (data) => {
      if (!data || data.stage === 'idle') {
        setSyncProgress(null);
        return;
      }
      if (data.syncState) {
        setSyncProgress(data.syncState);
      } else {
        setSyncProgress((prev: any) => ({
          ...(prev || {}),
          stage: data.stage,
          progress: data.progress,
          message: data.message,
        }));
      }
      if (data.stage === 'completed' || data.progress === 100) {
        setTimeout(() => {
          navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
        }, 1200);
      }
    });

    const unsubDataReset = socketService.on('whatsapp:data_reset', () => {
      setStatus('DISCONNECTED');
      setSyncProgress(null);
      setQrCode(null);
      setPairingCode(null);
      setAlreadyConnectedDevice(null);
    });

    return () => {
      unsubStatus();
      unsubTakeover();
      unsubSyncProgress();
      unsubSync();
      unsubDataReset();
    };
  }, [navigation, method]);

  const handleRequestPairingCode = async () => {
    if (!phoneNumber.trim() || phoneNumber.trim().length < 10) {
      const msg = 'Please enter a valid phone number with country code e.g. +919876543210';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Invalid Phone Number', msg);
      return;
    }

    setLoading(true);
    setPairingCode(null);
    try {
      const res: any = await apiClient.post('/whatsapp/pairing-code', {
        phoneNumber: phoneNumber.trim(),
      });
      setStatus(res.status || 'PAIRING_CODE_PENDING');
      if (res.pairingCode) setPairingCode(res.pairingCode);
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.response?.data?.alreadyConnected) {
        setStatus('ALREADY_CONNECTED_ON_OTHER_DEVICE');
        setAlreadyConnectedDevice(err?.response?.data?.connectedDevice || null);
      } else {
        const errMsg = err.message || 'Failed to request pairing code from WhatsApp';
        if (Platform.OS === 'web') window.alert(errMsg);
        else Alert.alert('Pairing Code Error', errMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadgeStyle = () => {
    switch (status) {
      case 'CONNECTED':
      case 'READY':
        return styles.badgeConnected;
      case 'AUTHENTICATING':
      case 'SYNCING':
        return styles.badgeSyncing;
      case 'QR_PENDING':
      case 'PAIRING_CODE_PENDING':
        return styles.badgePending;
      case 'ALREADY_CONNECTED_ON_OTHER_DEVICE':
        return styles.badgeConflict;
      default:
        return styles.badgeDisconnected;
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={{ alignItems: "center", marginBottom: 10 }}>
          <Sticker name="qr" size={150} />
        </View>
        <View style={[styles.badge, getStatusBadgeStyle()]}>
          <Text style={styles.badgeText}>Status: {status.toUpperCase().replace(/_/g, ' ')}</Text>
        </View>
        <Text style={styles.title}>Connect WhatsApp</Text>
        <Text style={styles.subtitle}>
          Link your WhatsApp account to enable real-time messaging and Gemini AI intelligence
        </Text>
      </View>

      {/* Data retention: first thing the user decides, before linking */}
      <View style={styles.retentionCard}>
        <Text style={styles.retentionTitle}>🔒 Data Retention Policy</Text>
        <Text style={styles.retentionSub}>
          Choose how much of your WhatsApp data is stored in the app. Messages older than this are removed automatically.
        </Text>
        <View style={styles.retentionGrid}>
          {Array.from(new Set([...RETENTION_CHOICES, retentionDays]))
            .sort((a, b) => a - b)
            .map((days) => {
              const active = retentionDays === days;
              const locked = status === 'CONNECTED' || status === 'READY' || status === 'SYNCING';
              return (
                <TouchableOpacity
                  key={days}
                  style={[styles.retentionPill, active && styles.retentionPillActive, locked && { opacity: 0.6 }]}
                  onPress={() => chooseRetention(days)}
                  disabled={locked}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.retentionPillDays, active && styles.retentionPillDaysActive]}>
                    {days >= 365 ? '365 Days' : `${days} Days`}
                  </Text>
                  <Text style={[styles.retentionPillSub, active && styles.retentionPillSubActive]}>
                    {getRetentionSubtext(days)}
                  </Text>
                </TouchableOpacity>
              );
            })}
        </View>
        <Text style={styles.retentionHint}>
          Shorter is faster and more private. You can change this anytime in Settings.
        </Text>
        {retentionError && <Text style={[styles.retentionHint, { color: '#DC2626' }]}>{retentionError}</Text>}
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[
            styles.tabButton,
            method === 'PAIRING_CODE' && styles.tabButtonActive,
          ]}
          onPress={() => {
            setMethod('PAIRING_CODE');
          }}
        >
          <Text
            style={[
              styles.tabText,
              method === 'PAIRING_CODE' && styles.tabTextActive,
            ]}
          >
            Phone Number Pairing
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, method === 'QR' && styles.tabButtonActive]}
          onPress={() => {
            setMethod('QR');
            fetchStatusAndConnect('QR');
          }}
        >
          <Text style={[styles.tabText, method === 'QR' && styles.tabTextActive]}>
            Scan QR Code
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.card}>
        {!(alreadyConnectedDevice || status === 'ALREADY_CONNECTED_ON_OTHER_DEVICE') && (
          <View style={styles.noteBox}>
            <Text style={styles.noteText}>
              {method === 'QR'
                ? '💡 Note: to link, open WhatsApp on your phone → Settings → Linked devices → Link a device, then scan the QR code below. The code refreshes by itself if it expires.'
                : '💡 Note: enter your number to get a pairing code. Then open WhatsApp on your phone → Settings → Linked devices → Link a device → Link with phone number, and type the code. Do not share this code with anyone.'}
            </Text>
          </View>
        )}
        {alreadyConnectedDevice || status === 'ALREADY_CONNECTED_ON_OTHER_DEVICE' ? (
          <View style={styles.conflictCard}>
            <View style={styles.conflictIconBadge}>
              <Text style={styles.conflictIcon}>🔒</Text>
            </View>
            <Text style={styles.conflictTitle}>WhatsApp Already Connected</Text>
            <Text style={styles.conflictSubtitle}>
              Another device or browser session is already actively connected to WhatsApp using this account.
            </Text>

            <View style={styles.conflictDetailsBox}>
              <View style={styles.conflictDetailRow}>
                <Text style={styles.conflictDetailLabel}>Connected WhatsApp Number:</Text>
                <Text style={styles.conflictPhoneValue}>
                  📱 {alreadyConnectedDevice?.phoneNumber || 'Active Number'}
                </Text>
              </View>

              <View style={styles.conflictDetailRow}>
                <Text style={styles.conflictDetailLabel}>Logged-in Device:</Text>
                <Text style={styles.conflictDetailValue}>
                  💻 {alreadyConnectedDevice?.deviceInfo || 'Another Web / Mobile Session'}
                </Text>
              </View>

              {alreadyConnectedDevice?.connectedAt && (
                <View style={styles.conflictDetailRow}>
                  <Text style={styles.conflictDetailLabel}>Connected Since:</Text>
                  <Text style={styles.conflictDetailSubValue}>
                    🕒 {new Date(alreadyConnectedDevice.connectedAt).toLocaleString()}
                  </Text>
                </View>
              )}
            </View>

            <Text style={styles.conflictNotice}>
              Single connection policy: WhatsApp only allows one active session per account at a time.
            </Text>

            <View style={styles.conflictActionButtons}>
              <TouchableOpacity
                style={styles.takeoverButton}
                onPress={handleForceTakeover}
                disabled={loading}
              >
                {loading ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <Text style={styles.takeoverButtonText}>
                    ⚡ Disconnect Other Device & Connect Here
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.viewOnlyButton}
                onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Main' }] })}
              >
                <Text style={styles.viewOnlyButtonText}>Continue to Dashboard (View Only) →</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.refreshButton}
                onPress={() => fetchStatusAndConnect(method)}
                disabled={loading}
              >
                <Text style={styles.refreshButtonText}>🔄 Check Again / Refresh</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.conflictLogoutButton}
                onPress={handleLogout}
                disabled={loading}
              >
                <Text style={styles.conflictLogoutButtonText}>🚪 Log Out of Account</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : method === 'QR' ? (
          loading && !qrCode ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.loadingText}>Connecting to WhatsApp Web servers...</Text>
            </View>
          ) : qrCode ? (
            <View style={styles.qrContainer}>
              <Image source={{ uri: qrCode }} style={styles.qrImage} />
              <Text style={styles.instructions}>
                1. Open WhatsApp on your phone{'\n'}
                2. Tap Menu / Settings → Linked Devices{'\n'}
                3. Tap <Text style={styles.boldText}>Link a Device</Text> and scan this code
              </Text>
            </View>
          ) : (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={Colors.primary} />
              <Text style={styles.loadingText}>Waiting for QR code generation...</Text>
            </View>
          )
        ) : (
          <View style={styles.pairingContainer}>
            <Text style={styles.pairingLabel}>Enter your WhatsApp phone number:</Text>
            <TextInput
              style={styles.phoneInput}
              placeholder="+91 98765 43210"
              placeholderTextColor={Colors.textMuted}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
              keyboardType="phone-pad"
              autoCapitalize="none"
            />
            <TouchableOpacity
              style={[styles.requestButton, loading && styles.buttonDisabled]}
              onPress={handleRequestPairingCode}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <Text style={styles.requestButtonText}>Get Official Pairing Code</Text>
              )}
            </TouchableOpacity>

            {pairingCode && (
              <View style={styles.codeBoxContainer}>
                <Text style={styles.codeInstructionTitle}>Your Official WhatsApp Pairing Code:</Text>
                <View style={styles.codeBox}>
                  <Text style={styles.codeText}>{pairingCode}</Text>
                </View>
                <Text style={styles.instructions}>
                  1. Open WhatsApp on your mobile phone{'\n'}
                  2. Tap Menu / Settings → Linked Devices → <Text style={styles.boldText}>Link with Phone Number</Text>{'\n'}
                  3. Enter the 8-character code shown above
                </Text>
              </View>
            )}
          </View>
        )}

        {syncProgress && (status === 'CONNECTED' || status === 'SYNCING' || status === 'AUTHENTICATING') && (
          <View style={styles.syncBox}>
            <View style={styles.progressHeader}>
              <Text style={styles.syncStage}>{syncProgress.message || 'Synchronizing with WhatsApp...'}</Text>
              <Text style={styles.syncPercent}>{syncProgress.progress || 0}%</Text>
            </View>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, Math.max(0, syncProgress.progress || 0))}%` },
                ]}
              />
            </View>

            <View style={styles.stageListContainer}>
              {[
                { label: 'Contacts', data: syncProgress.contacts, count: syncProgress.contactsCount },
                { label: 'Groups', data: syncProgress.groups, count: syncProgress.groupsCount },
                { label: 'Chats', data: syncProgress.conversations, count: syncProgress.chatsCount },
                { label: 'Messages', data: syncProgress.messages, count: syncProgress.messagesCount },
                { label: 'AI Extraction', data: syncProgress.aiExtraction, count: syncProgress.aiExtractionCount },
                { label: 'AI Analysis', data: syncProgress.aiAnalysis, count: syncProgress.aiAnalysisCount },
              ].map((stage) => {
                const pct = Math.min(100, Math.max(0, stage.data?.percentage ?? (stage.count && stage.count > 0 ? 100 : 0)));
                const displayCount = stage.data && stage.data.total > 0
                  ? `${stage.data.processed} / ${stage.data.total}`
                  : stage.count !== undefined ? `${stage.count}` : `${pct}%`;
                return (
                  <View style={styles.stageRow} key={stage.label}>
                    <View style={styles.stageLabelRow}>
                      <Text style={styles.stageLabel}>{stage.label}</Text>
                      <Text style={styles.stageCount}>
                        {displayCount} {pct === 100 ? '✓' : `(${pct}%)`}
                      </Text>
                    </View>
                    <View style={styles.stageBarBg}>
                      <View style={[styles.stageBarFill, { width: `${pct}%` }]} />
                    </View>
                  </View>
                );
              })}
            </View>

            <Text style={styles.processedSummaryText}>
              📊 {syncProgress.messagesCount || 0} messages processed within retention window
            </Text>
            <Text style={styles.keepConnectedNotice}>Please keep the app connected.</Text>

            <TouchableOpacity
              style={styles.bgContinueButton}
              onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Main' }] })}
            >
              <Text style={styles.bgContinueButtonText}>Continue to App (Runs in Background) →</Text>
            </TouchableOpacity>
          </View>
        )}

        {(status === 'CONNECTED' || status === 'READY') && !syncProgress && (
          <TouchableOpacity
            style={styles.continueButton}
            onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Main' }] })}
          >
            <Text style={styles.continueButtonText}>✓ Connected — Continue to Dashboard →</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  retentionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 18,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#D1FAE5',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  retentionTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginBottom: 4 },
  retentionSub: { fontSize: 13, color: '#475569', lineHeight: 18, marginBottom: 14 },
  retentionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'space-between',
  },
  retentionPill: {
    width: '31%',
    minHeight: 56,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retentionPillActive: {
    backgroundColor: '#005D4B',
    borderColor: '#005D4B',
    elevation: 2,
    shadowColor: '#005D4B',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  retentionPillDays: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E293B',
    textAlign: 'center',
  },
  retentionPillDaysActive: {
    color: '#FFFFFF',
  },
  retentionPillSub: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 2,
    textAlign: 'center',
  },
  retentionPillSubActive: {
    color: '#A7F3D0',
  },
  retentionHint: { fontSize: 12, color: '#64748B', marginTop: 12, lineHeight: 16 },
  noteBox: {
    backgroundColor: '#FEF9C3',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  noteText: { fontSize: 13, color: '#713F12', lineHeight: 18 },
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 10,
  },
  badge: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 20,
    marginBottom: 10,
  },
  badgePending: {
    backgroundColor: '#FEF3C7',
  },
  badgeSyncing: {
    backgroundColor: '#E0F2FE',
  },
  badgeConnected: {
    backgroundColor: '#DCFCE7',
  },
  badgeConflict: {
    backgroundColor: '#FEE2E2',
    borderColor: '#DC2626',
    borderWidth: 1,
  },
  badgeDisconnected: {
    backgroundColor: '#FEE2E2',
  },
  badgeText: {
    color: Colors.text,
    fontWeight: '700',
    fontSize: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: Colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 6,
    paddingHorizontal: 16,
  },
  tabRow: {
    flexDirection: 'row',
    backgroundColor: '#EEF2F6',
    borderRadius: 12,
    padding: 4,
    marginBottom: 20,
  },
  tabButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabButtonActive: {
    backgroundColor: '#FFF',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  tabText: {
    fontWeight: '600',
    color: Colors.textMuted,
    fontSize: 14,
  },
  tabTextActive: {
    color: Colors.primary,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  loadingContainer: {
    height: 220,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    color: Colors.textMuted,
    fontSize: 14,
  },
  qrContainer: {
    alignItems: 'center',
    marginBottom: 16,
  },
  qrImage: {
    width: 230,
    height: 230,
    borderRadius: 12,
    marginBottom: 16,
  },
  pairingContainer: {
    alignItems: 'center',
    width: '100%',
    marginBottom: 10,
  },
  pairingLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  phoneInput: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: Colors.text,
    marginBottom: 14,
  },
  requestButton: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  requestButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },
  codeBoxContainer: {
    alignItems: 'center',
    width: '100%',
    marginTop: 10,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#F3F6F8',
  },
  codeInstructionTitle: {
    fontSize: 14,
    color: Colors.textMuted,
    marginBottom: 10,
  },
  codeBox: {
    backgroundColor: '#F1F5F9',
    borderWidth: 2,
    borderColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    marginBottom: 16,
  },
  codeText: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 4,
    color: Colors.primary,
  },
  instructions: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 8,
  },
  boldText: {
    fontWeight: '700',
    color: Colors.text,
  },
  syncBox: {
    width: '100%',
    backgroundColor: '#E6F4F1',
    borderRadius: 10,
    padding: 12,
    marginTop: 16,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  syncStage: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.primary,
  },
  syncPercent: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.secondary,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#BFE3DC',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.secondary,
  },
  continueButton: {
    marginTop: 16,
    backgroundColor: Colors.secondary,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 20,
    width: '100%',
    alignItems: 'center',
  },
  continueButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },
  syncStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 6,
  },
  syncStatBadge: {
    flex: 1,
    backgroundColor: '#FFF',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#BFE3DC',
  },
  syncStatLabel: {
    fontSize: 10,
    color: Colors.textMuted,
    fontWeight: '600',
    textAlign: 'center',
  },
  syncStatVal: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
    marginTop: 2,
    textAlign: 'center',
  },
  stageListContainer: {
    marginTop: 14,
    gap: 8,
  },
  stageRow: {
    backgroundColor: '#FFF',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  stageLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  stageLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.text,
  },
  stageCount: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.primary,
  },
  stageBarBg: {
    height: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: 3,
    overflow: 'hidden',
  },
  stageBarFill: {
    height: '100%',
    backgroundColor: Colors.secondary,
    borderRadius: 3,
  },
  processedSummaryText: {
    marginTop: 12,
    fontSize: 12,
    fontWeight: '600',
    color: '#0F766E',
    textAlign: 'center',
    backgroundColor: '#F0FDFA',
    paddingVertical: 6,
    borderRadius: 6,
  },
  keepConnectedNotice: {
    marginTop: 6,
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  bgContinueButton: {
    marginTop: 14,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  bgContinueButtonText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '700',
  },
  conflictCard: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 12,
  },
  conflictIconBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  conflictIcon: {
    fontSize: 32,
  },
  conflictTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#991B1B',
    textAlign: 'center',
    marginBottom: 8,
  },
  conflictSubtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 18,
    paddingHorizontal: 12,
  },
  conflictDetailsBox: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  conflictDetailRow: {
    flexDirection: 'column',
    gap: 4,
  },
  conflictDetailLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  conflictPhoneValue: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.primary,
    letterSpacing: 0.5,
  },
  conflictDetailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
  },
  conflictDetailSubValue: {
    fontSize: 13,
    color: Colors.textMuted,
  },
  conflictNotice: {
    fontSize: 12,
    color: '#78716C',
    textAlign: 'center',
    lineHeight: 16,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  conflictActionButtons: {
    width: '100%',
    gap: 10,
  },
  takeoverButton: {
    backgroundColor: '#DC2626',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#DC2626',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 2,
  },
  takeoverButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  viewOnlyButton: {
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  viewOnlyButtonText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  refreshButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  refreshButtonText: {
    color: Colors.primary,
    fontSize: 13,
    fontWeight: '600',
  },
  headerLogoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: 8,
    marginRight: 4,
  },
  headerLogoutText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  conflictLogoutButton: {
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FECACA',
    marginTop: 4,
  },
  conflictLogoutButtonText: {
    color: '#DC2626',
    fontSize: 13,
    fontWeight: '700',
  },
});
