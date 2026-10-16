import { isRawIdentifier } from './name-resolver';

export interface NameableContact {
  displayName?: string | null;
  isSavedContact?: boolean | null;
  phoneNumber?: string | null;
  externalContactId?: string | null;
  pushName?: string | null;
  profilePhotoUrl?: string | null;
}

export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // A LID is an internal id, not a phone number. Only the LID→phone mapping may link it.
  if (raw.includes('@lid')) return null;
  // Drop the JID domain and any device suffix (917030513050:12@s.whatsapp.net).
  const base = raw.split('@')[0].split(':')[0];
  const digits = base.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function isLidJid(jid: string | null | undefined): boolean {
  return Boolean(jid && jid.includes('@lid'));
}

/** Stable id for a LID, with or without its @lid suffix, so both forms compare equal. */
export function lidId(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits || null;
}

export function isHumanName(str: string | null | undefined): boolean {
  if (!str) return false;
  const clean = str.trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (['contact', 'whatsapp contact', 'unnamed group', 'unnamed channel', 'group member'].includes(lower)) {
    return false;
  }
  if (isRawIdentifier(clean)) return false;
  if (/^\+?\d+$/.test(clean)) return false;
  return true;
}

/** Higher is better. The single rule for which duplicate row represents a person. */
export function contactScore(c: NameableContact): number {
  let score = 0;
  if (c.isSavedContact) score += 100;
  if (isHumanName(c.displayName)) score += 50;
  if (c.phoneNumber) score += 5;
  if (c.profilePhotoUrl) score += 2;
  if (c.pushName && isHumanName(c.pushName)) score += 1;
  return score;
}

export function pickBestContact<T extends NameableContact>(rows: T[]): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    if (!best || contactScore(r) > contactScore(best)) best = r;
  }
  return best;
}

/**
 * Decides the stored name and saved flag after an update from WhatsApp.
 * - A saved phonebook name is never replaced by a push name or phone number.
 * - The saved flag is sticky: a later sync that omits the address-book name must
 *   not make a saved contact look unsaved (that is what made names flip).
 */
export function nextContactName(
  existing: NameableContact | null | undefined,
  incoming: { name?: string | null; isSaved?: boolean }
): { displayName: string | null; isSavedContact: boolean } {
  const existingSaved = Boolean(existing?.isSavedContact);
  const incomingSaved = Boolean(incoming.isSaved);
  const isSavedContact = existingSaved || incomingSaved;

  const incomingName = incoming.name && isHumanName(incoming.name) ? incoming.name.trim() : null;
  const existingName = existing?.displayName && isHumanName(existing.displayName) ? existing.displayName.trim() : null;

  if (existingSaved && !incomingSaved && existingName) {
    return { displayName: existingName, isSavedContact };
  }
  if (incomingName) return { displayName: incomingName, isSavedContact };
  return { displayName: existingName ?? existing?.displayName ?? null, isSavedContact };
}
