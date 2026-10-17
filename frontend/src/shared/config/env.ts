/**
 * Frontend environment configuration.
 * Variables prefixed with EXPO_PUBLIC_ are automatically embedded by Expo.
 * Configured via frontend/.env.local or frontend/.env
 */

const rawBackendUrl =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  (process.env.EXPO_PUBLIC_API_URL
    ? process.env.EXPO_PUBLIC_API_URL.replace(/\/api\/v1\/?$/, '')
    : 'http://localhost:3000');

// Normalized base URL without trailing slash
export const BACKEND_URL = rawBackendUrl.replace(/\/+$/, '');

// REST API Base URL (defaults to ${BACKEND_URL}/api/v1)
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || `${BACKEND_URL}/api/v1`;

// WebSocket URL for real-time socket.io events
export const SOCKET_URL =
  process.env.EXPO_PUBLIC_SOCKET_URL || BACKEND_URL;
