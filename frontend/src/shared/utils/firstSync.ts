import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The "WhatsApp Sync Status" card is for the FIRST sync after linking WhatsApp, and nothing else.
 *
 * - It opens once, in the session where WhatsApp was just linked.
 * - Its 5-minute countdown runs once and is anchored to the moment of linking, so reloading the app
 *   does not restart it.
 * - After it has been shown it never opens by itself again (reload, re-login, reconnect).
 * - Unlinking WhatsApp forgets all of this, so linking again counts as a new first time.
 */
const KEY = 'vai_first_sync_v2';

/** Length of the first-sync countdown. Matches the "first sync takes about 5 minutes" note. */
export const FIRST_SYNC_MS = 5 * 60 * 1000;

interface FirstSyncState {
  startedAt: number; // when WhatsApp was linked
  shown: boolean; // the card has already been opened automatically
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
    /* storage can be unavailable (private mode); the card then simply does not open */
  }
};

/** Call when WhatsApp has just been linked. Ignored if a first sync is already being tracked. */
export const markFirstSyncPending = async (): Promise<void> => {
  if (await read()) return;
  await write({ startedAt: Date.now(), shown: false });
};

/**
 * Call when the dashboard opens. Returns the end time of the countdown the first time only, and
 * only while the 5-minute window is still running; otherwise null. Never returns it twice.
 */
export const consumeFirstSync = async (): Promise<{ endsAt: number } | null> => {
  const state = await read();
  if (!state || state.shown) return null;
  const endsAt = state.startedAt + FIRST_SYNC_MS;
  await write({ ...state, shown: true });
  return endsAt > Date.now() ? { endsAt } : null;
};

/** Call when WhatsApp is unlinked: the next link is a new first time. */
export const clearFirstSync = async (): Promise<void> => {
  await write(null);
};
