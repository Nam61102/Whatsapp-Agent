import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  Alert,
  Platform,
  TextInput,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { clearFirstSync } from '../../shared/utils/firstSync';
import { AuthStorage } from '../../shared/services/authStorage';
import { socketService } from '../../shared/services/socket';
import { SyncProgressBar } from '../../shared/components/SyncProgressBar';
import { IconText } from '../../shared/components/IconText';
import { Avatar } from '../../shared/components/Avatar';
import { Sticker } from '../../shared/components/Sticker';

const RETENTION_OPTIONS = [3, 7, 15, 30, 60, 90];

export const SettingsScreen = ({ navigation }: any) => {
  const [user, setUser] = useState<any>(AuthStorage.getUser());
  const [waStatus, setWaStatus] = useState<any>(null);
  const [settings, setSettings] = useState<any>({
    retentionDays: 3,
    autoAIAnalysis: true,
    notificationsEnabled: true,
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{
    stage: string;
    progress: number;
    message: string;
    status: string;
  } | null>(null);

  const maxProgressRef = useRef(0);
  const completedTimeoutRef = useRef<any>(null);

  const handleSyncProgressEvent = useCallback((data: any) => {
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
    }
  }, []);

  useEffect(() => {
    loadData();

    const unsubs = [
      socketService.on('whatsapp:stats', (data: any) => {
        setWaStatus((prev: any) => {
          if (!prev) return prev;
          const currentStats = prev.stats || {};
          return {
            ...prev,
            stats: {
              ...currentStats,
              messages: (currentStats.messages || 0) + (data?.messageIncrement || 1),
            },
          };
        });
      }),
      socketService.on('message:new', () => {
        setWaStatus((prev: any) => {
          if (!prev || !prev.stats) return prev;
          return {
            ...prev,
            stats: {
              ...prev.stats,
              messages: (prev.stats.messages || 0) + 1,
            },
          };
        });
      }),
      socketService.on('whatsapp.status', (data: any) => {
        if (data?.stats) {
          setWaStatus((prev: any) => ({ ...prev, ...data }));
        }
      }),
      socketService.on('sync:progress', handleSyncProgressEvent),
      socketService.on('whatsapp.sync', (data: any) => {
        handleSyncProgressEvent(data);
      }),
      socketService.on('whatsapp:data_reset', () => {
        setSyncProgress(null);
        maxProgressRef.current = 0;
        loadData();
      }),
    ];

    return () => {
      unsubs.forEach((u) => {
        if (typeof u === 'function') u();
      });
      if (completedTimeoutRef.current) clearTimeout(completedTimeoutRef.current);
    };
  }, [handleSyncProgressEvent]);

  const loadData = async () => {
    try {
      const results = await Promise.allSettled([
        apiClient.get('/whatsapp/status'),
        apiClient.get('/settings'),
        apiClient.get('/auth/me'),
      ]);

      if (results[0].status === 'fulfilled') {
        setWaStatus(results[0].value);
      }
      if (results[1].status === 'fulfilled') {
        setSettings(results[1].value);
      }
      if (results[2].status === 'fulfilled') {
        const meRes = results[2].value;
        setUser(meRes);
        AuthStorage.setUser(meRes);
      }
    } catch (err) {
      console.error('Failed to load settings data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateRetention = async (days: number) => {
    try {
      const updated: any = await apiClient.patch('/settings', { retentionDays: days });
      setSettings(updated);
    } catch (err) {
      console.error('Failed to update retention:', err);
    }
  };

  const handleToggleAI = async (val: boolean) => {
    try {
      const updated: any = await apiClient.patch('/settings', { autoAIAnalysis: val });
      setSettings(updated);
    } catch (err) {
      console.error('Failed to update AI toggle:', err);
    }
  };

  const handleToggleNotifications = async (val: boolean) => {
    try {
      const updated: any = await apiClient.patch('/settings', { notificationsEnabled: val });
      setSettings(updated);
    } catch (err) {
      console.error('Failed to update notification toggle:', err);
    }
  };

  const doResync = async () => {
    setSyncing(true);
    try {
      const res: any = await apiClient.post('/whatsapp/resync', {}, { timeout: 120000 });
      await loadData();
      if (Platform.OS === 'web') {
        window.alert(res?.message || 'WhatsApp data re-synchronized successfully!');
      } else {
        Alert.alert('Re-sync Complete', res?.message || 'WhatsApp data re-synchronized successfully!');
      }
    } catch (err: any) {
      if (Platform.OS === 'web') {
        window.alert('Re-sync Error: ' + (err.message || 'Failed to re-sync'));
      } else {
        Alert.alert('Re-sync Error', err.message);
      }
    } finally {
      setSyncing(false);
    }
  };

  const handleResyncData = () => {
    const msg =
      'This will refresh and synchronize latest contacts, groups, and conversations from WhatsApp. Your connection will NOT be unlinked. Continue?';
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        doResync();
      }
    } else {
      Alert.alert('Re-sync WhatsApp Data', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Re-sync Now', onPress: doResync },
      ]);
    }
  };

  const doResetData = async () => {
    // Non-blocking: the backend returns immediately and streams progress via sockets.
    // Show the sync bar right away so the user sees instant feedback.
    maxProgressRef.current = 0;
    setSyncProgress({
      stage: 'CLEARING',
      progress: 5,
      message: 'Clearing all synced data...',
      status: 'SYNCING',
    });
    try {
      const res: any = await apiClient.post('/whatsapp/reset-synced-data', {}, { timeout: 15000 });
      // Refresh stats without blocking the UI
      loadData().catch(() => {});
      const notice = res?.message || 'Clearing data and fetching fresh WhatsApp data (newest first)...';
      if (Platform.OS === 'web') {
        console.log('[reset-synced-data]', notice);
      } else {
        // Toast-style, non-blocking on native
        Alert.alert('Clearing Data', notice);
      }
    } catch (err: any) {
      setSyncProgress(null);
      if (Platform.OS === 'web') {
        window.alert('Reset Error: ' + (err.message || 'Failed to reset data'));
      } else {
        Alert.alert('Reset Error', err.message);
      }
    }
  };

  const handleResetSyncedData = () => {
    const msg =
      'All synced chats, contacts, groups, and AI extractions will be permanently deleted and WhatsApp will be re-fetched (newest messages first). Your WhatsApp session stays connected. Continue?';
    if (Platform.OS === 'web') {
      if (window.confirm(msg)) {
        doResetData();
      }
    } else {
      Alert.alert('Clear & Re-sync Data', msg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear & Re-sync', style: 'destructive', onPress: doResetData },
      ]);
    }
  };

  const doDisconnect = async () => {
    try {
      setLoading(true);
      await apiClient.post('/whatsapp/disconnect', {}, { timeout: 120000 });
      await clearFirstSync(); // linking again is a new first time
      const me: any = await apiClient.get('/auth/me').catch(() => null);
      if (me) {
        await AuthStorage.setUser(me);
      }
      navigation.reset({ index: 0, routes: [{ name: 'WhatsAppConnect' }] });
    } catch (err: any) {
      if (Platform.OS === 'web') {
        window.alert('Disconnect Error: ' + (err.message || 'Failed to disconnect WhatsApp'));
      } else {
        Alert.alert('Error', err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = () => {
    if (Platform.OS === 'web') {
      const confirmed = window.confirm('Are you sure you want to unlink your WhatsApp account?');
      if (confirmed) {
        doDisconnect();
      }
    } else {
      Alert.alert(
        'Disconnect WhatsApp',
        'Are you sure you want to unlink your WhatsApp account?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disconnect',
            style: 'destructive',
            onPress: doDisconnect,
          },
        ]
      );
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    try {
      await apiClient.post('/whatsapp/disconnect', {}, { timeout: 120000 }).catch(() => {});
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

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* User Profile Card */}
      <View style={styles.card}>
        <View style={styles.profileRow}>
          <Avatar name={user?.name || user?.email} uri={user?.avatarUrl} size={54} style={{ marginRight: 14 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>{user?.name || user?.email || 'User'}</Text>
            <Text style={styles.userEmail}>{user?.email}</Text>
          </View>
          <Sticker name="robot" size={54} />
        </View>
      </View>

      {/* WhatsApp Connection Status Card */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <IconText icon="phone-portrait" style={styles.cardTitle}>WhatsApp Integration</IconText>
          <Sticker name="qr" size={42} />
        </View>
        <View style={styles.statusRow}>
          <Text style={styles.statusLabel}>Connection Status:</Text>
          <View style={styles.statusTag}>
            <Text style={styles.statusTagText}>
              {(waStatus?.status || 'CONNECTED').toUpperCase()}
            </Text>
          </View>
        </View>

        {(waStatus?.phoneNumber || waStatus?.phone) && (
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Linked Number:</Text>
            <Text style={styles.statusVal}>{waStatus.phoneNumber || waStatus.phone}</Text>
          </View>
        )}

        {waStatus?.stats && (
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{waStatus.stats.contacts || 0}</Text>
              <Text style={styles.statLbl}>Contacts</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{waStatus.stats.groups || 0}</Text>
              <Text style={styles.statLbl}>Groups</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{waStatus.stats.chats || 0}</Text>
              <Text style={styles.statLbl}>Chats</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{waStatus.stats.messages || 0}</Text>
              <Text style={styles.statLbl}>Messages</Text>
            </View>
          </View>
        )}

        {syncProgress && (
          <SyncProgressBar
            progress={syncProgress.progress}
            stage={syncProgress.stage}
            message={syncProgress.message}
            status={syncProgress.status}
          />
        )}

        <TouchableOpacity
          style={[styles.syncButton, syncing && styles.buttonDisabled]}
          onPress={handleResyncData}
          disabled={syncing}
        >
          <Text style={styles.syncButtonText}>
            {syncing ? '↻ Re-syncing Data...' : '↻ Re-sync WhatsApp Data'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.resetDataButton}
          onPress={handleResetSyncedData}
          disabled={loading || syncing}
        >
          <IconText center icon="brush" style={styles.resetDataText}>Clear Synced Application Data</IconText>
        </TouchableOpacity>

        <TouchableOpacity style={styles.disconnectButton} onPress={handleDisconnect}>
          <Text style={styles.disconnectText}>Unlink WhatsApp Account</Text>
        </TouchableOpacity>
      </View>

      {/* Data Retention Card */}
      <View style={styles.card}>
        <IconText icon="lock-closed" style={styles.cardTitle}>Data Retention Policy</IconText>
        <Text style={styles.cardSub}>
          Per production security standards, raw WhatsApp messages past the retention period are purged from the database, while derived AI extractions and summaries are retained.
        </Text>

        <View style={styles.retentionRow}>
          {RETENTION_OPTIONS.map((days) => (
            <TouchableOpacity
              key={days}
              style={[
                styles.retentionPill,
                settings?.retentionDays === days && styles.retentionPillActive,
              ]}
              onPress={() => handleUpdateRetention(days)}
            >
              <Text
                style={[
                  styles.retentionText,
                  settings?.retentionDays === days && styles.retentionTextActive,
                ]}
              >
                {days} Days
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* AI Analysis Card */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={styles.cardTitle}>🤖 AI Analysis</Text>
          <Sticker name="brain" size={40} />
        </View>
        <Text style={styles.cardSub}>
          Automatically analyze your WhatsApp messages for important information and generate useful AI reply suggestions.
        </Text>

        <View style={styles.toggleRow}>
          <Text style={styles.toggleTitle}>Automatic AI Analysis</Text>
          <Switch
            value={settings?.autoAIAnalysis ?? true}
            onValueChange={handleToggleAI}
            trackColor={{ false: '#D1D5DB', true: Colors.accent }}
          />
        </View>
      </View>

      {/* Logout Button */}
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Text style={styles.logoutButtonText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: Colors.cardBackground,
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  avatarText: {
    color: '#FFF',
    fontSize: 22,
    fontWeight: '700',
  },
  userName: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.text,
  },
  userEmail: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 8,
  },
  cardSub: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
    marginBottom: 14,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusLabel: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  statusTag: {
    backgroundColor: '#E6F4F1',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusTagText: {
    color: Colors.primaryDark,
    fontSize: 12,
    fontWeight: '700',
  },
  statusVal: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 10,
    marginBottom: 14,
  },
  statBox: {
    alignItems: 'center',
    flex: 1,
  },
  statNum: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.primaryDark,
  },
  statLbl: {
    fontSize: 11,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  syncButton: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  syncButtonText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
  resetDataButton: {
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  resetDataText: {
    color: '#4B5563',
    fontWeight: '600',
    fontSize: 13,
  },
  disconnectButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  disconnectText: {
    color: Colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  retentionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  retentionPill: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#F3F6F8',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  retentionPillActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  retentionText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  retentionTextActive: {
    color: '#FFF',
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 6,
  },
  toggleInfo: {
    flex: 1,
    marginRight: 12,
  },
  toggleTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.text,
  },
  toggleSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  logoutButton: {
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  logoutButtonText: {
    color: Colors.danger,
    fontSize: 15,
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  tokenBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  tokenRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  tokenLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
  tokenStatusBadge: {
    fontSize: 10,
    fontWeight: '800',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  badgeNormal: {
    backgroundColor: '#D1FAE5',
    color: '#08463E',
  },
  badgePaused: {
    backgroundColor: '#FEE2E2',
    color: '#991B1B',
  },
  tokenTrack: {
    height: 8,
    backgroundColor: '#E2E8F0',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 6,
  },
  tokenFill: {
    height: '100%',
    borderRadius: 4,
  },
  tokenRowMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tokenCount: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  tokenPct: {
    fontSize: 12,
    color: Colors.text,
    fontWeight: '700',
  },
  warningBox: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  warningTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#991B1B',
    marginBottom: 2,
  },
  warningText: {
    fontSize: 11,
    color: '#7F1D1D',
    lineHeight: 16,
  },
  limitInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
    backgroundColor: '#F1F5F9',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  limitLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
  },
  limitInput: {
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
    width: 110,
    textAlign: 'right',
  },
});
