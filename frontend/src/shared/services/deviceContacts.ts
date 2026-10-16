import { Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import { registerDeviceContacts } from '../utils/nameResolver';
import { apiClient } from './api';

let hasLoaded = false;

async function uploadToBackend(entries: Array<{ phoneNumber: string; name: string }>) {
  if (entries.length === 0) return;
  try {
    await apiClient.post('/contacts/device', { contacts: entries });
    console.log(`[deviceContacts] Uploaded ${entries.length} phonebook entries to backend`);
  } catch (err: any) {
    console.warn('[deviceContacts] Backend upload failed:', err?.message || err);
  }
}

export async function loadDeviceContacts(force = false): Promise<number> {
  if (hasLoaded && !force) return 0;
  if (Platform.OS === 'web') {
    hasLoaded = true;
    return 0;
  }

  try {
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[deviceContacts] Permission not granted:', status);
      hasLoaded = true;
      return 0;
    }

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
      pageSize: 10000,
    });

    const entries: Array<{ phoneNumber: string; name: string }> = [];
    for (const c of data) {
      const name = (c.name || '').trim();
      if (!name) continue;
      const numbers = c.phoneNumbers || [];
      for (const p of numbers) {
        const digits = (p.number || '').replace(/\D/g, '');
        if (digits.length >= 7) {
          entries.push({ phoneNumber: digits, name });
        }
      }
    }

    registerDeviceContacts(entries);
    hasLoaded = true;
    console.log(`[deviceContacts] Loaded ${entries.length} phone→name pairs from ${data.length} device contacts`);
    // Push to backend so chats/contacts endpoints can overlay names
    // for other surfaces (web, future server-rendered views, etc.).
    uploadToBackend(entries).catch(() => {});
    return entries.length;
  } catch (err: any) {
    console.warn('[deviceContacts] Failed to load device contacts:', err?.message || err);
    hasLoaded = true;
    return 0;
  }
}
