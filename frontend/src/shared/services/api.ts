import axios from 'axios';
import { AuthStorage } from './authStorage';

// Points to the local NestJS backend
export const API_BASE_URL = 'http://localhost:3000/api/v1';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // 30s timeout to accommodate database & AI latency
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
  (error) => {
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

