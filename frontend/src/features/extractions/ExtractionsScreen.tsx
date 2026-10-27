import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  TextInput,
  Platform,
  Alert,
  Modal,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { socketService } from '../../shared/services/socket';
import { resolveDisplayName } from '../../shared/utils/nameResolver';
import { IconText } from '../../shared/components/IconText';
import { Ionicons } from '@expo/vector-icons';
import { Illustration } from '../../shared/components/Illustration';
import { Sticker } from '../../shared/components/Sticker';
import { formatDueDate } from '../../shared/utils/dates';
import { BadgeLabel } from '../../shared/components/BadgeLabel';
import { openGoogleCalendar } from '../../shared/utils/calendarSync';

const CATEGORIES = [
  { key: 'ALL', label: 'All', icon: '⚡' },
  { key: 'REPLY_NEEDED', label: 'Reply Needed', icon: '💬' },
  { key: 'FOLLOW_UP', label: 'Follow Up', icon: '🔄' },
  { key: 'BIRTHDAY', label: 'Birthdays & Wishes', icon: '🎂' },
];

// Active = still open. The others read the full saved history from the database.
const STATUS_VIEWS = [
  { key: 'ACTIVE', label: 'Active', statuses: 'ACTIVE,REVIEWED,IN_PROGRESS' },
  { key: 'COMPLETED', label: 'Completed', statuses: 'COMPLETED,RESOLVED' },
  { key: 'DISMISSED', label: 'Dismissed', statuses: 'DISMISSED,ARCHIVED' },
  { key: 'CANCELLED', label: 'Cancelled', statuses: 'CANCELLED' },
];

const TYPE_OPTIONS = [
  { key: 'ALL', label: 'All types' },
  { key: 'TASK', label: 'Task' },
  { key: 'REMINDER', label: 'Reminder' },
  { key: 'MEETING,APPOINTMENT', label: 'Meeting' },
  { key: 'FOLLOW_UP', label: 'Follow-up' },
  { key: 'DEADLINE', label: 'Deadline' },
  { key: 'QUESTION', label: 'Question' },
  { key: 'DECISION', label: 'Decision' },
  { key: 'CONTACT', label: 'Contact' },
  { key: 'PAYMENT', label: 'Payment' },
  { key: 'INVOICE', label: 'Invoice' },
  { key: 'ORDER', label: 'Order' },
  { key: 'DOCUMENT', label: 'Document' },
  { key: 'COMPLAINT', label: 'Complaint' },
  { key: 'URGENT', label: 'Urgent' },
  { key: 'REQUIREMENT', label: 'Requirement' },
  { key: 'LEAD', label: 'Lead' },
  { key: 'NEGOTIATION', label: 'Negotiation' },
  { key: 'PROJECT_UPDATE', label: 'Project' },
  { key: 'CHANGE', label: 'Change' },
  { key: 'INSTRUCTION', label: 'Instruction' },
  { key: 'PREFERENCE', label: 'Preference' },
  { key: 'BUSINESS', label: 'Business' },
  { key: 'TRAVEL', label: 'Travel' },
  { key: 'INTERVIEW', label: 'Interview' },
  { key: 'RECURRING', label: 'Recurring' },
  { key: 'APPROVAL', label: 'Approval' },
  { key: 'RENEWAL', label: 'Renewal' },
  { key: 'GOAL', label: 'Goal' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'SUMMARY', label: 'Summary' },
  { key: 'IMPORTANT_EVENT', label: 'Event' },
  { key: 'BIRTHDAY,WISH', label: 'Birthdays & Wishes' },
];

const PRIORITY_OPTIONS = [
  { key: 'ALL', label: 'Any priority' },
  { key: 'URGENT', label: 'Urgent' },
  { key: 'HIGH', label: 'High' },
  { key: 'NORMAL', label: 'Normal' },
  { key: 'LOW', label: 'Low' },
];

const DATE_PRESETS = [
  { key: 'ALL', label: 'Any time' },
  { key: 'TODAY', label: 'Today' },
  { key: '7D', label: 'Last 7 days' },
  { key: '30D', label: 'Last 30 days' },
  { key: 'CUSTOM', label: 'Custom' },
];

const NON_BIRTHDAY_TYPES = TYPE_OPTIONS.map((t) => t.key)
  .filter((k) => k !== 'ALL' && k !== 'BIRTHDAY,WISH')
  .join(',');

const PAGE_SIZE = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Filters = {
  type: string;
  priority: string;
  contactId: string;
  contactName: string;
  datePreset: string;
  from: string;
  to: string;
};
const NO_FILTERS: Filters = { type: 'ALL', priority: 'ALL', contactId: '', contactName: '', datePreset: 'ALL', from: '', to: '' };

const TYPE_LABELS: Record<string, string> = {
  TASK: '✅ Task',
  REMINDER: '⏰ Reminder',
  FOLLOW_UP: '🔄 Follow Up',
  APPOINTMENT: '📅 Appointment',
  MEETING: '📅 Meeting',
  DEADLINE: '⏳ Deadline',
  PAYMENT: '💰 Payment',
  TRAVEL: '✈️ Travel',
  IMPORTANT_EVENT: '⭐ Event',
  DECISION: '🤝 Decision',
  CONTACT: '👤 Contact',
  BUSINESS: '💼 Business',
  QUESTION: '❓ Question',
  OTHER: '📌 Note',
  BIRTHDAY: '🎂 Birthday',
  INVOICE: '🧾 Invoice',
  ORDER: '📦 Order',
  DOCUMENT: '📄 Document',
  COMPLAINT: '⚠️ Complaint',
  URGENT: '🚨 Urgent',
  REQUIREMENT: '📝 Requirement',
  LEAD: '🎯 Lead',
  NEGOTIATION: '🤝 Negotiation',
  PROJECT_UPDATE: '📈 Project Update',
  CHANGE: '🔀 Change',
  INSTRUCTION: '📌 Instruction',
  PREFERENCE: '⭐ Preference',
  INTERVIEW: '🧑‍💼 Interview',
  RECURRING: '🔁 Recurring',
  APPROVAL: '✔️ Approval',
  RENEWAL: '♻️ Renewal',
  GOAL: '🏁 Goal',
  SUMMARY: '🗒️ Summary',
  PENDING: '⏳ Pending',
  WISH: '🎉 Wishes',
};

// Date range sent to the API (inclusive, local time). Returns null when the custom range is invalid.
const dateRange = (f: Filters): { from?: string; to?: string } | null => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (f.datePreset === 'TODAY') return { from: startOfToday.toISOString() };
  if (f.datePreset === '7D') return { from: new Date(startOfToday.getTime() - 6 * 86400000).toISOString() };
  if (f.datePreset === '30D') return { from: new Date(startOfToday.getTime() - 29 * 86400000).toISOString() };
  if (f.datePreset === 'CUSTOM') {
    if (f.from && !DATE_RE.test(f.from)) return null;
    if (f.to && !DATE_RE.test(f.to)) return null;
    return {
      from: f.from ? new Date(`${f.from}T00:00:00`).toISOString() : undefined,
      to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : undefined,
    };
  }
  return {};
};

const hasAdvancedFilters = (f: Filters) => f.type !== 'ALL' || f.priority !== 'ALL' || !!f.contactId || f.datePreset !== 'ALL';

// History rows are raw saved records; show them with the same card as Action Center items.
const fromRecord = (r: any) => ({
  id: r.id,
  category: r.extractionType === 'BIRTHDAY' || r.extractionType === 'WISH' ? 'BIRTHDAY' : 'FOLLOW_UP',
  badgeLabel: TYPE_LABELS[r.extractionType] || '📌 Note',
  badgeColor:
    r.status === 'COMPLETED' || r.status === 'RESOLVED'
      ? '#16A34A'
      : r.status === 'CANCELLED' || r.status === 'DISMISSED'
      ? '#94A3B8'
      : r.priority === 'URGENT'
      ? '#DC2626'
      : r.priority === 'HIGH'
      ? '#EA580C'
      : '#F59E0B',
  title: r.title,
  summary: r.description || r.summary,
  senderName: r.contact?.displayName,
  contactName: r.contact?.displayName || 'Contact',
  contact: r.contact,
  groupName: r.conversation?.chatType === 'GROUP' ? r.conversation?.title : null,
  conversationId: r.conversationId,
  messageId: r.messageId,
  sourceMessageText: r.message?.textContent,
  eventDate: r.eventDate,
  status: r.status,
  priority: r.priority,
  createdAt: r.createdAt,
  isHistory: true,
  isClosed: !['ACTIVE', 'REVIEWED', 'IN_PROGRESS'].includes(r.status),
});

// Merge by stable id: a refresh adds and updates items but never drops ones already loaded.
const mergeById = (prev: any[], next: any[]) => {
  const map = new Map<string, any>();
  prev.forEach((i) => map.set(i.id, i));
  next.forEach((i) => map.set(i.id, { ...map.get(i.id), ...i }));
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || String(b.id).localeCompare(String(a.id))
  );
};

const filterLabel = { fontSize: 11, fontWeight: '700' as const, color: '#64748B', paddingHorizontal: 12, marginTop: 8, marginBottom: 4, textTransform: 'uppercase' as const };

export const ExtractionsScreen = ({ navigation }: any) => {
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [statusView, setStatusView] = useState('ACTIVE');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contactModal, setContactModal] = useState(false);
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<any[]>([]);

  // Only the newest request may write state, so a slow old response cannot overwrite a newer one.
  const requestSeq = React.useRef(0);

  const rangeInvalid = dateRange(filters) === null;
  // Saved-item history (server-side filters and search) is used for non-active views and whenever a filter is set.
  const useHistory = statusView !== 'ACTIVE' || hasAdvancedFilters(filters) || (debouncedSearch.trim().length > 0 && selectedCategory !== 'REPLY_NEEDED');

  type Params = { category: string; view: string; filters: Filters; search: string };
  const params: Params = { category: selectedCategory, view: statusView, filters, search: debouncedSearch.trim() };
  const paramsRef = React.useRef<Params>(params);
  paramsRef.current = params;

  const buildUrl = (p: Params, offset: number): string | null => {
    const paging = `limit=${PAGE_SIZE}&offset=${offset}`;
    const advanced = hasAdvancedFilters(p.filters);
    const history = p.view !== 'ACTIVE' || advanced || (p.search.length > 0 && p.category !== 'REPLY_NEEDED');
    if (!history) {
      return p.category === 'ALL' ? `/extractions?${paging}` : `/extractions?type=${p.category}&${paging}`;
    }
    if (p.category === 'REPLY_NEEDED') return null; // suggested replies are not saved items
    const range = dateRange(p.filters);
    if (range === null) return null;
    const q: string[] = [];
    q.push(`status=${encodeURIComponent(STATUS_VIEWS.find((v) => v.key === p.view)?.statuses || 'ALL')}`);
    const type = p.filters.type !== 'ALL' ? p.filters.type : p.category === 'BIRTHDAY' ? 'BIRTHDAY,WISH' : p.category === 'FOLLOW_UP' ? NON_BIRTHDAY_TYPES : '';
    if (type) q.push(`type=${encodeURIComponent(type)}`);
    if (p.filters.priority !== 'ALL') q.push(`priority=${p.filters.priority}`);
    if (p.filters.contactId) q.push(`contactId=${p.filters.contactId}`);
    if (range.from) q.push(`from=${encodeURIComponent(range.from)}`);
    if (range.to) q.push(`to=${encodeURIComponent(range.to)}`);
    if (p.search) q.push(`search=${encodeURIComponent(p.search)}`);
    return `/extractions/history?${q.join('&')}&${paging}`;
  };

  const fetchPage = useCallback(async (p: Params, offset: number, mode: 'replace' | 'merge' | 'append') => {
    const seq = ++requestSeq.current;
    const url = buildUrl(p, offset);
    if (url === null) {
      // Nothing to query for this combination (for example an unfinished custom date).
      setItems([]);
      setTotal(0);
      setLoading(false);
      setRefreshing(false);
      setLoadingMore(false);
      return;
    }
    try {
      const res: any = await apiClient.get(url);
      if (seq !== requestSeq.current) return; // a newer request exists
      const fromHistory = url.startsWith('/extractions/history');
      let incoming: any[] = fromHistory ? (res.items || []).map(fromRecord) : res.extractions || [];
      setTotal(res.total ?? incoming.length);
      setItems((prev) => (mode === 'replace' ? incoming : mergeById(prev, incoming)));
      setError(null);
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      // Keep what is already on screen; only say that the refresh failed.
      console.error('Failed to load action items:', err);
      setError('Could not refresh. Showing saved items.');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // Search is sent to the server after a short pause, so typing does not fire a request per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Changing any filter starts again from the first page and replaces the list.
  const filtersKey = JSON.stringify([selectedCategory, statusView, filters, debouncedSearch.trim()]);
  useEffect(() => {
    setLoading(true);
    setItems([]);
    setTotal(0);
    fetchPage(paramsRef.current, 0, 'replace');
  }, [filtersKey, fetchPage]);

  // Realtime events merge the newest page into what is already loaded.
  // A sync or wipe fires hundreds of events in seconds. They are coalesced into ONE request after
  // things settle, otherwise the browser runs out of connections (ERR_INSUFFICIENT_RESOURCES).
  useEffect(() => {
    let timer: any = null;
    let pendingMode: 'merge' | 'replace' = 'merge';
    const schedule = (mode: 'merge' | 'replace' = 'merge') => {
      if (mode === 'replace') pendingMode = 'replace';
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const mode = pendingMode;
        pendingMode = 'merge';
        fetchPage(paramsRef.current, 0, mode);
      }, 2000);
    };
    const refresh = () => schedule('merge');
    const unsubEvents = [
      socketService.on('ai:extraction', refresh),
      socketService.on('ai:extraction-updated', refresh),
      socketService.on('ai:suggestion', refresh),
      socketService.on('ai.extraction.created', refresh),
      socketService.on('dashboard:updated', refresh),
      socketService.on('whatsapp:data_reset', () => schedule('replace')),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      unsubEvents.forEach((u) => {
        if (typeof u === 'function') u();
      });
    };
  }, [fetchPage]);

  // Contact picker search
  useEffect(() => {
    if (!contactModal) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res: any = await apiClient.get(`/contacts?type=INDIVIDUAL&limit=30&search=${encodeURIComponent(contactQuery.trim())}`);
        if (!cancelled) setContactResults(res.contacts || []);
      } catch {
        if (!cancelled) setContactResults([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [contactModal, contactQuery]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchPage(paramsRef.current, 0, 'merge');
  };

  const loadMore = () => {
    if (loading || loadingMore || items.length >= total) return;
    setLoadingMore(true);
    fetchPage(paramsRef.current, items.length, 'append');
  };

  // Plain Action Center view keeps its local search (it also covers suggested replies).
  const filteredItems = items.filter((item) => {
    if (useHistory || !searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const contactName = (item.contactName || resolveDisplayName(item.contact, '')).toLowerCase();
    const title = (item.title || '').toLowerCase();
    const summary = (item.summary || '').toLowerCase();
    const messageText = (item.sourceMessageText || item.message?.textContent || '').toLowerCase();
    const replyText = (item.suggestedReply || '').toLowerCase();
    return (
      contactName.includes(query) ||
      title.includes(query) ||
      summary.includes(query) ||
      messageText.includes(query) ||
      replyText.includes(query)
    );
  });

  // Saved on the server first; the card is removed right away but put back if the save fails.
  const changeStatus = async (item: any, status: string) => {
    const snapshot = items;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    setTotal((t) => Math.max(0, t - 1));
    try {
      if (item.category === 'REPLY_NEEDED') {
        await apiClient.delete(`/extractions/${item.id}?category=REPLY_NEEDED`);
      } else {
        await apiClient.patch(`/extractions/${item.id}`, { status });
      }
    } catch (err) {
      console.warn('Failed to update action item:', err);
      setItems(snapshot);
      setTotal((t) => t + 1);
      setError('Could not save that change. Please try again.');
    }
  };

  const handleDismissItem = (item: any) => changeStatus(item, 'DISMISSED');
  const handleCompleteItem = (item: any) => changeStatus(item, 'COMPLETED');
  const handleReopenItem = (item: any) => changeStatus(item, 'ACTIVE');

  const activeFilterCount =
    (filters.type !== 'ALL' ? 1 : 0) + (filters.priority !== 'ALL' ? 1 : 0) + (filters.contactId ? 1 : 0) + (filters.datePreset !== 'ALL' ? 1 : 0);

  const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
    <TouchableOpacity style={[styles.filterTab, active && styles.filterTabActive, { marginRight: 8 }]} onPress={onPress}>
      <Text style={[styles.filterText, active && styles.filterTextActive]}>{label}</Text>
    </TouchableOpacity>
  );

  const renderItem = ({ item }: { item: any }) => {
    const isReplyNeeded = item.category === 'REPLY_NEEDED';
    const isFollowUp = item.category === 'FOLLOW_UP';
    const isBirthday = item.category === 'BIRTHDAY';

    const itemSticker: any = isBirthday
      ? 'birthday'
      : item.category === 'MEETING' || item.category === 'APPOINTMENT' || item.type === 'MEETING' || item.type === 'APPOINTMENT' || item.type === 'TASK' || item.category === 'TASK'
      ? 'calendar'
      : item.category === 'PAYMENT' || item.type === 'PAYMENT' || item.type === 'INVOICE'
      ? 'wallet'
      : item.category === 'TRAVEL' || item.type === 'TRAVEL'
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
        style={[
          styles.card,
          {
            backgroundColor: catTheme.cardBg,
            borderColor: catTheme.cardBorder,
          },
        ]}
      >
        <View style={styles.cardHeader}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap' }}>
            <Sticker name={itemSticker} size={30} style={{ marginRight: 2 }} />
            <View style={[styles.badge, { backgroundColor: catTheme.badgeBg, borderColor: catTheme.badgeBorder }]}>
              <BadgeLabel label={item.badgeLabel || '⚡ Action Item'} color={catTheme.badgeText} style={styles.badgeText} />
            </View>
            <Text style={styles.timeText}>
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

        <Text style={styles.title}>{item.title}</Text>
        <Text style={styles.summary}>{item.summary}</Text>

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

          {(isFollowUp || isBirthday) && !item.isClosed && (
            <TouchableOpacity
              style={styles.btnSecondary}
              onPress={() => handleCompleteItem(item)}
            >
              <IconText center icon="checkmark-circle-outline" style={styles.btnSecondaryText}>Done</IconText>
            </TouchableOpacity>
          )}

          {item.isClosed && (
            <TouchableOpacity style={styles.btnSecondary} onPress={() => handleReopenItem(item)}>
              <IconText center icon="arrow-undo-outline" style={styles.btnSecondaryText}>Reopen</IconText>
            </TouchableOpacity>
          )}

          {isFollowUp && (
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

          {(item.category === 'MEETING' || item.category === 'APPOINTMENT' || item.category === 'EVENT' || item.category === 'TASK' || item.type === 'TASK' || item.eventDate) && (
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
  };

  return (
    <View style={styles.container}>
      {/* Search Input */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search Action Center (contacts, replies, follow-ups)..."
          placeholderTextColor="#94A3B8"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.clearSearch} onPress={() => setSearchQuery('')}>
            <Text style={styles.clearSearchText}>✕</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.filterTab, (showFilters || activeFilterCount > 0) && styles.filterTabActive, { marginLeft: 6 }]}
          onPress={() => setShowFilters((v) => !v)}
        >
          <Text style={[styles.filterText, (showFilters || activeFilterCount > 0) && styles.filterTextActive]}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {showFilters && (
        <View style={{ backgroundColor: '#FFF', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}>
          <Text style={filterLabel}>Type</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
            {TYPE_OPTIONS.map((o) => (
              <Chip key={o.key} label={o.label} active={filters.type === o.key} onPress={() => setFilters((f) => ({ ...f, type: o.key }))} />
            ))}
          </ScrollView>

          <Text style={filterLabel}>Priority</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
            {PRIORITY_OPTIONS.map((o) => (
              <Chip key={o.key} label={o.label} active={filters.priority === o.key} onPress={() => setFilters((f) => ({ ...f, priority: o.key }))} />
            ))}
          </ScrollView>

          <Text style={filterLabel}>Date saved</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
            {DATE_PRESETS.map((o) => (
              <Chip key={o.key} label={o.label} active={filters.datePreset === o.key} onPress={() => setFilters((f) => ({ ...f, datePreset: o.key }))} />
            ))}
          </ScrollView>
          {filters.datePreset === 'CUSTOM' && (
            <View style={{ flexDirection: 'row', paddingHorizontal: 12, marginTop: 6, gap: 8 }}>
              <TextInput
                style={[styles.searchInput, { flex: 1 }]}
                placeholder="From YYYY-MM-DD"
                placeholderTextColor="#94A3B8"
                value={filters.from}
                onChangeText={(v) => setFilters((f) => ({ ...f, from: v.trim() }))}
              />
              <TextInput
                style={[styles.searchInput, { flex: 1 }]}
                placeholder="To YYYY-MM-DD"
                placeholderTextColor="#94A3B8"
                value={filters.to}
                onChangeText={(v) => setFilters((f) => ({ ...f, to: v.trim() }))}
              />
            </View>
          )}
          {rangeInvalid && (
            <Text style={{ color: '#B45309', fontSize: 12, paddingHorizontal: 12, marginTop: 4 }}>Enter dates as YYYY-MM-DD.</Text>
          )}

          <Text style={filterLabel}>Contact</Text>
          <View style={{ flexDirection: 'row', paddingHorizontal: 12, gap: 8, alignItems: 'center' }}>
            <Chip
              label={filters.contactId ? `👤 ${filters.contactName}` : 'Any contact'}
              active={!!filters.contactId}
              onPress={() => {
                setContactQuery('');
                setContactModal(true);
              }}
            />
            {activeFilterCount > 0 && (
              <TouchableOpacity onPress={() => setFilters(NO_FILTERS)}>
                <Text style={{ color: '#DC2626', fontWeight: '700', fontSize: 13 }}>Clear filters</Text>
              </TouchableOpacity>
            )}
          </View>
          {selectedCategory === 'REPLY_NEEDED' && activeFilterCount > 0 && (
            <Text style={{ color: '#64748B', fontSize: 12, paddingHorizontal: 12, marginTop: 6 }}>
              Filters apply to saved items. Suggested replies are not filtered.
            </Text>
          )}
        </View>
      )}

      <Modal visible={contactModal} animationType="slide" onRequestClose={() => setContactModal(false)}>
        <View style={{ flex: 1, backgroundColor: Colors.background, paddingTop: 40 }}>
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search contacts..."
              placeholderTextColor="#94A3B8"
              value={contactQuery}
              onChangeText={setContactQuery}
              autoFocus
            />
            <TouchableOpacity style={styles.clearSearch} onPress={() => setContactModal(false)}>
              <Text style={styles.clearSearchText}>Close</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={contactResults}
            keyExtractor={(c) => c.id}
            ListHeaderComponent={
              <TouchableOpacity
                style={{ padding: 16 }}
                onPress={() => {
                  setFilters((f) => ({ ...f, contactId: '', contactName: '' }));
                  setContactModal(false);
                }}
              >
                <Text style={{ fontWeight: '700', color: Colors.primary }}>Any contact</Text>
              </TouchableOpacity>
            }
            renderItem={({ item: c }) => (
              <TouchableOpacity
                style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#E2E8F0' }}
                onPress={() => {
                  setFilters((f) => ({ ...f, contactId: c.id, contactName: resolveDisplayName(c, '') || c.displayName }));
                  setContactModal(false);
                }}
              >
                <Text style={{ fontSize: 15, color: Colors.text }}>{resolveDisplayName(c, '') || c.displayName}</Text>
                {!!c.phoneNumber && <Text style={{ fontSize: 12, color: '#64748B' }}>{c.phoneNumber}</Text>}
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={{ padding: 16, color: '#64748B' }}>No contacts found.</Text>}
          />
        </View>
      </Modal>

      {/* Category Horizontal Filter Tabs */}
      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
          {CATEGORIES.map((cat) => (
            <TouchableOpacity
              key={cat.key}
              style={[
                styles.filterTab,
                selectedCategory === cat.key && styles.filterTabActive,
              ]}
              onPress={() => setSelectedCategory(cat.key)}
            >
              <Text style={styles.filterEmoji}>{cat.icon}</Text>
              <Text
                style={[
                  styles.filterText,
                  selectedCategory === cat.key && styles.filterTextActive,
                ]}
              >
                {cat.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
          {STATUS_VIEWS.map((v) => (
            <TouchableOpacity
              key={v.key}
              style={[styles.filterTab, statusView === v.key && styles.filterTabActive]}
              onPress={() => setStatusView(v.key)}
            >
              <Text style={[styles.filterText, statusView === v.key && styles.filterTextActive]}>{v.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {error && (
        <TouchableOpacity onPress={onRefresh} style={{ backgroundColor: '#FEF3C7', padding: 10 }}>
          <Text style={{ color: '#92400E', fontSize: 12, fontWeight: '600', textAlign: 'center' }}>{error} Tap to retry.</Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(item) => `${item.category}:${item.id}`}
          renderItem={renderItem}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} color={Colors.primary} /> : null}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Illustration name="done" size={170} />
              <Text style={styles.emptyTitle}>No Action Items</Text>
              <Text style={styles.emptySub}>
                All caught up! No pending replies, follow-ups, or birthdays requiring action right now.
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
  searchContainer: {
    backgroundColor: '#FFF',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    color: Colors.text,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  clearSearch: {
    padding: 8,
    marginLeft: 4,
  },
  clearSearchText: {
    fontSize: 14,
    color: '#64748B',
    fontWeight: '700',
  },
  filterContainer: {
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingVertical: 10,
  },
  filterScroll: {
    paddingHorizontal: 12,
    gap: 8,
  },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F3F6F8',
  },
  filterTabActive: {
    backgroundColor: Colors.primary,
  },
  filterEmoji: {
    marginRight: 6,
    fontSize: 14,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  filterTextActive: {
    color: '#FFF',
  },
  listContent: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3.5,
    borderRadius: 9,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  timeText: {
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
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0F172A',
    marginBottom: 4,
  },
  summary: {
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
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyEmoji: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  emptySub: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginTop: 4,
  },
});
