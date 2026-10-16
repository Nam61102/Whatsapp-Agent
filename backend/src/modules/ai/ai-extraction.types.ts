import { createHash } from 'crypto';

/** Bump when the prompt or the output schema changes. Stored on every extraction. */
export const EXTRACTION_VERSION = 'v3';

/**
 * The daily token cap is OFF by default: the app has no setting for it, so nothing should pause.
 * Usage is still recorded. Set AI_TOKEN_LIMIT_ENFORCED=true to enforce UserSettings.dailyTokenLimit again.
 */
export const TOKEN_LIMIT_ENFORCED = (process.env.AI_TOKEN_LIMIT_ENFORCED || 'false').toLowerCase() === 'true';

/**
 * Everything the assistant can save. Legacy rows may also hold OTHER; it is no longer produced
 * (a catch-all attracted junk), so it is not in this list and is rejected by validation.
 */
export const EXTRACTION_TYPES = [
  'TASK', // 1 tasks and to-do items
  'REMINDER', // 2
  'MEETING', // 3 meetings
  'APPOINTMENT', // 3 appointments
  'FOLLOW_UP', // 4
  'DEADLINE', // 5 deadlines and due dates
  'QUESTION', // 6 questions requiring a reply
  'DECISION', // 7 decisions and commitments
  'CONTACT', // 8 contacts and important entities
  'PAYMENT', // 9 payments and financial commitments
  'INVOICE', // 10 invoices and bills
  'ORDER', // 11 orders and deliveries
  'DOCUMENT', // 12 documents and information sharing
  'COMPLAINT', // 13 problems and complaints
  'URGENT', // 14 urgent issues and escalations
  'REQUIREMENT', // 15 customer requirements
  'LEAD', // 16 sales opportunities and leads
  'NEGOTIATION', // 17 negotiations and offers
  'PROJECT_UPDATE', // 18 project updates and milestones
  'CHANGE', // 19 changes, rescheduling and cancellations (when no saved item can be updated)
  'INSTRUCTION', // 20 important facts and instructions
  'PREFERENCE', // 21 customer preferences
  'BUSINESS', // 22 business information
  'TRAVEL', // 23 travel arrangements
  'INTERVIEW', // 24 hiring and interview scheduling
  'RECURRING', // 25 recurring tasks and commitments
  'APPROVAL', // 26 approvals and rejections
  'RENEWAL', // 27 renewals and expiry dates
  'GOAL', // 28 personal goals and plans
  'SUMMARY', // 29 conversation summaries
  'PENDING', // 30 unresolved issues and pending actions
  'WISH', // 31 wishes: anniversary, festival, congratulations, get-well
  'BIRTHDAY', // birthdays and birthday wishes
  'IMPORTANT_EVENT', // weddings, exams, ceremonies
] as const;
export type ExtractionType = (typeof EXTRACTION_TYPES)[number];

/** Types that need a date or the model has nothing concrete to remind about. */
export const DATE_REQUIRED_TYPES: ExtractionType[] = ['APPOINTMENT', 'MEETING', 'TRAVEL', 'DEADLINE', 'INTERVIEW', 'RENEWAL'];

/** Wishes are shown in the Birthdays & Wishes tab and merged to one card per chat per day. */
export const WISH_TYPES: ExtractionType[] = ['BIRTHDAY', 'WISH'];

/** Types where the user is normally expected to answer or act; these also get a suggested reply. */
export const ACK_TYPES: ExtractionType[] = [
  'MEETING', 'APPOINTMENT', 'TASK', 'QUESTION', 'FOLLOW_UP', 'DEADLINE', 'PAYMENT', 'INVOICE',
  'COMPLAINT', 'URGENT', 'APPROVAL', 'INTERVIEW', 'REQUIREMENT', 'LEAD', 'NEGOTIATION',
];

/** A summary only makes sense for a long message; short ones are already their own summary. */
export const SUMMARY_MIN_CHARS = 200;

export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

/** Statuses a user can see in the Action Center. COMPLETED/DISMISSED/CANCELLED only leave on purpose. */
export const OPEN_STATUSES = ['ACTIVE', 'REVIEWED', 'IN_PROGRESS'];
export const CLOSED_STATUSES = ['COMPLETED', 'DISMISSED', 'CANCELLED', 'RESOLVED', 'ARCHIVED'];
export const ALL_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES];

export type JobErrorCategory =
  | 'PROVIDER_TIMEOUT'
  | 'RATE_LIMIT'
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'DATABASE'
  | 'UNKNOWN';

/** Error with a category and a retry decision, so a failed job says where and why it failed. */
export class AIProcessingError extends Error {
  constructor(
    message: string,
    readonly category: JobErrorCategory,
    readonly retryable: boolean = true,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'AIProcessingError';
  }
}

export interface ExtractedItem {
  extractionType: ExtractionType;
  title: string;
  description: string;
  supportingText: string;
  eventDate: string | null;
  eventTime: string | null;
  originalDateText: string | null;
  dateUncertain: boolean;
  priority: (typeof PRIORITIES)[number];
  actionRequired: boolean;
  confidence: number;
  isForCurrentUser: boolean;
  targetPerson: string | null;
  entities: Record<string, unknown>;
  itemKey: string;
}

export interface ExtractionUpdate {
  targetId: string;
  action: 'RESCHEDULE' | 'CANCEL' | 'COMPLETE';
  newEventDate: string | null;
  newEventTime: string | null;
  supportingText: string;
  confidence: number;
}

export interface OpenItemRef {
  ref: string;
  id: string;
  type: string;
  title: string;
  dueAt?: Date | string | null;
}

export const normalizeText = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const looseText = (s: string) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();

/**
 * Identity of one item inside its source message. It depends only on the type and the excerpt
 * copied from the message, never on the title or date the model wrote, so a re-run of the same
 * message yields the same key. Different actions have different excerpts, so they never collide.
 */
export function buildItemKey(type: string, supportingText: string): string {
  return createHash('sha1').update(`${type}|${looseText(supportingText)}`).digest('hex').slice(0, 24);
}

/** Legacy rows have no excerpt: derive a key from what they do have. */
export function buildLegacyItemKey(type: string, title: string): string {
  return 'legacy-' + createHash('sha1').update(`${type}|${looseText(title)}`).digest('hex').slice(0, 18);
}

function tokenSimilarity(a: string, b: string): number {
  const A = new Set(looseText(a).split(' ').filter((w) => w.length > 1));
  const B = new Set(looseText(b).split(' ').filter((w) => w.length > 1));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((w) => B.has(w)).length;
  const jaccard = inter / (A.size + B.size - inter);
  const containment = inter / Math.min(A.size, B.size);
  return Math.max(jaccard, containment >= 0.9 ? containment : 0);
}

/**
 * True when a newly extracted item is the same action as one already saved for the same message
 * (a re-analysis worded or labelled it differently). Distinct actions share few words, so they stay separate.
 */
export function isSameSavedItem(
  existing: { extractionType: string; itemKey?: string | null; supportingText?: string | null; title: string },
  item: { extractionType: string; itemKey: string; supportingText: string; title: string }
): boolean {
  if (existing.itemKey && existing.itemKey === item.itemKey) return true;
  // The model may label the same sentence differently on another run (TASK vs DEADLINE), so the
  // type is deliberately not compared here: the excerpt decides.
  if (existing.supportingText) return tokenSimilarity(existing.supportingText, item.supportingText) >= 0.6;
  // Legacy row without an excerpt: compare titles.
  return tokenSimilarity(existing.title, item.title) >= 0.6 || tokenSimilarity(existing.title, item.supportingText) >= 0.6;
}
