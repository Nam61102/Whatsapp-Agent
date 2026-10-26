import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { ContactAIProfile } from '../../shared/types';
import { resolveDisplayName } from '../../shared/utils/nameResolver';
import { Avatar } from '../../shared/components/Avatar';
import { Sticker } from '../../shared/components/Sticker';

export const ContactProfileScreen = ({ route, navigation }: any) => {
  const { contactId, contactName } = route.params || {};
  const [profile, setProfile] = useState<any>(null);
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [contact, setContact] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isReanalyzing, setIsReanalyzing] = useState(false);

  const fetchContactAndProfile = useCallback(async () => {
    try {
      const contactRes: any = await apiClient.get(`/contacts/${contactId}`);
      setContact(contactRes);
    } catch (err) {
      console.error('Failed to load contact:', err);
    }
    try {
      const profileRes: any = await apiClient.get(`/ai/contacts/${contactId}/profile`);
      if (profileRes?.status === 'NO_DATA') {
        setProfile(null);
        setProfileNote(profileRes.message);
      } else {
        setProfile(profileRes);
        setProfileNote(null);
      }
    } catch (err: any) {
      setProfile(null);
      setProfileNote(err?.message || 'AI analysis could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    fetchContactAndProfile();
  }, [fetchContactAndProfile]);

  const handleReanalyze = async () => {
    setIsReanalyzing(true);
    try {
      const profileRes: any = await apiClient.get(`/ai/contacts/${contactId}/profile`);
      if (profileRes?.status === 'NO_DATA') {
        setProfile(null);
        setProfileNote(profileRes.message);
      } else {
        setProfile(profileRes);
        setProfileNote(null);
      }
    } catch (err: any) {
      setProfile(null);
      setProfileNote(err?.message || 'AI analysis could not be loaded. Please try again.');
    } finally {
      setIsReanalyzing(false);
    }
  };

  const handleOpenChat = () => {
    if (contact?.conversations?.[0]?.id) {
      navigation.navigate('ChatsTab', {
        screen: 'ChatDetail',
        params: {
          chatId: contact.conversations[0].id,
          contactName: contact.displayName,
          contactId: contact.id,
        },
      });
    } else {
      navigation.navigate('ChatsTab');
    }
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Reading the chat...</Text>
      </View>
    );
  }

  const name = contact?.displayName || contactName || 'Unknown';
  // Older saved profiles stored plain strings; new ones carry the exact words from the chat.
  const toItems = (list: any): Array<{ item: string; evidence: string }> =>
    (Array.isArray(list) ? list : [])
      .map((x: any) => (typeof x === 'string' ? { item: x, evidence: '' } : { item: x?.item, evidence: x?.evidence || '' }))
      .filter((x) => !!x.item);
  const likes = toItems(profile?.likes);
  const dislikes = toItems(profile?.dislikes);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Header Profile Card */}
      <View style={styles.profileHeader}>
        <Avatar name={name} uri={contact?.profilePhotoUrl} size={88} style={{ marginBottom: 10 }} />
        <Text style={styles.nameText}>{name}</Text>
        {contact?.phoneNumber ? <Text style={styles.phoneText}>{contact.phoneNumber}</Text> : null}
        {contact?.about ? <Text style={styles.aboutText}>"{contact.about}"</Text> : null}

        <View style={styles.personaBadge}>
          <Sticker name="brain" size={24} style={{ marginRight: 6 }} />
          <Text style={styles.personaBadgeText}>Gemini AI Persona Analysis</Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <View style={[styles.iconChip, { backgroundColor: Colors.successLight }]}>
            <Ionicons name="thumbs-up" size={16} color={Colors.success} />
          </View>
          <Text style={styles.cardTitle}>Likes</Text>
          {likes.length > 0 && <Text style={[styles.countPill, { color: Colors.success, backgroundColor: Colors.successLight }]}>{likes.length}</Text>}
        </View>
        {likes.length === 0 ? (
          <Text style={styles.emptyText}>{profileNote || 'Nothing clear yet. Likes show up when they say it in the chat.'}</Text>
        ) : (
          likes.map((row, idx) => (
            <View key={idx} style={[styles.likeRow, idx === likes.length - 1 && { borderBottomWidth: 0 }]}>
              <Ionicons name="checkmark-circle" size={18} color={Colors.success} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.likeItem}>{row.item}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <View style={[styles.iconChip, { backgroundColor: Colors.dangerLight }]}>
            <Ionicons name="thumbs-down" size={16} color={Colors.danger} />
          </View>
          <Text style={styles.cardTitle}>Dislikes</Text>
          {dislikes.length > 0 && <Text style={[styles.countPill, { color: Colors.danger, backgroundColor: Colors.dangerLight }]}>{dislikes.length}</Text>}
        </View>
        {dislikes.length === 0 ? (
          <Text style={styles.emptyText}>{profileNote || 'Nothing clear yet. Dislikes show up when they say it in the chat.'}</Text>
        ) : (
          dislikes.map((row, idx) => (
            <View key={idx} style={[styles.likeRow, idx === dislikes.length - 1 && { borderBottomWidth: 0 }]}>
              <Ionicons name="close-circle" size={18} color={Colors.danger} style={{ marginTop: 1 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.likeItem}>{row.item}</Text>
              </View>
            </View>
          ))
        )}
      </View>

      {profile?.sourceMessageCount ? (
        <View style={styles.noteRow}>
          <Ionicons name="information-circle-outline" size={16} color={Colors.textMuted} />
          <Text style={styles.noteText}>
            Based on your latest {profile.sourceMessageCount} messages. Only things they said themselves are shown.
          </Text>
        </View>
      ) : null}

      {/* Bottom Actions */}
      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.chatButton} onPress={handleOpenChat}>
          <Ionicons name="chatbubble-ellipses" size={18} color="#FFFFFF" />
          <Text style={styles.chatButtonText}>Open WhatsApp Chat</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  iconChip: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  countPill: { marginLeft: 'auto', fontSize: 12, fontWeight: '800', paddingHorizontal: 9, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  likeRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  likeItem: { fontSize: 15, fontWeight: '700', color: Colors.text },
  likeEvidence: { fontSize: 12, color: Colors.textSecondary, fontStyle: 'italic', marginTop: 3, lineHeight: 17 },
  emptyText: { fontSize: 13, color: Colors.textSecondary, lineHeight: 19 },
  noteRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', paddingHorizontal: 4, marginBottom: 10 },
  noteText: { flex: 1, fontSize: 12, color: Colors.textMuted, lineHeight: 17 },
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
  profileHeader: {
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1.5,
    borderColor: '#D1EAE5',
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 3,
  },
  personaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5F2',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#CCEBE5',
  },
  personaBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.primary,
  },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  avatarText: {
    color: '#FFF',
    fontSize: 32,
    fontWeight: '700',
  },
  nameText: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
  },
  phoneText: {
    fontSize: 14,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  aboutText: {
    fontSize: 13,
    color: Colors.textMuted,
    fontStyle: 'italic',
    marginTop: 6,
  },
  card: {
    backgroundColor: Colors.cardBackground,
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 0,
    flex: 1,
  },
  confidenceBadge: {
    backgroundColor: '#E6F4F1',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  confidenceText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.secondary,
  },
  summaryText: {
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  tagGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  stylePill: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    minWidth: '45%',
  },
  styleLabel: {
    fontSize: 11,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  styleVal: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    marginTop: 2,
  },
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  interestTag: {
    backgroundColor: '#E6F4F1',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  interestText: {
    color: Colors.primaryDark,
    fontSize: 13,
    fontWeight: '600',
  },
  dislikeTag: {
    backgroundColor: '#FEE2E2',
  },
  dislikeText: {
    color: '#DC2626',
  },
  topicsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  topicPill: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  topicText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  actionRow: {
    marginTop: 10,
  },
  chatButton: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  chatButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
