import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

let currentToken: string | null = null;
let currentUser: any | null = null;
let currentSessionId: string | null = null;
let currentDeviceInfo: string | null = null;
let isInitialized = false;

export const AuthStorage = {
  init: async (): Promise<boolean> => {
    if (isInitialized && currentToken) return true;
    try {
      // 1. Try AsyncStorage (cross-platform Native & Web)
      const token = await AsyncStorage.getItem('access_token');
      const user = await AsyncStorage.getItem('user_data');
      if (token) {
        currentToken = token;
        currentUser = user ? JSON.parse(user) : null;
        isInitialized = true;
        return true;
      }

      // 2. Fallback to localStorage on Web if AsyncStorage had not synced
      if (typeof localStorage !== 'undefined') {
        const localToken = localStorage.getItem('access_token');
        const localUser = localStorage.getItem('user_data');
        if (localToken) {
          currentToken = localToken;
          currentUser = localUser ? JSON.parse(localUser) : null;
          // Sync to AsyncStorage
          await AsyncStorage.setItem('access_token', localToken);
          if (localUser) await AsyncStorage.setItem('user_data', localUser);
          isInitialized = true;
          return true;
        }
      }
    } catch (e) {
      console.warn('[AuthStorage] Init error:', e);
    }
    isInitialized = true;
    return false;
  },

  getToken: (): string | null => {
    if (currentToken) return currentToken;
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('access_token');
        if (stored) {
          currentToken = stored;
          return stored;
        }
      }
    } catch {}
    return null;
  },

  setToken: async (token: string | null) => {
    currentToken = token;
    try {
      if (token) {
        await AsyncStorage.setItem('access_token', token);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('access_token', token);
        }
      } else {
        await AsyncStorage.removeItem('access_token');
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('access_token');
        }
      }
    } catch {}
  },

  getUser: (): any | null => {
    if (currentUser) return currentUser;
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('user_data');
        if (stored) {
          currentUser = JSON.parse(stored);
          return currentUser;
        }
      }
    } catch {}
    return null;
  },

  setUser: async (user: any | null) => {
    currentUser = user;
    try {
      if (user) {
        const json = JSON.stringify(user);
        await AsyncStorage.setItem('user_data', json);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('user_data', json);
        }
      } else {
        await AsyncStorage.removeItem('user_data');
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('user_data');
        }
      }
    } catch {}
  },

  clear: async () => {
    currentToken = null;
    currentUser = null;
    try {
      await AsyncStorage.removeItem('access_token');
      await AsyncStorage.removeItem('user_data');
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('access_token');
        localStorage.removeItem('user_data');
      }
    } catch {}
  },

  getClientSessionId: async (): Promise<string> => {
    if (currentSessionId) return currentSessionId;
    try {
      let sid = await AsyncStorage.getItem('client_session_id');
      if (!sid && typeof localStorage !== 'undefined') {
        sid = localStorage.getItem('client_session_id');
      }
      if (!sid) {
        sid = 'sess_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
        await AsyncStorage.setItem('client_session_id', sid);
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('client_session_id', sid);
        }
      }
      currentSessionId = sid;
      return sid;
    } catch {
      if (!currentSessionId) {
        currentSessionId = 'sess_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now();
      }
      return currentSessionId;
    }
  },

  getDeviceInfo: (): string => {
    if (currentDeviceInfo) return currentDeviceInfo;
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        const ua = navigator.userAgent;
        let browser = 'Browser';
        let os = 'Device';
        if (ua.includes('Edg/')) browser = 'Edge';
        else if (ua.includes('Chrome/')) browser = 'Chrome';
        else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari';
        else if (ua.includes('Firefox/')) browser = 'Firefox';

        if (ua.includes('Windows')) os = 'Windows';
        else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
        else if (ua.includes('Android')) os = 'Android';
        else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
        else if (ua.includes('Linux')) os = 'Linux';

        currentDeviceInfo = `${browser} on ${os}`;
        return currentDeviceInfo;
      }
    } catch {}
    currentDeviceInfo = Platform.OS === 'web' ? 'Web Browser' : `Mobile App (${Platform.OS})`;
    return currentDeviceInfo;
  },
};
