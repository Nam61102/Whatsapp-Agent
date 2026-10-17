import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Colors } from '../../shared/theme/colors';
import { apiClient } from '../../shared/services/api';
import { socketService } from '../../shared/services/socket';
import { Contact } from '../../shared/types';
import {
  resolveDisplayName,
  isRawIdentifier,
  formatPhoneNumber,
  onDeviceContactsUpdated,
  getDeviceContactsRevision,
} from '../../shared/utils/nameResolver';
import { loadDeviceContacts } from '../../shared/services/deviceContacts';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '../../shared/components/Avatar';
import { Illustration } from '../../shared/components/Illustration';
import { Sticker } from '../../shared/components/Sticker';
import { IconText } from '../../shared/components/IconText';

export const ContactListScreen = ({ navigation }: any) => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [deviceContactsRev, setDeviceContactsRev] = useState(getDeviceContactsRevision());

  useEffect(() => {
    // Make sure the device phonebook is loaded even if the user lands here first.
    loadDeviceContacts().catch(() => {});
    return onDeviceContactsUpdated(() => {
      setDeviceContactsRev(getDeviceContactsRevision());
      // Also refetch the list so the backend's overlay (now that it has the
      // uploaded phonebook) gets a fresh chance to resolve names it previously
      // couldn't match.
      fetchContacts(search);
    });
  }, [search]);

  const fetchContacts = useCallback(async (query = '') => {
    try {
      const params = new URLSearchParams();
      if (query) params.append('search', query);
      params.append('type', 'INDIVIDUAL');
      params.append('limit', '5000');
      const url = `/contacts?${params.toString()}`;
      const res: any = await apiClient.get(url);
      setContacts(res.contacts || []);
      setTotalCount(res.total || (res.contacts ? res.contacts.length : 0));
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchTimeoutRef = React.useRef<any>(null);

  const debouncedFetchContacts = useCallback(() => {
    if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
    fetchTimeoutRef.current = setTimeout(() => {
      fetchContacts(search);
    }, 2000);
  }, [fetchContacts, search]);

  useEffect(() => {
    fetchContacts(search);

    const unsubEvents = [
      socketService.on('whatsapp:data_reset', () => fetchContacts(search)),
      socketService.on('conversation:updated', debouncedFetchContacts),
      socketService.on('contacts:updated', debouncedFetchContacts),
    ];

    return () => {
      if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
      unsubEvents.forEach((u) => {
        if (typeof u === 'function') u();
      });
    };
  }, [fetchContacts, search, debouncedFetchContacts]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchContacts(search);
  };

  const renderContact = ({ item }: { item: Contact }) => {
    const resolvedTitle = resolveDisplayName(item, item.displayName, false);
    const safePhone =
      item.phoneNumber && !isRawIdentifier(item.phoneNumber)
        ? formatPhoneNumber(item.phoneNumber)
        : null;

    return (
      <TouchableOpacity
        style={styles.contactCard}
        activeOpacity={0.7}
        onPress={() =>
          navigation.navigate('ContactProfile', {
            contactId: item.id,
            contactName: resolvedTitle,
          })
        }
      >
        <Avatar name={resolvedTitle} uri={item.profilePhotoUrl} size={46} style={{ marginRight: 12 }} />

        <View style={styles.infoCol}>
          <View style={styles.nameRow}>
            <Text style={styles.displayName}>{resolvedTitle}</Text>
            {item.isBusiness && <Text style={styles.businessBadge}>BUSINESS</Text>}
          </View>
          {safePhone ? (
            <Text style={styles.phoneText}>{safePhone}</Text>
          ) : null}
          {item.about && (
            <Text style={styles.aboutText} numberOfLines={1}>
              {item.about}
            </Text>
          )}
        </View>

        <View style={styles.actionCol}>
          <IconText icon="sparkles" style={styles.viewProfileTag}>AI Profile</IconText>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Cartoon Friends Header Banner */}
      <View style={styles.friendsBanner}>
        <Sticker name="friends" size={38} style={{ marginRight: 10 }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.friendsBannerTitle}>Contacts & AI Personas</Text>
          <Text style={styles.friendsBannerSubtitle}>
            {totalCount > 0 ? `${totalCount} WhatsApp contacts` : 'Syncing phonebook...'} • Tap to see likes & tone
          </Text>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <View style={styles.searchInputWrap}>
          <Ionicons name="search" size={18} color={Colors.textMuted} style={{ marginRight: 8 }} />
          <TextInput
            style={styles.searchInput}
            placeholder={`Search ${totalCount > 0 ? totalCount : ''} contacts...`}
            placeholderTextColor={Colors.textLight}
            value={search}
            onChangeText={(text) => {
              setSearch(text);
            }}
          />
          {search ? (
            <TouchableOpacity onPress={() => setSearch('')}>
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
          data={contacts}
          keyExtractor={(item) => item.id}
          renderItem={renderContact}
          extraData={deviceContactsRev}
          initialNumToRender={30}
          maxToRenderPerBatch={30}
          windowSize={10}
          removeClippedSubviews={true}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[Colors.primary]} />
          }
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Illustration name="contacts" size={170} />
              <Text style={styles.emptyTitle}>No contacts found</Text>
              <Text style={styles.emptySub}>
                Contacts will appear automatically after connecting your WhatsApp account.
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
  friendsBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E8F5F2',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#CCEBE5',
  },
  friendsBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.primary,
  },
  friendsBannerSubtitle: {
    fontSize: 11,
    color: '#0D685C',
    marginTop: 1,
  },
  searchContainer: {
    padding: 12,
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
    paddingVertical: 8,
    fontSize: 14,
    color: Colors.text,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFF',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  tabButton: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#F1F5F9',
    marginHorizontal: 4,
  },
  tabButtonActive: {
    backgroundColor: Colors.primary,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: '#FFF',
    fontWeight: '700',
  },
  contactCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F3F6F8',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  groupAvatar: {
    backgroundColor: '#0F8F7E',
  },
  avatarText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700',
  },
  infoCol: {
    flex: 1,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  displayName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.text,
  },
  groupBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: '#0F8F7E',
    backgroundColor: '#CCFBF1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  businessBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: Colors.primary,
    backgroundColor: '#E6F4F1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  phoneText: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  aboutText: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
    fontStyle: 'italic',
  },
  actionCol: {
    paddingLeft: 8,
  },
  viewProfileTag: {
    fontSize: 13,
    color: Colors.secondary,
    fontWeight: '600',
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
    fontSize: 36,
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
