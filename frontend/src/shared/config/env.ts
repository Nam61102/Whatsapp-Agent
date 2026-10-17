/**
 * Frontend environment configuration.
 * Variables prefixed with EXPO_PUBLIC_ are embedded by Expo at build time.
 * Set them in frontend/.env.local (dev) or in the EAS build profile (APK).
 *
 * There is deliberately NO built-in server address: a phone build that fell back to "localhost" would call
 * itself and hang. In development only, a missing URL falls back to the machine running the Expo dev server.
 */
import Constants from 'expo-constants';

const devHost = (): string | null => {
  if (!__DEV__) return null;
  const hostUri = (Constants.expoConfig as any)?.hostUri as string | undefined;
  if (hostUri) return hostUri.split(':')[0];
  if (typeof window !== 'undefined' && window.location && window.location.hostname) return window.location.hostname;
  return null;
};

const fromEnv =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  (process.env.EXPO_PUBLIC_API_URL ? process.env.EXPO_PUBLIC_API_URL.replace(/\/api\/v1\/?$/, '') : '');
const host = fromEnv ? null : devHost();
const rawBackendUrl = fromEnv || (host ? `http://${host}:${process.env.EXPO_PUBLIC_DEV_PORT || '3000'}` : '');

if (!rawBackendUrl) {
  console.error('[config] EXPO_PUBLIC_BACKEND_URL is not set. The app cannot reach a server.');
}

export const BACKEND_URL = rawBackendUrl.replace(/\/+$/, '');
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || `${BACKEND_URL}/api/v1`;
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL || BACKEND_URL;
