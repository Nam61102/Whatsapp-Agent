import { Injectable, Logger } from '@nestjs/common';

/**
 * In-memory per-user phonebook cache. The frontend uploads the user's device
 * address book here on login; the chats + contacts endpoints then overlay the
 * saved names onto whatever WhatsApp reported, so the UI matches the user's
 * actual phonebook regardless of platform (works on web too, where expo-contacts
 * cannot read the browser phonebook).
 *
 * The data lives in process memory only — never persisted — and is scoped per
 * authenticated userId. It survives for the lifetime of the Nest process.
 */
@Injectable()
export class DeviceContactsService {
  private readonly logger = new Logger(DeviceContactsService.name);
  private byUser = new Map<string, Map<string, string>>();

  private phoneKey(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 7) return null;
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  setUserContacts(userId: string, pairs: Array<{ phoneNumber: string; name: string }>): number {
    const map = new Map<string, string>();
    for (const p of pairs) {
      if (!p?.phoneNumber || !p?.name) continue;
      const key = this.phoneKey(p.phoneNumber);
      if (!key) continue;
      map.set(key, p.name.trim());
    }
    this.byUser.set(userId, map);
    this.logger.log(`[DeviceContacts] Stored ${map.size} phonebook entries for user ${userId}`);
    return map.size;
  }

  clearUserContacts(userId: string) {
    this.byUser.delete(userId);
  }

  lookup(userId: string, phoneOrJid: string | null | undefined): string | null {
    if (!phoneOrJid) return null;
    const map = this.byUser.get(userId);
    if (!map || map.size === 0) return null;
    const key = this.phoneKey(phoneOrJid);
    if (!key) return null;
    return map.get(key) || null;
  }

  hasAny(userId: string): boolean {
    const map = this.byUser.get(userId);
    return Boolean(map && map.size > 0);
  }

  size(userId: string): number {
    return this.byUser.get(userId)?.size || 0;
  }
}
