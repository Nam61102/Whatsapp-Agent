import { io, Socket } from 'socket.io-client';
import { AuthStorage } from './authStorage';
import { SOCKET_URL } from '../config/env';

export { SOCKET_URL };

class SocketService {
  private socket: Socket | null = null;
  private listeners: Map<string, Set<(data: any) => void>> = new Map();
  private isBfCacheListenerAdded = false;

  constructor() {
    this.setupBfCacheHandler();
  }

  private setupBfCacheHandler() {
    if (typeof window !== 'undefined' && window.addEventListener && !this.isBfCacheListenerAdded) {
      this.isBfCacheListenerAdded = true;
      window.addEventListener('pageshow', (event) => {
        if (event.persisted || !this.socket?.connected) {
          console.log('[Socket] Page restored from Back-Forward Cache. Reconnecting WebSocket...');
          this.reconnect();
        }
      });
      window.addEventListener('focus', () => {
        if (this.socket && !this.socket.connected) {
          console.log('[Socket] Window focused. Re-establishing socket connection...');
          this.reconnect();
        }
      });
    }
  }

  reconnect() {
    if (this.socket) {
      try {
        this.socket.disconnect();
      } catch {}
      this.socket = null;
    }
    this.connect();
  }

  connect() {
    if (this.socket?.connected) return;

    if (this.socket && !this.socket.connected) {
      this.socket.connect();
      return;
    }

    const token = AuthStorage.getToken();
    if (!token) return;

    this.socket = io(SOCKET_URL, {
      auth: { token },
      query: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 30,
      reconnectionDelay: 1000,
      autoConnect: true,
    });

    this.socket.on('connect', () => {
      console.log('[Socket] Connected to backend gateway');
      const user = AuthStorage.getUser();
      if (user?.whatsappAccount?.id) {
        this.socket?.emit('join_account', {
          whatsappAccountId: user.whatsappAccount.id,
          accountId: user.whatsappAccount.id,
        });
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      if (reason === 'io server disconnect' || reason === 'transport close') {
        setTimeout(() => this.connect(), 1000);
      }
    });

    // Wire up registered event handlers
    this.listeners.forEach((callbacks, event) => {
      callbacks.forEach((cb) => {
        this.socket?.on(event, cb);
      });
    });
  }

  joinAccount(accountId: string) {
    if (this.socket?.connected) {
      this.socket.emit('join_account', {
        whatsappAccountId: accountId,
        accountId,
      });
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  on(event: string, callback: (data: any) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    if (this.socket) {
      this.socket.on(event, callback);
    }

    return () => this.off(event, callback);
  }

  off(event: string, callback: (data: any) => void) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.delete(callback);
    }
    if (this.socket) {
      this.socket.off(event, callback);
    }
  }

  emit(event: string, data: any) {
    if (this.socket?.connected) {
      this.socket.emit(event, data);
    }
  }
}

export const socketService = new SocketService();
