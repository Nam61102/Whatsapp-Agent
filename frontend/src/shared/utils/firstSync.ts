import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The "WhatsApp Sync Status" card and 5-minute countdown are for tracking the initial
 * synchronization and AI intelligence scanning of WhatsApp messages.
 *
 * - It runs a 5-minute countdown anchored to the moment of linking.
 * - Even if the user reloads or navigates, the remaining time continues accurately.
 * - Auto-refreshes items as AI finishes scanning conversations.
 * - Unlinking WhatsApp resets this state so next link starts fresh.
 */
const KEY = 'vai_first_sync_v2';

/** Length of the first-sync countdown (5 minutes). */
export const FIRST_SYNC_MS = 5 * 60 * 1000;

interface FirstSyncState {
  startedAt: number; // when WhatsApp was linked
  modalShown?: boolean; // whether the initial sync modal popup has opened
}

const read = async (): Promise<FirstSyncState | null> => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as FirstSyncState) : null;
  } catch {
    return null;
  }
};

const write = async (state: FirstSyncState | null) => {
  try {
    if (state) await AsyncStorage.setItem(KEY, JSON.stringify(state));
    else await AsyncStorage.removeItem(KEY);
  } catch {
    /* storage can be unavailable; ignore */
  }
};

/**
 * Call when WhatsApp has just been linked (or re-linked).
 * Unconditionally starts a fresh 5-minute sync window.
 */
export const markFirstSyncPending = async (): Promise<void> => {
  await write({ startedAt: Date.now(), modalShown: false });
};

/**
 * Returns the end timestamp of the 5-minute countdown if active; otherwise null.
 * Persists across reloads, backgrounding, and tab switching.
 */
export const getFirstSyncEnd = async (): Promise<number | null> => {
  const state = await read();
  if (!state || !state.startedAt) return null;
  const endsAt = state.startedAt + FIRST_SYNC_MS;
  if (Date.now() >= endsAt) return null;
  return endsAt;
};

/**
 * Checks whether the initial sync modal popup should be shown once.
 */
export const shouldOpenFirstSyncModal = async (): Promise<boolean> => {
  const state = await read();
  if (!state || !state.startedAt || state.modalShown) return false;
  const endsAt = state.startedAt + FIRST_SYNC_MS;
  if (Date.now() >= endsAt) return false;
  await write({ ...state, modalShown: true });
  return true;
};

/**
 * Backward compatibility helper for existing callers.
 */
export const consumeFirstSync = async (): Promise<{ endsAt: number } | null> => {
  const endsAt = await getFirstSyncEnd();
  if (!endsAt) return null;
  return { endsAt };
};

/** Call when WhatsApp is unlinked */
export const clearFirstSync = async (): Promise<void> => {
  await write(null);
};
