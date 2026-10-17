import axios from 'axios';
import { AuthStorage } from './authStorage';

import { API_BASE_URL } from '../config/env';

export { API_BASE_URL };

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 45000,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use(async (config) => {
  const token = AuthStorage.getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  try {
    const sessionId = await AuthStorage.getClientSessionId();
    if (sessionId) {
      config.headers['x-client-session-id'] = sessionId;
    }
    const deviceInfo = AuthStorage.getDeviceInfo();
    if (deviceInfo) {
      config.headers['x-device-info'] = deviceInfo;
    }
  } catch {}
  return config;
});

apiClient.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    // Retry on cold start, 502 Bad Gateway (Render deployment/spin-up), or network drop
    const cfg: any = error.config;
    const isColdStartOrNetwork =
      !error.response ||
      error.response.status === 502 ||
      error.response.status === 503 ||
      error.code === 'ECONNABORTED';

    if (cfg && isColdStartOrNetwork && (cfg.method || 'get').toLowerCase() === 'get' && (cfg.__retries || 0) < 3) {
      cfg.__retries = (cfg.__retries || 0) + 1;
      await new Promise((r) => setTimeout(r, 1500 * cfg.__retries));
      return apiClient.request(cfg);
    }
    if (error.response?.status === 401) {
      AuthStorage.clear();
    }
    const message =
      error.response?.data?.message || error.message || 'An unexpected error occurred';
    const customErr: any = new Error(Array.isArray(message) ? message.join(', ') : message);
    customErr.response = error.response;
    customErr.statusCode = error.response?.status;
    return Promise.reject(customErr);
  }
);

