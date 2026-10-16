/**
 * Centralized name resolution utility for WhatsApp contacts, groups, and conversations.
 * Guarantees that raw JIDs, phone IDs, or LID numbers are never returned as primary display names.
 */

export function isRawIdentifier(str: string | null | undefined): boolean {
  if (!str) return true;
  const clean = str.trim();
  if (
    clean.includes('@s.whatsapp.net') ||
    clean.includes('@g.us') ||
    clean.includes('@lid') ||
    clean.includes('@broadcast') ||
    clean.includes('@newsletter')
  ) {
    return true;
  }
  // Newsletter or group IDs starting with 120363 or +120363, or LID IDs starting with 10 or 13-16 digit LID numbers
  if (/^\+?120363\d+$/.test(clean) || /^\+?\d{13,16}$/.test(clean)) {
    return true;
  }
  // Group creation timestamp IDs (e.g. 919921812042-1485438313)
  if (/^\d+-\d+$/.test(clean)) {
    return true;
  }
  return false;
}

export function formatPhoneNumber(phone: string | null | undefined): string {
  if (!phone) return '';
  if (isRawIdentifier(phone)) return '';
  const clean = phone.replace(/\D/g, '');
  // E.164 phone numbers must be between 7 and 15 digits, cannot start with 120363, and cannot be 13-16 digit LID IDs not starting with country code 91
  if (
    clean.length < 7 ||
    clean.length > 15 ||
    clean.startsWith('120363') ||
    (clean.length >= 13 && !clean.startsWith('91'))
  ) {
    return '';
  }
  if (clean.length === 12 && clean.startsWith('91')) {
    return `+91 ${clean.slice(2, 7)} ${clean.slice(7)}`;
  }
  if (clean.length === 10) {
    return `+91 ${clean.slice(0, 5)} ${clean.slice(5)}`;
  }
  return `+${clean}`;
}

export function isHumanName(str: string | null | undefined): boolean {
  if (!str) return false;
  const clean = str.trim();
  const lower = clean.toLowerCase();
  if (lower === 'contact' || lower === 'unnamed group' || lower === 'unnamed channel') {
    return false;
  }
  if (isRawIdentifier(clean)) return false;
  // If it's purely digits (or with leading +), it's a phone/LID number, not a human name
  if (/^\+?\d+$/.test(clean)) return false;
  return true;
}

export type ContactNameSource =
  | 'SAVED_CONTACT'
  | 'VERIFIED_NAME'
  | 'PROFILE_NAME'
  | 'PUSH_NAME'
  | 'GROUP_TITLE'
  | 'CHANNEL_TITLE'
  | 'SELF'
  | 'PHONE_NUMBER'
  | 'FALLBACK';

export interface ResolvedContactIdentity {
  displayName: string;
  phoneNumber: string | null;
  avatarUrl: string | null;
  nameSource: ContactNameSource;
}

export function resolveContactIdentity(
  entity?: any,
  fallbackOrTitle?: string | null,
  isGroupHint?: boolean | null
): ResolvedContactIdentity {
  if (!entity && !fallbackOrTitle) {
    return {
      displayName: isGroupHint ? 'Unnamed Group' : 'Contact',
      phoneNumber: null,
      avatarUrl: null,
      nameSource: 'FALLBACK',
    };
  }

  const extId =
    entity?.externalContactId ||
    entity?.externalChatId ||
    entity?.whatsappContactId ||
    entity?.whatsappChatId ||
    entity?.whatsappChatJid ||
    entity?.whatsappJid ||
    '';

  const avatarUrl =
    entity?.profilePhotoUrl ||
    entity?.avatarUrl ||
    entity?.contact?.profilePhotoUrl ||
    entity?.contact?.avatarUrl ||
    null;

  const isSelf =
    entity?.chatType === 'SELF' ||
    Boolean(entity?.isSelfChat) ||
    Boolean(entity?.contact?.isSelfChat);

  if (isSelf) {
    const phone = entity?.contact?.phoneNumber || entity?.phoneNumber;
    const formatted = formatPhoneNumber(phone);
    const displayName = formatted ? `${formatted} (You)` : '+91 70381 28870 (You)';
    return {
      displayName,
      phoneNumber: phone || null,
      avatarUrl,
      nameSource: 'SELF',
    };
  }

  const isNewsletter =
    extId.endsWith('@newsletter') ||
    entity?.chatType === 'CHANNEL' ||
    entity?.chatType === 'BROADCAST';

  if (isNewsletter) {
    const channelName =
      (fallbackOrTitle && isHumanName(fallbackOrTitle) ? fallbackOrTitle.trim() : null) ||
      (entity?.title && isHumanName(entity.title) ? entity.title.trim() : null) ||
      (entity?.displayName && isHumanName(entity.displayName) ? entity.displayName.trim() : null) ||
      (entity?.contact?.displayName && isHumanName(entity.contact.displayName) ? entity.contact.displayName.trim() : null);

    return {
      displayName: channelName || 'Unnamed Channel',
      phoneNumber: null,
      avatarUrl,
      nameSource: 'CHANNEL_TITLE',
    };
  }

  const isGroup =
    Boolean(isGroupHint) ||
    Boolean(entity?.isGroup) ||
    entity?.chatType === 'GROUP' ||
    (entity?.contact && (entity.contact.isGroup || entity.contact.chatType === 'GROUP')) ||
    extId.endsWith('@g.us');

  if (isGroup) {
    const groupName =
      (fallbackOrTitle && isHumanName(fallbackOrTitle) ? fallbackOrTitle.trim() : null) ||
      (entity?.title && isHumanName(entity.title) ? entity.title.trim() : null) ||
      (entity?.displayName && isHumanName(entity.displayName) ? entity.displayName.trim() : null) ||
      (entity?.contact?.displayName && isHumanName(entity.contact.displayName) ? entity.contact.displayName.trim() : null);

    return {
      displayName: groupName || 'Unnamed Group',
      phoneNumber: null,
      avatarUrl,
      nameSource: 'GROUP_TITLE',
    };
  }

  // Individual Contact Resolution
  const isSaved = Boolean(entity?.isSavedContact || entity?.contact?.isSavedContact);
  const phone = entity?.contact?.phoneNumber || entity?.phoneNumber || null;

  // 1. Saved Contact Address Book Name
  if (isSaved) {
    const savedCandidate = entity?.contact?.displayName || entity?.displayName;
    if (savedCandidate && isHumanName(savedCandidate)) {
      return {
        displayName: savedCandidate.trim(),
        phoneNumber: phone,
        avatarUrl,
        nameSource: 'SAVED_CONTACT',
      };
    }
  }

  // 2. Push Name (WhatsApp Display Name)
  const push = entity?.contact?.pushName || entity?.pushName;
  if (push && isHumanName(push)) {
    return {
      displayName: push.trim(),
      phoneNumber: phone,
      avatarUrl,
      nameSource: 'PUSH_NAME',
    };
  }

  // 3. Verified Business Name
  const verified = entity?.contact?.verifiedName || entity?.verifiedName;
  if (verified && isHumanName(verified)) {
    return {
      displayName: verified.trim(),
      phoneNumber: phone,
      avatarUrl,
      nameSource: 'VERIFIED_NAME',
    };
  }

  // 4. Unsaved Display Name Candidate (if valid human name)
  const unsavedCandidate = entity?.contact?.displayName || entity?.displayName;
  if (unsavedCandidate && isHumanName(unsavedCandidate)) {
    return {
      displayName: unsavedCandidate.trim(),
      phoneNumber: phone,
      avatarUrl,
      nameSource: 'PROFILE_NAME',
    };
  }

  if (fallbackOrTitle && isHumanName(fallbackOrTitle)) {
    return {
      displayName: fallbackOrTitle.trim(),
      phoneNumber: entity?.contact?.phoneNumber || entity?.phoneNumber || null,
      avatarUrl,
      nameSource: 'PROFILE_NAME',
    };
  }

  // 5. Real Phone Number (ONLY if valid phone number JID @s.whatsapp.net, NOT LID)
  if (extId.endsWith('@s.whatsapp.net') || (phone && !extId.endsWith('@lid'))) {
    const formatted = formatPhoneNumber(phone || extId.split('@')[0]);
    if (formatted) {
      return {
        displayName: formatted,
        phoneNumber: phone,
        avatarUrl,
        nameSource: 'PHONE_NUMBER',
      };
    }
  }

  return {
    displayName: 'Contact',
    phoneNumber: null,
    avatarUrl,
    nameSource: 'FALLBACK',
  };
}

export function resolveDisplayName(
  entity?: any,
  fallbackOrTitle?: string | null,
  isGroupHint?: boolean | null
): string {
  return resolveContactIdentity(entity, fallbackOrTitle, isGroupHint).displayName;
}
