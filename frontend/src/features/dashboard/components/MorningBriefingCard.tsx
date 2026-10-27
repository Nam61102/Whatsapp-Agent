import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../../shared/theme/colors';
import { apiClient } from '../../../shared/services/api';
import { openGoogleCalendar } from '../../../shared/utils/calendarSync';

interface PriorityItem {
  id: string;
  type: string;
  title: string;
  description: string;
  source: string;
  priority: string;
  eventDate?: Date | string | null;
}

interface MorningBriefingData {
  success: boolean;
  greeting: string;
  dateFormatted: string;
  summary: string;
  metrics: {
    pendingTasks: number;
    events: number;
    recentTransfers: number;
  };
  priorityItems: PriorityItem[];
  aiTip: string;
  generatedAt: string;
}

interface MorningBriefingCardProps {
  onNavigateToActionCenter?: () => void;
  refreshTrigger?: number;
}

export const MorningBriefingCard: React.FC<MorningBriefingCardProps> = ({
  onNavigateToActionCenter,
  refreshTrigger = 0,
}) => {
  const [data, setData] = useState<MorningBriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const fetchBriefing = useCallback(async (force = false) => {
    try {
      setLoading(true);
      const url = force ? '/api/v1/ai/morning-briefing?refresh=true' : '/api/v1/ai/morning-briefing';
      const res: any = await apiClient.get(url);
      if (res && res.success) {
        setData(res);
      }
    } catch {
      // Graceful fallback - never crash the dashboard
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBriefing(false);
  }, [fetchBriefing]);

  useEffect(() => {
    if (refreshTrigger > 0) {
      fetchBriefing(true);
    }
  }, [refreshTrigger, fetchBriefing]);

  if (dismissed || (!data && !loading)) {
    return null;
  }

  if (loading && !data) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="small" color={Colors.primary} />
        <Text style={styles.loadingText}>Preparing morning briefing...</Text>
      </View>
    );
  }

  if (!data) return null;

  return (
    <View style={styles.cardContainer}>
      {/* Top Banner Row */}
      <View style={styles.headerRow}>
        <View style={styles.sunBadge}>
          <Text style={styles.sunBadgeIcon}>☀️</Text>
          <Text style={styles.sunBadgeText}>AI MORNING BRIEFING</Text>
        </View>
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={() => setDismissed(true)}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="close" size={16} color="#64748B" />
        </TouchableOpacity>
      </View>

      {/* Greeting & Date */}
      <View style={styles.greetingSection}>
        <Text style={styles.greetingTitle}>{data.greeting}</Text>
        <Text style={styles.dateSubtitle}>{data.dateFormatted}</Text>
      </View>

      {/* AI Overview Summary */}
      {data.summary ? (
        <View style={styles.summaryBox}>
          <Text style={styles.summaryText}>{data.summary}</Text>
        </View>
      ) : null}

      {/* Metrics Row */}
      <View style={styles.metricsRow}>
        <View style={[styles.metricChip, { backgroundColor: '#FEF3C7', borderColor: '#FDE68A' }]}>
          <Text style={styles.metricEmoji}>📝</Text>
          <View>
            <Text style={[styles.metricValue, { color: '#92400E' }]}>
              {data.metrics?.pendingTasks ?? 0}
            </Text>
            <Text style={[styles.metricLabel, { color: '#B45309' }]}>Tasks</Text>
          </View>
        </View>

        <View style={[styles.metricChip, { backgroundColor: '#E0F2FE', borderColor: '#BAE6FD' }]}>
          <Text style={styles.metricEmoji}>📅</Text>
          <View>
            <Text style={[styles.metricValue, { color: '#0369A1' }]}>
              {data.metrics?.events ?? 0}
            </Text>
            <Text style={[styles.metricLabel, { color: '#0284C7' }]}>Events</Text>
          </View>
        </View>

        <View style={[styles.metricChip, { backgroundColor: '#DCFCE7', borderColor: '#BBF7D0' }]}>
          <Text style={styles.metricEmoji}>💳</Text>
          <View>
            <Text style={[styles.metricValue, { color: '#15803D' }]}>
              ₹{data.metrics?.recentTransfers ?? 350}
            </Text>
            <Text style={[styles.metricLabel, { color: '#16A34A' }]}>Transfers</Text>
          </View>
        </View>
      </View>

      {/* Priority Action Items */}
      {data.priorityItems && data.priorityItems.length > 0 && (
        <View style={styles.prioritySection}>
          <View style={styles.priorityHeaderRow}>
            <Text style={styles.prioritySectionTitle}>Today's Focus</Text>
            {onNavigateToActionCenter && (
              <TouchableOpacity onPress={onNavigateToActionCenter}>
                <Text style={styles.seeAllText}>Action Center ›</Text>
              </TouchableOpacity>
            )}
          </View>

          {data.priorityItems.slice(0, 3).map((item) => {
            const isEvent =
              item.type === 'MEETING' || item.type === 'EVENT' || item.type === 'APPOINTMENT' || !!item.eventDate;

            return (
              <View key={item.id} style={styles.priorityItemCard}>
                <View style={styles.priorityItemContent}>
                  <View style={styles.priorityItemTop}>
                    <Text style={styles.prioritySourceText} numberOfLines={1}>
                      {item.source}
                    </Text>
                    <View style={styles.typeTag}>
                      <Text style={styles.typeTagText}>{item.type || 'TASK'}</Text>
                    </View>
                  </View>
                  <Text style={styles.priorityTitleText} numberOfLines={2}>
                    {item.title}
                  </Text>
                </View>

                {isEvent && (
                  <TouchableOpacity
                    style={styles.calendarQuickBtn}
                    onPress={() =>
                      openGoogleCalendar({
                        title: item.title,
                        description: item.description,
                        startDate: item.eventDate,
                      })
                    }
                  >
                    <Ionicons name="calendar-outline" size={14} color="#0284C7" />
                    <Text style={styles.calendarQuickBtnText}>Sync</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* AI Productivity Tip */}
      {data.aiTip ? (
        <View style={styles.tipBox}>
          <Ionicons name="bulb-outline" size={15} color="#D97706" style={{ marginRight: 6, marginTop: 1 }} />
          <Text style={styles.tipText}>
            <Text style={{ fontWeight: '700' }}>Tip: </Text>
            {data.aiTip}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  loadingContainer: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FEF3C7',
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    color: '#92400E',
    fontWeight: '500',
  },
  cardContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#FDE68A',
    shadowColor: '#F59E0B',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  sunBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFBEB',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  sunBadgeIcon: {
    fontSize: 13,
    marginRight: 6,
  },
  sunBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#B45309',
    letterSpacing: 0.5,
  },
  closeBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  greetingSection: {
    marginBottom: 8,
  },
  greetingTitle: {
    fontSize: 19,
    fontWeight: '800',
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  dateSubtitle: {
    fontSize: 13,
    color: '#64748B',
    fontWeight: '500',
    marginTop: 2,
  },
  summaryBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  summaryText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 19,
    fontWeight: '500',
  },
  metricsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  metricChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
  },
  metricEmoji: {
    fontSize: 16,
  },
  metricValue: {
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 17,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  prioritySection: {
    marginBottom: 10,
  },
  priorityHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  prioritySectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  seeAllText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.primary,
  },
  priorityItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  priorityItemContent: {
    flex: 1,
  },
  priorityItemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 3,
  },
  prioritySourceText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    maxWidth: 160,
  },
  typeTag: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  typeTagText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#475569',
  },
  priorityTitleText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E293B',
  },
  calendarQuickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E0F2FE',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BAE6FD',
    marginLeft: 8,
    gap: 4,
  },
  calendarQuickBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0284C7',
  },
  tipBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    color: '#92400E',
    lineHeight: 17,
  },
});
