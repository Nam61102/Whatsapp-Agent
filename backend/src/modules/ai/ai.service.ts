import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EventsGateway } from '../gateway/events.gateway';
import { isRawIdentifier, resolveDisplayName } from '../../shared/name-resolver';
import {
  AIProcessingError,
  buildItemKey,
  DATE_REQUIRED_TYPES,
  EXTRACTION_TYPES,
  EXTRACTION_VERSION,
  ExtractedItem,
  ExtractionType,
  ExtractionUpdate,
  isSameSavedItem,
  ACK_TYPES,
  SUMMARY_MIN_CHARS,
  TOKEN_LIMIT_ENFORCED,
  WISH_TYPES,
  OPEN_STATUSES,
  OpenItemRef,
  PRIORITIES,
} from './ai-extraction.types';

export interface ReplySuggestionItem {
  text: string;
  tone: string;
  confidence: number;
  language?: string;
}

export interface ExtractionResult {
  extractionType: string;
  title: string;
  summary: string;
  eventDate?: string | null;
  importanceScore: number;
  confidenceScore: number;
  extractedData?: any;
}

/** One like or dislike with the exact words from the chat that prove it. */
export interface ProfileItem {
  item: string;
  evidence: string;
}

export interface GeminiCallResult {
  text: string;
  /** True when the model stopped because it hit the token limit (output is cut off). */
  truncated?: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// One small pattern per kind of promotion, so each can be read and changed on its own.
const PROMO_PATTERNS: RegExp[] = [
  /t\.me\//,
  /chat\.whatsapp\.com/,
  /whatsapp\.com\/channel/,
  /wa\.me\//,
  /amzn\.to|amazon\.in\/|flipkart\.com|fkrt\.|bit\.ly|myntra|ajio\.|meesho|forms\.gle|linkedin\.com\/jobs/,
  /join (our |the |us |my )?(whatsapp|telegram|channel|group|community)/,
  /\bloot\b/,
  /special session/,
  /hiring drive|off[- ]?campus|recruitment|vacanc(y|ies)|walk[- ]?in/,
  /apply (now|here|link)|register (now|here)/,
  /free (course|webinar|session|demo)/,
  /coupon|cashback|\d+% ?off/,
  /limited (time|seats)/,
  /flatmates? required|rooms? (available|for rent)/,
  /follow (us|our)/,
  /internship 20\d\d|job (alerts?|openings?|updates?)|admit card|placement success|urgent requirement|room ?mate/,
  // Flat and room listings, and automated class reminders
  /for rent|no brokerage|move-in|room ?partner|flat ?mate|needed urgently|\d ?bhk|रूम पार्टनर|रूममेट|फ्लॅट/,
  /\d+ mins? to go|class scheduled|day \d+ class/,
  /\bhiring\b.*\b(freshers?|engineer|developer|analyst|intern)\b/,
];

/**
 * Words of the wider categories: invoices, orders, documents, complaints, urgent issues, leads and
 * quotes, projects, approvals, renewals, recurring tasks, instructions, pending items. Very common
 * chat words ("need", "plan", "update") are left out so ordinary conversation is not sent to the AI.
 */
const CATEGORY_WORDS =
  /\b(invoice|bill|receipt|orders?|ordered|deliver(y|ed)|shipment|shipped|tracking|dispatched|refund|pdf|attached|attachment|complaint|defect|broken|not working|urgent|asap|escalat\w*|immediately|requirements?|enquiry|inquiry|quotation|quote|negotiat\w*|proposal|milestone|project update|status update|progress report|approve[ds]?|approval|reject(ed)?|renew\w*|expir\w*|validity|every (day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|goal|resched\w*|postpone\w*|cancel\w*|prefer\w*|instructions?|please note|don'?t forget|pending|awaiting|decided|agreed|will do)\b/;

/** Anniversary, festival, congratulation and get-well wishes (birthdays are matched separately). */
const WISH_WORDS =
  /congrat\w*|anniversary|best wishes|happy (diwali|holi|eid|christmas|new year|navratri|dussehra|ganesh|rakhi|raksha|pongal|onam|baisakhi|lohri|makar|gudi|independence|republic|teachers?|friendship|women|mother|father|valentine)|merry christmas|get well|all the best|good luck|wish(es)? you|mubarak|shubh\w*|badhai|abhinandan|शुभेच्छा|शुभ |बधाई|अभिनंदन|मुबारक/;

const FOLLOW_UP_LABELS: Record<string, string> = {
  TASK: '✅ Task',
  REMINDER: '⏰ Reminder',
  FOLLOW_UP: '🔄 Follow Up',
  APPOINTMENT: '📅 Appointment',
  MEETING: '📅 Meeting',
  DEADLINE: '⏳ Deadline',
  PAYMENT: '💰 Payment',
  TRAVEL: '✈️ Travel',
  IMPORTANT_EVENT: '⭐ Event',
  DECISION: '🤝 Decision',
  CONTACT: '👤 Contact',
  BUSINESS: '💼 Business',
  QUESTION: '❓ Question',
  INVOICE: '🧾 Invoice',
  ORDER: '📦 Order',
  DOCUMENT: '📄 Document',
  COMPLAINT: '⚠️ Complaint',
  URGENT: '🚨 Urgent',
  REQUIREMENT: '📝 Requirement',
  LEAD: '🎯 Lead',
  NEGOTIATION: '🤝 Negotiation',
  PROJECT_UPDATE: '📈 Project Update',
  CHANGE: '🔀 Change',
  INSTRUCTION: '📌 Instruction',
  PREFERENCE: '⭐ Preference',
  INTERVIEW: '🧑‍💼 Interview',
  RECURRING: '🔁 Recurring',
  APPROVAL: '✔️ Approval',
  RENEWAL: '♻️ Renewal',
  GOAL: '🏁 Goal',
  SUMMARY: '🗒️ Summary',
  PENDING: '⏳ Pending',
  WISH: '🎉 Wishes',
  OTHER: '📌 Note',
};

@Injectable()
export class AIService implements OnModuleInit {
  private readonly logger = new Logger(AIService.name);
  /** Server-side only. Never logged, never sent to the frontend. */
  private get apiKey(): string {
    return (process.env.OPENROUTER_API_KEY || '').trim();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway
  ) {}

  async onModuleInit() {
    await this.cleanupInvalidReplySuggestions();
  }

  async cleanupInvalidReplySuggestions(): Promise<void> {
    try {
      // Deduplicate suggestions by sourceMessageId (keep newest 1 per sourceMessageId)
      const allSuggestions = await this.prisma.aIReplySuggestion.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, sourceMessageId: true },
      });

      const seenSourceIds = new Set<string>();
      const duplicateIdsToDelete: string[] = [];

      for (const s of allSuggestions) {
        if (seenSourceIds.has(s.sourceMessageId)) {
          duplicateIdsToDelete.push(s.id);
        } else {
          seenSourceIds.add(s.sourceMessageId);
        }
      }

      if (duplicateIdsToDelete.length > 0) {
        await this.prisma.aIReplySuggestion.deleteMany({
          where: { id: { in: duplicateIdsToDelete } },
        });
        this.logger.log(`Deduplicated ${duplicateIdsToDelete.length} duplicate AI reply suggestions.`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to clean up junk AI reply suggestions: ${err.message}`);
    }
  }

  /**
   * Invokes OpenRouter API and captures exact usage tokens.
   * Throws AIProcessingError (with a category and retry decision) on every failure.
   */
  private async callGeminiWithTokens(
    prompt: string,
    options: { maxTokens?: number; json?: boolean; timeoutMs?: number } = {}
  ): Promise<GeminiCallResult> {
    if (!this.apiKey) {
      // Not retryable: retrying cannot fix a missing key. Set it, then retry the failed jobs.
      throw new AIProcessingError('OPENROUTER_API_KEY is not configured on the server', 'PROVIDER_ERROR', false);
    }
    const url = 'https://openrouter.ai/api/v1/chat/completions';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.APP_URL || 'https://whatsapp-ai.local',
            'X-Title': 'VAI-4 WhatsApp AI',
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: options.maxTokens ?? 1024,
            ...(options.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        });
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          throw new AIProcessingError('OpenRouter request timed out', 'PROVIDER_TIMEOUT');
        }
        throw new AIProcessingError(`OpenRouter request failed: ${err.message}`, 'PROVIDER_ERROR');
      }

      if (!response.ok) {
        const errorText = (await response.text().catch(() => '')).slice(0, 300);
        this.logger.error(`OpenRouter API call failed (${response.status}): ${errorText}`);
        if (response.status === 429) {
          const wait = Number(response.headers.get('retry-after'));
          throw new AIProcessingError('OpenRouter rate limit', 'RATE_LIMIT', true, wait > 0 ? wait * 1000 : undefined);
        }
        if (response.status === 408) throw new AIProcessingError('OpenRouter timeout', 'PROVIDER_TIMEOUT');
        // A bad key or bad request will not fix itself on retry; a 5xx will.
        throw new AIProcessingError(`OpenRouter API error: ${response.status}`, 'PROVIDER_ERROR', response.status >= 500);
      }

      let data: any;
      try {
        data = await response.json();
      } catch (err: any) {
        if (err?.name === 'AbortError') throw new AIProcessingError('OpenRouter response timed out', 'PROVIDER_TIMEOUT');
        throw new AIProcessingError('OpenRouter returned a non-JSON body', 'INVALID_RESPONSE');
      }
      const choice = data.choices?.[0];
      const text = choice?.message?.content || '';
      const usage = data.usage || {};

      const inputTokens = usage.prompt_tokens || Math.ceil(prompt.length / 4);
      const outputTokens = usage.completion_tokens || Math.ceil(text.length / 4);
      const totalTokens = usage.total_tokens || inputTokens + outputTokens;

      return { text, inputTokens, outputTokens, totalTokens, truncated: choice?.finish_reason === 'length' };
    } finally {
      clearTimeout(timer);
    }
  }

  private cleanJson(raw: string): string {
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const firstBracket = cleaned.indexOf('[');
    const lastBracket = cleaned.lastIndexOf(']');

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      if (lastBracket > firstBracket) {
        return cleaned.substring(firstBracket, lastBracket + 1);
      }
    }
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return cleaned.substring(firstBrace, lastBrace + 1);
    }
    return cleaned;
  }

  /**
   * Checks if user has enough token budget remaining for today.
   */
  async checkTokenBudget(userId: string, whatsappAccountId: string): Promise<boolean> {
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    const dailyLimit = settings?.dailyTokenLimit || 100000;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Reset daily tokens if new day
    if (settings && settings.lastTokenResetDate < startOfDay) {
      await this.prisma.userSettings.update({
        where: { userId },
        data: { usedTokensToday: 0, lastTokenResetDate: now },
      });
      return true;
    }

    if (!TOKEN_LIMIT_ENFORCED) return true;

    const usedToday = settings?.usedTokensToday || 0;
    if (usedToday >= dailyLimit) {
      this.logger.warn(`[TOKEN_LIMIT] User ${userId} reached daily AI token limit (${usedToday}/${dailyLimit}).`);
      this.eventsGateway.sendToUser(userId, 'ai:token-limit', {
        paused: true,
        message: 'AI analysis paused. Your configured daily AI token limit has been reached. WhatsApp messages continue syncing normally.',
        usedToday,
        dailyLimit,
      });
      return false;
    }

    return true;
  }

  /**
   * Records token consumption in database.
   */
  async recordTokenUsage(
    userId: string,
    whatsappAccountId: string,
    inputTokens: number,
    outputTokens: number,
    totalTokens: number,
    processingType: string,
    jobId?: string
  ): Promise<void> {
    try {
      await this.prisma.aITokenUsageLog.create({
        data: {
          userId,
          whatsappAccountId,
          jobId,
          processingType,
          model: 'gemini-3.6-flash',
          inputTokens,
          outputTokens,
          totalTokens,
        },
      });

      await this.prisma.userSettings.update({
        where: { userId },
        data: {
          usedTokensToday: { increment: totalTokens },
          usedTokensThisMonth: { increment: totalTokens },
        },
      });
    } catch (err: any) {
      this.logger.error(`Failed to record AI token usage: ${err.message}`);
    }
  }

  /**
   * Filters out low-value messages (greetings, emoji, noise, media without text).
   */
  isMessageEligibleForAI(text: string): boolean {
    if (!text || text.trim().length === 0) return false;

    const trimmed = text.trim();
    if (trimmed.length < 4) return false;

    const noisePatterns = /^(hi|hey|hello|k|ok|okay|bye|gm|gn|tc|good morning|good night|thanks|thank you|thx|haan|ha|theek hai|yes|no|hmm|haha|lol|sirna ka|sir na ka|agent pahije|planning nahi|hoil ka|hoil|zale ka|zal|kiti|kiti ahe|kasa|kasa ahes|kashi|kuthay|kashala|kay re|kay|bol|bol na|accha|accha ok|barobar|kahi nahi|mag|bhau|bhai|bro|dude|good afternoon|good evening|welcome|same to you|sure|done|cool|nice|great|yep|nope|bbye|👍|🙏|❤️|😊|😂|🤣)+$/i;
    if (noisePatterns.test(trimmed)) {
      return false;
    }

    // Word count check: If 1 or 2 words without explicit question mark or actionable keywords, skip
    const words = trimmed.split(/\s+/);
    if (
      words.length <= 2 &&
      !trimmed.includes('?') &&
      !/(meet|call|pay|send|time|date|today|tomorrow|report|file|address|location|amount|rs|₹|\$|urgent|important|due|booking)/i.test(trimmed)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Cheap pre-filter: only messages that mention a birthday, a date/time, an amount or an
   * event keyword are sent to the extraction model. Everything else is normal chat.
   */
  hasExtractionSignal(text: string): boolean {
    const t = (text || '').toLowerCase();
    const birthday = /birth\s?day|b'?day|bday|janm\s?din|janamdin|वाढदिवस|जन्मदिन|बर्थडे/;
    const money = /(₹|\brs\.?|\brupees?\b|\binr\b)\s?\d|\d\s?(₹|\brs\b|\brupees?\b)/;
    // Event, task and commitment words. Plain chat rarely contains these.
    const keyword =
      /\b(meeting|meet|appointment|interview|exam|deadline|due|submit|submission|booking|booked|ticket|flight|train|bus|hotel|check[- ]?in|pay|payment|fees?|invoice|emi|wedding|lagna|engagement|ceremony|function|seminar|viva|result|remind|reminder|follow ?up|send|share|bhej|bhejo|bhejna|bhejta|dunga|denge|karunga|karenge|karto|karen|review|confirm|quotation|quote|order|requirement|proposal|reschedule|postpone|cancel|cancelled|completed|sent|done|phone|number|email|address|venue)\b/;
    if (birthday.test(t)) return true;
    // Ads and broadcasts are never personal items, even when they mention dates and prices.
    if (this.looksPromotional(text)) return false;
    // "5 baje", "10 vajta", "20 tarikh", "4pm": a time or date written the Indian way is a plan or a deadline.
    const timePhrase = /\b\d{1,2}([:.]\d{2})?\s?(baje|bajta|vajta|vaje|am|pm)\b|\b\d{1,2}\s?(tarikh|taarikh|tareekh|tarkhela)\b|\b\d{1,2}[:.]\d{2}\b/;
    return money.test(t) || keyword.test(t) || timePhrase.test(t) || CATEGORY_WORDS.test(t) || WISH_WORDS.test(t);
  }

  /**
   * Stricter filter for bulk scans of old messages (after a clear or when AI is switched on):
   * a birthday, an amount, or an event word together with a date or time. Casual chat that merely
   * contains "call" or "send" does not qualify. Live messages use the looser hasExtractionSignal
   * because short follow-ups ("The proposal has been sent.") can update items already saved.
   */
  hasStrongSignal(text: string): boolean {
    if (!this.hasExtractionSignal(text)) return false;
    const t = (text || '').toLowerCase();
    if (/birth\s?day|b'?day|bday|janm\s?din|janamdin|वाढदिवस|जन्मदिन|बर्थडे/.test(t)) return true;
    const money = /(₹|\brs\.?|\brupees?\b|\binr\b)\s?\d|\d\s?(₹|\brs\b|\brupees?\b)/.test(t);
    const when =
      /\b\d{1,2}[:.]\d{2}\b|\b\d{1,2}\s?(am|pm)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|kal|parso|udya|uddya)\b|उद्या|कल|परवा/.test(t);
    const indianTime = /\b\d{1,2}([:.]\d{2})?\s?(baje|bajta|vajta|vaje)\b|\b\d{1,2}\s?(tarikh|taarikh|tareekh|tarkhela)\b/.test(t);
    // Also strong on their own: wishes, and the clearest business signals.
    const strongWords = /\b(invoice|urgent|asap|complaint|renew\w*|expir\w*|approved|rejected|escalat\w*)\b/.test(t);
    return money || when || indianTime || WISH_WORDS.test(t) || strongWords;
  }

  /**
   * Ads and broadcasts (shopping deals, job-drive posts, "join our channel"): never personal, never
   * worth an AI call, never a reply. Birthdays are checked before this, so a wish is never blocked.
   */
  looksPromotional(text: string): boolean {
    // NFKC turns styled letters (bold/italic Unicode used in broadcasts) into plain ones.
    const t = (text || '').normalize('NFKC').toLowerCase();
    return PROMO_PATTERNS.some((re) => re.test(t));
  }

  /** A reply is only worth suggesting when the message asks something or requests something. */
  needsReplySignal(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (t.includes('?')) return true;
    return /\b(kya|kay|kab|kadhi|kuthe|kahan|kaun|kon|kasa|kaisa|kitna|kiti|kyun|kashala|when|what|where|who|how|why|which|can you|could you|will you|are you|do you|did you|have you|please|plz|pls|let me know|bata|batao|sang|sangna|bhej|bhejo|send|confirm|reply|aa ja|yeshil|yetoy|karshil|karoge|ho jayega|hoil ka|hai kya|ahe ka)\b/.test(t);
  }

  /**
   * WhatsApp shows a mention as "@127831229104315". Map such ids to the names of the user's contacts
   * so "Happy birthday @127831229104315" becomes "Happy birthday @Dabhade".
   */
  async resolveMentions(userId: string, texts: string[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const t of texts) for (const m of (t || '').matchAll(/@(\d{6,})/g)) ids.add(m[1]);
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    try {
      const list = [...ids];
      const [contacts, lidMaps] = await Promise.all([
        this.prisma.contact.findMany({
          where: {
            userId,
            isGroup: false,
            OR: list.flatMap((id) => [{ lid: { startsWith: id } }, { externalContactId: { startsWith: id } }, { phoneNumber: { contains: id } }]),
          },
          select: { displayName: true, lid: true, externalContactId: true, phoneNumber: true },
        }),
        this.prisma.lIDMapping.findMany({ where: { userId, OR: list.map((id) => ({ lid: { startsWith: id } })) } }),
      ]);
      const phoneJids = lidMaps.map((l) => l.phoneJid);
      const viaPhone = phoneJids.length
        ? await this.prisma.contact.findMany({
            where: { userId, externalContactId: { in: phoneJids } },
            select: { displayName: true, externalContactId: true },
          })
        : [];
      const usable = (n?: string | null) => (n && !isRawIdentifier(n) ? n : null);
      for (const id of list) {
        const direct = contacts.find((c) => (c.lid || '').startsWith(id) || c.externalContactId.startsWith(id) || (c.phoneNumber || '').includes(id));
        let name = usable(direct?.displayName);
        if (!name) {
          const map = lidMaps.find((l) => l.lid.startsWith(id));
          name = usable(viaPhone.find((c) => c.externalContactId === map?.phoneJid)?.displayName);
        }
        if (name) out.set(id, name);
      }
    } catch (err: any) {
      this.logger.warn(`Mention lookup failed: ${err.message}`);
    }
    return out;
  }

  /** In groups a reply is only for messages that name the user. */
  private mentionsUser(text: string, userName: string): boolean {
    const first = (userName || '').trim().split(/\s+/)[0]?.toLowerCase();
    if (!first || first.length < 3) return false;
    return (text || '').toLowerCase().includes(first);
  }

  /** Open (not completed/dismissed/cancelled) items of a chat, offered to the model so it can update them. */
  private async loadOpenItems(userId: string, conversationId: string): Promise<OpenItemRef[]> {
    const open = await this.prisma.aIExtraction.findMany({
      where: { userId, conversationId, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, extractionType: true, title: true, eventDate: true },
    });
    return open.map((o, i) => ({
      ref: `E${i + 1}`,
      id: o.id,
      type: o.extractionType,
      title: o.title,
      dueAt: o.eventDate,
    }));
  }

  /**
   * Saves validated items (one row each, atomically) and applies validated updates.
   * Safe to run twice for the same message: items are matched by itemKey, updates by message id.
   */
  async persistExtractionResult(ctx: {
    userId: string;
    whatsappAccountId: string;
    conversationId: string;
    contactId?: string | null;
    messageId: string;
    messageTimestamp?: Date | null;
    items: ExtractedItem[];
    updates: ExtractionUpdate[];
    senderName: string;
    groupName: string | null;
  }): Promise<{ created: any[]; updated: any[] }> {
    const { userId, whatsappAccountId, conversationId, contactId, messageId } = ctx;

    // Items already saved for this message (same key, or the same action worded slightly differently)
    const saved = await this.prisma.aIExtraction.findMany({
      where: { messageId },
      select: { extractionType: true, itemKey: true, supportingText: true, title: true },
    });
    let fresh: ExtractedItem[] = [];
    for (const item of ctx.items) {
      if (!saved.some((s) => isSameSavedItem(s as any, item))) fresh.push(item);
    }

    // A group often sends many wishes for one birthday. Keep ONE card per person per day.
    // Festival, anniversary and other wishes: one card per chat per day.
    if (fresh.some((i) => WISH_TYPES.includes(i.extractionType))) {
      const sameDay = await this.prisma.aIExtraction.findMany({
        where: { conversationId, extractionType: { in: WISH_TYPES as string[] } },
        select: { extractionType: true, eventDate: true, structuredData: true },
      });
      const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '');
      const norm = (n: unknown) => (typeof n === 'string' ? n.toLowerCase().trim() : '');
      const seen: { type: string; day: string; person: string }[] = sameDay.map((e) => ({
        type: e.extractionType,
        day: day(e.eventDate),
        person: norm((e.structuredData as any)?.birthdayPerson),
      }));
      fresh = fresh.filter((item) => {
        if (!WISH_TYPES.includes(item.extractionType)) return true;
        const person = norm(item.targetPerson);
        const dup = seen.some(
          (s) =>
            s.type === item.extractionType &&
            s.day === (item.eventDate || '') &&
            // plain wishes: one per chat per day. Birthdays: an unnamed wish is the same birthday as any
            // already saved that day in this chat; named ones are compared by name.
            (item.extractionType === 'WISH' ||
              !person ||
              (s.person && (s.person === person || s.person.includes(person) || person.includes(s.person))))
        );
        if (!dup) seen.push({ type: item.extractionType, day: item.eventDate || '', person });
        return !dup;
      });
    }

    const buildCreate = (item: ExtractedItem) =>
      this.prisma.aIExtraction.create({
        data: {
          userId,
          whatsappAccountId,
          conversationId,
          contactId: contactId || null,
          messageId,
          itemKey: item.itemKey,
          extractionType: item.extractionType,
          title:
            item.extractionType === 'BIRTHDAY' && !item.targetPerson
              ? `Birthday wishes${ctx.groupName ? ` in ${ctx.groupName}` : ''}`
              : item.title,
          summary: item.description,
          description: item.description,
          supportingText: item.supportingText,
          originalDateText: item.originalDateText,
          timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
          priority: item.priority,
          actionRequired: item.actionRequired,
          eventDate: item.eventDate ? new Date(item.eventDate) : null,
          importanceScore: item.priority === 'URGENT' ? 1 : item.priority === 'HIGH' ? 0.8 : item.priority === 'LOW' ? 0.3 : 0.5,
          confidenceScore: item.confidence,
          structuredData: {
            targetPerson: item.extractionType === 'BIRTHDAY' ? item.targetPerson : item.targetPerson || ctx.senderName,
            birthdayPerson: item.extractionType === 'BIRTHDAY' ? item.targetPerson : null,
            senderName: ctx.senderName,
            groupName: ctx.groupName,
            isForCurrentUser: item.isForCurrentUser,
            eventTime: item.eventTime,
            dateUncertain: item.dateUncertain,
            entities: item.entities as any,
            requiresFollowUp: item.actionRequired,
          } as any,
          status: 'ACTIVE',
          extractionVersion: EXTRACTION_VERSION,
          history: [],
          aiModel: 'google/gemini-2.5-flash',
          sources: { create: { userId, whatsappAccountId, messageId, relevanceScore: 1.0 } },
        },
        include: {
          contact: { select: { displayName: true, profilePhotoUrl: true } },
          message: { select: { id: true, textContent: true, messageTimestamp: true } },
        },
      });

    // All items of a message are saved together. If another worker saved the same item first the
    // unique index rejects it (P2002); that means "already saved", so keep the others.
    let created: any[] = [];
    if (fresh.length > 0) {
      try {
        created = await this.prisma.$transaction(fresh.map(buildCreate));
      } catch (err: any) {
        // P2002 = another worker saved the same item first. P2034 = MongoDB aborted the transaction
        // because a concurrent writer touched the same data. Neither is a failure: fall back to one
        // item at a time, skip what already exists, and retry briefly on write conflicts.
        if (err?.code !== 'P2002' && err?.code !== 'P2034') throw err;
        created = [];
        for (const item of fresh) {
          for (let attempt = 0; attempt < 6; attempt++) {
            try {
              created.push(await buildCreate(item));
              break;
            } catch (e: any) {
              if (e?.code === 'P2002') break; // already saved by someone else
              if (e?.code === 'P2034' && attempt < 5) {
                await new Promise((r) => setTimeout(r, 25 * (attempt + 1) + Math.random() * 25));
                continue;
              }
              throw e;
            }
          }
        }
      }
    }

    const updated: any[] = [];
    for (const u of ctx.updates) {
      const target: any = await this.prisma.aIExtraction.findFirst({
        where: { id: u.targetId, userId, conversationId },
        include: { message: { select: { messageTimestamp: true } } },
      });
      if (!target || !OPEN_STATUSES.includes(target.status)) continue;
      // A message cannot change the item it created.
      if (target.messageId === messageId) continue;

      const history: any[] = Array.isArray(target.history) ? (target.history as any[]) : [];
      if (history.some((h) => h?.messageId === messageId && h?.action === u.action)) continue; // already applied

      // Only a newer message may change an item. Re-analysing an old message must not undo later changes.
      if (ctx.messageTimestamp) {
        const lastChange = Math.max(
          target.message?.messageTimestamp ? new Date(target.message.messageTimestamp).getTime() : 0,
          ...history.map((h) => (h?.messageTimestamp ? Date.parse(h.messageTimestamp) : 0))
        );
        if (ctx.messageTimestamp.getTime() <= lastChange) continue;
      }

      const sd: any = target.structuredData && typeof target.structuredData === 'object' ? target.structuredData : {};
      const entry = {
        at: new Date().toISOString(),
        messageId,
        messageTimestamp: ctx.messageTimestamp ? ctx.messageTimestamp.toISOString() : null,
        action: u.action,
        supportingText: u.supportingText,
        before: { eventDate: target.eventDate, eventTime: sd.eventTime ?? null, status: target.status },
      };
      const data: any = {};
      if (u.action === 'RESCHEDULE') {
        if (u.newEventDate) data.eventDate = new Date(u.newEventDate);
        data.structuredData = { ...sd, eventTime: u.newEventTime ?? sd.eventTime ?? null, dateUncertain: false };
      } else if (u.action === 'CANCEL') {
        data.status = 'CANCELLED';
      } else {
        data.status = 'COMPLETED';
      }
      data.history = [...history, { ...entry, after: { eventDate: data.eventDate ?? target.eventDate, eventTime: data.structuredData?.eventTime ?? sd.eventTime ?? null, status: data.status ?? target.status } }];

      updated.push(await this.prisma.aIExtraction.update({ where: { id: target.id }, data }));
    }

    return { created, updated };
  }

  private toProcessingError(err: any, stage: string): AIProcessingError {
    if (err instanceof AIProcessingError) return err;
    const isDb = stage === 'PERSISTENCE' || stage === 'LOAD' || err?.code?.startsWith?.('P');
    return new AIProcessingError(err?.message || 'Unknown error', isDb ? 'DATABASE' : 'UNKNOWN', true);
  }

  /**
   * Main AI Queue Worker Handler — processes a single queued message job.
   * The message itself is already stored; a failure here never touches it.
   */
  async processMessageAIJob(jobPayload: {
    messageId: string;
    conversationId: string;
    whatsappAccountId: string;
    userId: string;
    jobType?: string;
  }): Promise<void> {
    const { messageId, conversationId, whatsappAccountId, userId } = jobPayload;
    const idempotencyKey = `${whatsappAccountId}:${messageId}:${jobPayload.jobType || 'MESSAGE_ANALYSIS'}`;

    const job = await this.prisma.aIProcessingJob.findUnique({ where: { idempotencyKey } });
    if (!job || job.status === 'COMPLETED' || job.status === 'SKIPPED') return;

    const skip = (errorMessage: string) =>
      this.prisma.aIProcessingJob.update({ where: { id: job.id }, data: { status: 'SKIPPED', errorMessage } });

    let stage = 'LOAD';
    try {
      // Claim the job atomically so two workers (or a retry racing the first run) cannot both process it.
      const claim = await this.prisma.aIProcessingJob.updateMany({
        where: {
          id: job.id,
          OR: [
            { status: { in: ['QUEUED', 'RETRYING', 'PAUSED_TOKEN_LIMIT', 'FAILED'] } },
            { status: 'PROCESSING', updatedAt: { lte: new Date(Date.now() - 5 * 60 * 1000) } },
          ],
        },
        data: { status: 'PROCESSING', startedAt: new Date(), lastAttemptAt: new Date() },
      });
      if (claim.count === 0) return;

      const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
      if (settings && !settings.autoAIAnalysis) {
        await skip('Automatic AI Analysis disabled in settings');
        return;
      }

      if (!(await this.checkTokenBudget(userId, whatsappAccountId))) {
        await this.prisma.aIProcessingJob.update({
          where: { id: job.id },
          data: { status: 'PAUSED_TOKEN_LIMIT', errorMessage: 'Daily token budget reached' },
        });
        return;
      }

      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      const currentUserName = user?.name || 'User';

      const message = await this.prisma.message.findUnique({
        where: { id: messageId },
        include: { senderContact: true, conversation: { include: { contact: true } } },
      });
      if (!message || !message.textContent) {
        await skip('Empty or deleted message');
        return;
      }
      if (!this.isMessageEligibleForAI(message.textContent)) {
        await skip('Message classified as low-value noise');
        return;
      }
      const chatJid = message.conversation?.externalChatId || '';
      if (chatJid.includes('@newsletter') || chatJid.includes('@broadcast') || chatJid === 'status@broadcast') {
        await skip('Channel or broadcast message');
        return;
      }

      this.eventsGateway.sendToUser(userId, 'ai:processing', { messageId, conversationId });

      const isGroup = message.conversation?.chatType === 'GROUP' || message.conversation?.externalChatId?.includes('@g.us');
      const groupName = isGroup ? message.conversation?.title || message.conversation?.contact?.displayName || null : null;

      let senderName = 'Contact';
      if (isGroup) {
        senderName =
          message.senderContact?.displayName ||
          (message.metadata as any)?.senderName ||
          (message.metadata as any)?.pushName ||
          'Group member';
      } else {
        senderName = resolveDisplayName(message.conversation?.contact, message.conversation?.title, false);
      }

      // Recent messages up to and including this one, in order.
      const recentMessages = await this.prisma.message.findMany({
        where: { conversationId, messageTimestamp: { lte: message.messageTimestamp } },
        orderBy: { messageTimestamp: 'desc' },
        take: 15,
        include: { senderContact: true },
      });
      const history = recentMessages.reverse().map((m) => {
        let mSender = m.isFromMe ? currentUserName : senderName;
        if (!m.isFromMe && isGroup) {
          mSender = m.senderContact?.displayName || (m.metadata as any)?.senderName || (m.metadata as any)?.pushName || 'Group member';
        }
        return { id: m.id, sender: mSender, text: m.textContent || '', isFromMe: m.isFromMe };
      });
      const contextBefore = history.filter((h) => h.id !== messageId);

      let totalJobInputTokens = 0;
      let totalJobOutputTokens = 0;
      let isForCurrentUser = true;
      // A meeting, appointment, task or question aimed at the user is normally acknowledged
      // ("ok sir, see you tomorrow"), even when the message has no question mark.
      let needsAck = false;

      // Extraction: failures throw (and are retried); finding nothing is a normal result.
      if (settings?.aiExtractions !== false && this.hasExtractionSignal(message.textContent)) {
        stage = 'EXTRACTION';
        const openItems = await this.loadOpenItems(userId, conversationId);
        const mentionNames = await this.resolveMentions(userId, [message.textContent, ...contextBefore.map((h) => h.text)]);
        const named = (t: string) => t.replace(/@(\d{6,})/g, (m, id) => (mentionNames.get(id) ? `@${mentionNames.get(id)}` : m));
        const result = await this.extractItemsWithTokens({
          messageText: named(message.textContent),
          senderName,
          groupName,
          currentUserName,
          messageTimestamp: message.messageTimestamp,
          chatKind: isGroup ? null : 'direct',
          fromMe: message.isFromMe,
          history: contextBefore.map((h) => ({ ...h, text: named(h.text) })),
          openItems,
        });
        totalJobInputTokens += result.inputTokens;
        totalJobOutputTokens += result.outputTokens;

        stage = 'PERSISTENCE';
        const saved = await this.persistExtractionResult({
          userId,
          whatsappAccountId,
          conversationId,
          contactId: message.conversation?.contactId,
          messageId,
          messageTimestamp: message.messageTimestamp,
          items: result.items,
          updates: result.updates,
          senderName,
          groupName,
        });
        if (result.items.length > 0) isForCurrentUser = result.items.some((i) => i.isForCurrentUser);
        needsAck = result.items.some(
          (i) => i.isForCurrentUser && ACK_TYPES.includes(i.extractionType)
        );

        for (const extraction of saved.created) {
          const payload = { extraction, messageId, conversationId };
          this.eventsGateway.sendToUser(userId, 'ai:extraction', payload);
          this.eventsGateway.sendToAccount(whatsappAccountId, 'ai:extraction', payload);
        }
        for (const extraction of saved.updated) {
          this.eventsGateway.sendToUser(userId, 'ai:extraction-updated', { extraction, messageId, conversationId });
        }
        if (saved.created.length + saved.updated.length > 0) {
          this.eventsGateway.sendToUser(userId, 'dashboard:updated', { conversationId });
        }
      }

      // Reply suggestions (only for incoming messages that ask something of the user)
      const replyAllowed =
        !message.isFromMe &&
        isForCurrentUser &&
        settings?.aiReplySuggestions !== false &&
        // Only for important messages: a saved item that normally gets answered (meeting, task,
        // question, invoice, ...). Casual questions and small talk never reach the dashboard.
        needsAck &&
        !this.looksPromotional(message.textContent) &&
        (!isGroup || this.mentionsUser(message.textContent, currentUserName));

      if (replyAllowed) {
        stage = 'REPLY_SUGGESTION';
        const myRecent = await this.prisma.message.findMany({
          where: { userId, isFromMe: true, textContent: { not: null } },
          orderBy: { messageTimestamp: 'desc' },
          take: 25,
          select: { textContent: true },
        });
        const styleSamples = myRecent
          .map((m) => (m.textContent || '').trim())
          .filter((t) => t.length >= 3 && t.length <= 120)
          .slice(0, 10);

        const suggestionsResult = await this.generateReplySuggestionsWithTokens(
          message.textContent,
          senderName,
          groupName,
          currentUserName,
          history,
          styleSamples
        );

        if (suggestionsResult && suggestionsResult.items.length > 0) {
          totalJobInputTokens += suggestionsResult.inputTokens;
          totalJobOutputTokens += suggestionsResult.outputTokens;

          const existingSuggestion = await this.prisma.aIReplySuggestion.findFirst({ where: { sourceMessageId: messageId } });
          if (!existingSuggestion) {
            const best = suggestionsResult.items[0];
            await this.prisma.aIReplySuggestion.create({
              data: {
                userId,
                whatsappAccountId,
                conversationId,
                sourceMessageId: messageId,
                suggestion: best.text,
                tone: best.tone ? best.tone.toLowerCase() : 'casual',
                language: best.language || 'en',
                sourceMessagePreview: message.textContent.slice(0, 100),
                confidence: best.confidence || 0.9,
                contextSummary: `Generated for "${message.textContent.slice(0, 40)}"`,
              },
            });
            this.eventsGateway.sendToUser(userId, 'ai:suggestion', { messageId, conversationId, suggestions: [best] });
          }
        }
      }

      const totalTokens = totalJobInputTokens + totalJobOutputTokens;
      if (totalTokens > 0) {
        await this.recordTokenUsage(userId, whatsappAccountId, totalJobInputTokens, totalJobOutputTokens, totalTokens, 'REALTIME_ANALYSIS', job.id);
      }

      // Only now, after every database write succeeded.
      await this.prisma.aIProcessingJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          errorMessage: null,
          errorCategory: null,
          failedStage: null,
          inputTokens: totalJobInputTokens,
          outputTokens: totalJobOutputTokens,
          totalTokens,
        },
      });
      this.eventsGateway.sendToUser(userId, 'ai:completed', { messageId, conversationId });
    } catch (raw: any) {
      const err = this.toProcessingError(raw, stage);
      const attempts = job.attempts + 1;
      const willRetry = err.retryable && attempts < job.maxAttempts;
      const delayMs = err.retryAfterMs ?? Math.min(job.backoffDelayMs * 2 ** attempts, 10 * 60 * 1000);

      this.logger.error(
        `[AI_JOB_FAILED] message=${messageId} conversation=${conversationId} stage=${stage} category=${err.category} attempt=${attempts}/${job.maxAttempts} retry=${willRetry} error="${err.message}"`
      );

      try {
        await this.prisma.aIProcessingJob.update({
          where: { id: job.id },
          data: {
            status: willRetry ? 'RETRYING' : 'FAILED',
            attempts: attempts,
            errorMessage: err.message.slice(0, 500),
            errorCategory: err.category,
            failedStage: stage,
            lastAttemptAt: new Date(),
            nextRetryAt: willRetry ? new Date(Date.now() + delayMs) : null,
          },
        });
      } catch (dbErr: any) {
        this.logger.error(`[AI_JOB_FAILED] could not record failure for job ${job.id}: ${dbErr.message}`);
      }

      if (!willRetry) {
        this.eventsGateway.sendToUser(userId, 'ai:failed', { messageId, conversationId, error: err.message, category: err.category });
      }
    }
  }

  /**
   * Backward-compatible helper method for generateReplySuggestions.
   */
  async generateReplySuggestions(
    messageText: string,
    contactName: string,
    history: { sender: string; text: string }[] = [],
    contactProfile?: any
  ): Promise<ReplySuggestionItem[]> {
    const res = await this.generateReplySuggestionsWithTokens(messageText, contactName, null, 'User', history);
    return res.items;
  }

  /** Local calendar day (YYYY-MM-DD) in the app timezone, so "today" is right near midnight. */
  private dayInTimezone(date: Date, timeZone: string): string {
    try {
      return date.toLocaleDateString('en-CA', { timeZone });
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  /**
   * Extracts every distinct important item from one message (v2 rules), and any change
   * to earlier open items (reschedule / cancel / complete).
   * Provider and parse failures THROW so the job can retry; "nothing found" is an empty list.
   */
  async extractItemsWithTokens(input: {
    messageText: string;
    senderName: string;
    groupName?: string | null;
    currentUserName?: string;
    messageTimestamp?: Date | string | null;
    chatKind?: 'direct' | null;
    /** The message was written by the user (not received). */
    fromMe?: boolean;
    history?: { sender: string; text: string }[];
    openItems?: OpenItemRef[];
    timezone?: string;
  }): Promise<{ items: ExtractedItem[]; updates: ExtractionUpdate[]; inputTokens: number; outputTokens: number }> {
    const {
      messageText,
      senderName,
      groupName = null,
      currentUserName = 'User',
      chatKind = null,
      history = [],
      openItems = [],
    } = input;
    const timeZone = input.timezone || process.env.APP_TIMEZONE || 'Asia/Kolkata';
    const parsedAt = input.messageTimestamp ? new Date(input.messageTimestamp) : new Date();
    const sentAt = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt;
    const sentDay = this.dayInTimezone(sentAt, timeZone);
    // Between midnight and 5 AM people still think of it as the previous day: a 12:24 AM "see you tomorrow"
    // means the day that is about to begin, not the one after. Relative words are resolved from that day.
    const localHour = Number(sentAt.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone }).slice(0, 2)) % 24;
    const refDay = localHour < 5 ? this.dayInTimezone(new Date(sentAt.getTime() - 24 * 60 * 60 * 1000), timeZone) : sentDay;
    const weekday = new Date(refDay + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

    const contextHeader = groupName
      ? `Group "${groupName}", sent by "${senderName}"`
      : `Direct chat with "${senderName}"`;
    const historyText = history
      .slice(-10)
      .map((h) => `${h.sender}: "${h.text}"`)
      .join('\n');
    const openText = openItems
      .map((o) => `${o.ref}: [${o.type}] ${o.title}${o.dueAt ? ` (due ${new Date(o.dueAt).toISOString().slice(0, 10)})` : ''}`)
      .join('\n');

    const prompt = `You read one WhatsApp message for ${currentUserName} and extract every distinct item worth saving.
Ordinary chat (greetings, thanks, emoji, "ok", jokes, small talk) produces {"items": [], "updates": []}.

The message was sent on ${sentDay}${refDay !== sentDay ? ` just after midnight, so treat the reference day as ${refDay}` : ''} (${weekday}), timezone ${timeZone}. Resolve "today", "tomorrow", "kal", "udya", weekdays and "next Monday" ONLY from ${refDay}.
Context: ${contextHeader}

Earlier messages (context only, do not extract from them):
${historyText || '(none)'}

Open items already saved for this chat:
${openText || '(none)'}

NEW MESSAGE (extract from this only):
"""${messageText}"""

Item types (use exactly these names): ${EXTRACTION_TYPES.join(', ')}.
- TASK: a to-do or action someone must do. REMINDER: "remind me", things to remember. FOLLOW_UP: call back, reply later, check a status, send information.
- MEETING / APPOINTMENT: meeting or call requests, confirmed appointments, venue details. DEADLINE: a due date or time limit for something.
- QUESTION: a question aimed at ${currentUserName} that needs an answer. DECISION: a decision made, a promise given, an agreed next step, who is responsible.
- CONTACT: a person's phone, email, role or company given for later use; other important names and entities.
- PAYMENT: money owed or to be paid (an amount is required). INVOICE: an invoice, bill or receipt. ORDER: an order, shipment, delivery or tracking update.
- DOCUMENT: a document, file or information shared or requested ("send the PDF", "attached the report").
- COMPLAINT: a problem, defect or complaint. URGENT: an urgent issue or escalation that needs fast action.
- REQUIREMENT: what a customer or client needs. LEAD: a sales opportunity or inquiry. NEGOTIATION: a price, quote, offer or counter-offer being discussed.
- PROJECT_UPDATE: progress, status or a milestone of a project. CHANGE: a reschedule, cancellation or change to something earlier (only when no saved item below can be updated).
- INSTRUCTION: an important fact or instruction to follow later. PREFERENCE: a stated preference of a customer or person. BUSINESS: other business information (terms, prices, policies).
- TRAVEL: a travel arrangement or booking. INTERVIEW: hiring or interview scheduling. RECURRING: a repeating task or commitment ("every Monday", "daily report").
- APPROVAL: something approved, rejected or waiting for approval. RENEWAL: a renewal or expiry date (subscription, licence, policy).
- GOAL: a personal goal or plan someone states. PENDING: an unresolved issue or a pending action still waiting on someone.
- SUMMARY: a short summary of a LONG message (many facts) so the user does not have to reread it. Only for messages of ${SUMMARY_MIN_CHARS}+ characters; never for short ones.
- WISH: anniversary, festival, congratulation, good-luck or get-well wishes (not birthdays: those are BIRTHDAY). "birthdayPerson" is not used; put who is being wished in the title.
- IMPORTANT_EVENT: wedding, exam, ceremony or similar with a date.
- BIRTHDAY: someone's birthday or a birthday wish. "birthdayPerson" is whose birthday it is. ${
      chatKind === 'direct'
        ? `In this direct chat a wish from "${senderName}" is for ${currentUserName}.`
        : `In a group take the name from the message; if clearly for ${currentUserName} use ${currentUserName}.`
    } If the wish does not name the person ("Happy birthday sir", "Happy birthday @12345"), look for the name in the earlier messages. If it is still unclear, STILL return the item with birthdayPerson null: birthday wishes in a group are always worth saving.
Pick the single most specific type for each item. Never invent a type that is not in the list.

${input.fromMe ? `IMPORTANT: this message was WRITTEN BY ${currentUserName} (the user) to ${groupName ? `the group "${groupName}"` : `"${senderName}"`}. Extract what ${currentUserName} promised, planned, scheduled, agreed to do, or must remember: "I will send it by Friday", "call me at 5", "meeting booked for Monday 11", "remind me to pay rent". Word titles from ${currentUserName}'s side ("Send proposal to Priya"). Set isForCurrentUser true. Do NOT extract questions ${currentUserName} asked, thanks, or wishes.
` : ''}
Rules:
1. One message can hold many independent items. Return a SEPARATE item for each ("Call Rahul at 10, send Priya the file by Friday" = 2 items). Never merge unrelated actions.
2. Use only facts in the message (history only explains references like "that", "it", "him"). Never invent names, times, amounts or places. Unknown stays null.
3. "supportingText" must be an exact excerpt copied from the NEW MESSAGE that proves the item.
4. Dates: "dueDate" YYYY-MM-DD and "dueTime" HH:MM only when the date follows reliably from the message date. If it is vague or ambiguous ("sometime next week", "after Diwali") set "dateCertain": false, dueDate null, and copy the words into "originalDateText".
   "next <weekday>" is ambiguous (it can mean the coming one or the one after): treat it as vague unless the message itself makes it clear. A bare weekday ("by Friday", "on Monday") means the next such day on or after the message date.
5. Casual wording still counts when it is a real commitment ("haan kal bhej dunga").
6. Never extract everyday personal chat, even when it mentions a call: "call me", "why did you not call", "talk on call", "call after reaching home" with no specific time, purpose or deadline. A task needs a real deliverable, a time, or a deadline. Casual requests between friends and family are not items.
7. Never extract: OTPs, passwords, card or account numbers; ads, offers, deals, shopping links; job, recruitment, course or flat/room listings posted to a group or channel; "join our WhatsApp/Telegram" invitations; forwards; opinions; "maybe/soon/let's see" plans with no commitment.
8. "priority": LOW, NORMAL, HIGH or URGENT, only from evidence (deadline today, "urgent", payment overdue).
9. "me", "my", "I" in the new message mean the sender (${senderName}). A request to ${currentUserName} such as "remind me to..." or "send me the file..." is a task for ${currentUserName}: extract it, set isForCurrentUser true, and word the title from ${currentUserName}'s side ("Remind ${senderName} to review the invoice"). Do not drop it because it says "me".
10. Changes to saved items: if the new message reschedules, cancels or completes one of the open items above, return it in "updates" using that item's ref (E1, E2...). Only when the reference is clear. Otherwise return nothing for it. Do not also create a new item for the same change.

Return ONLY valid JSON, no markdown:
{
  "items": [
    {
      "type": "TASK",
      "title": "short title, max 70 chars",
      "description": "one or two sentences using only message facts",
      "supportingText": "exact excerpt from the new message",
      "dueDate": "YYYY-MM-DD or null",
      "dueTime": "HH:MM or null",
      "originalDateText": "the date/time words as written, or null",
      "dateCertain": true,
      "priority": "NORMAL",
      "actionRequired": true,
      "confidence": 0.0,
      "isForCurrentUser": true,
      "birthdayPerson": "name or null (BIRTHDAY only)",
      "entities": {"people": [], "organizations": [], "amounts": [], "phones": [], "emails": []}
    }
  ],
  "updates": [
    {"target": "E1", "action": "RESCHEDULE | CANCEL | COMPLETE", "newDueDate": "YYYY-MM-DD or null", "newDueTime": "HH:MM or null", "supportingText": "exact excerpt", "confidence": 0.0}
  ]
}`;

    const geminiRes = await this.callGeminiWithTokens(prompt, { maxTokens: 4096, json: true });
    const tokens = { inputTokens: geminiRes.inputTokens, outputTokens: geminiRes.outputTokens };

    let parsed: any;
    try {
      parsed = JSON.parse(this.cleanJson(geminiRes.text));
    } catch {
      throw new AIProcessingError(
        geminiRes.truncated ? 'Model response was cut off (token limit)' : 'Model response was not valid JSON',
        'INVALID_RESPONSE'
      );
    }
    if (Array.isArray(parsed)) parsed = { items: parsed, updates: [] };
    if (parsed?.isSignificant === false) parsed = { items: [], updates: [] };
    if (!parsed || !Array.isArray(parsed.items)) {
      throw new AIProcessingError('Model response is missing the "items" list', 'INVALID_RESPONSE');
    }

    const items = this.validateExtractedItems(parsed.items, {
      messageText,
      senderName,
      currentUserName,
      sentDay,
      isGroup: Boolean(groupName),
      fromMe: Boolean(input.fromMe),
    });
    const updates = this.validateExtractionUpdates(Array.isArray(parsed.updates) ? parsed.updates : [], {
      messageText,
      openItems,
    });
    return { items, updates, ...tokens };
  }

  private validateExtractedItems(
    rawItems: any[],
    ctx: { messageText: string; senderName: string; currentUserName: string; sentDay: string; isGroup: boolean; fromMe?: boolean }
  ): ExtractedItem[] {
    const loose = (s: string) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
    const message = loose(ctx.messageText);
    const validDate = (d: any) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime());
    const validTime = (t: any) => (typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null);
    const out: ExtractedItem[] = [];
    const seen = new Set<string>();

    for (const raw of rawItems.slice(0, 10)) {
      if (!raw || typeof raw !== 'object') continue;
      const type = raw.type as ExtractionType;
      if (!EXTRACTION_TYPES.includes(type)) continue;

      const confidence = Number(raw.confidence);
      if (!(confidence >= 0.8)) continue;

      const supportingText = typeof raw.supportingText === 'string' ? raw.supportingText.trim() : '';
      const evidence = loose(supportingText);
      if (evidence.length < 3 || !message.includes(evidence)) continue;

      const title = String(raw.title || '').trim().slice(0, 70);
      if (!title) continue;
      const description = String(raw.description || title).trim().slice(0, 500);

      const originalDateText =
        typeof raw.originalDateText === 'string' && raw.originalDateText.trim() ? raw.originalDateText.trim().slice(0, 100) : null;
      let eventDate: string | null = validDate(raw.dueDate) ? raw.dueDate : null;
      let dateUncertain = raw.dateCertain === false || (Boolean(raw.dueDate) && !eventDate);
      if (dateUncertain) eventDate = null;

      const entities = raw.entities && typeof raw.entities === 'object' ? raw.entities : {};
      const amounts = Array.isArray((entities as any).amounts) ? (entities as any).amounts.filter(Boolean) : [];

      let targetPerson: string | null = null;
      // Something the user wrote is always the user's own commitment or plan. A birthday or festival wish the
      // user sent needs no action, so it is not saved.
      if (ctx.fromMe && (type === 'BIRTHDAY' || type === 'WISH')) continue;
      let forCurrentUser = ctx.fromMe ? true : ctx.isGroup ? raw.isForCurrentUser === true : raw.isForCurrentUser !== false;

      if (type === 'BIRTHDAY') {
        const rawPerson = typeof raw.birthdayPerson === 'string' ? raw.birthdayPerson.trim() : '';
        // A bare title ("sir", "lord"), "everyone" or an unresolved @number is not a name. The wish is
        // still saved: a group wishing someone happy birthday is worth showing even if we cannot say who.
        const unnamed = !rawPerson || /^@?\d{6,}$/.test(rawPerson) || /^(sir|lord|everyone|all|team|madam|ma'?am|bro|bhai|dada|tai)$/i.test(rawPerson);
        if (unnamed) {
          forCurrentUser = false;
          targetPerson = null;
        } else {
          const me = ctx.currentUserName.trim().toLowerCase();
          const them = rawPerson.toLowerCase();
          forCurrentUser = them === me || me.includes(them) || them.includes(me) || them === 'you' || them === 'me';
          targetPerson = forCurrentUser ? ctx.currentUserName : rawPerson;
        }
        // A wish with no date is a wish for the day it was sent.
        if (!eventDate) {
          eventDate = ctx.sentDay;
          dateUncertain = false;
        }
      } else if (type !== 'WISH' && !forCurrentUser) {
        continue;
      }

      // A wish with no date is a wish for the day it was sent (so one chat gets one card per day).
      if (type === 'WISH' && !eventDate) {
        eventDate = ctx.sentDay;
        dateUncertain = false;
      }

      // "Call var tari bola", "call me": a short call request with no date, time or purpose is chat.
      if (
        ['TASK', 'FOLLOW_UP', 'REMINDER'].includes(type) &&
        !eventDate &&
        !originalDateText &&
        ctx.messageText.trim().split(/\s+/).length <= 6 &&
        /\bcall\b/i.test(ctx.messageText)
      ) {
        continue;
      }

      // A summary of a short message is just noise.
      if (type === 'SUMMARY' && ctx.messageText.length < SUMMARY_MIN_CHARS) continue;

      if (DATE_REQUIRED_TYPES.includes(type) && !eventDate && !originalDateText) continue;
      if (type === 'PAYMENT' && amounts.length === 0) continue;

      const eventTime = eventDate ? validTime(raw.dueTime) : null;
      const priorityText = String(raw.priority || '').toUpperCase();
      const priority = (PRIORITIES as readonly string[]).includes(priorityText)
        ? (priorityText as ExtractedItem['priority'])
        : 'NORMAL';
      const itemKey = buildItemKey(type, supportingText);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);

      out.push({
        extractionType: type,
        title,
        description,
        supportingText,
        eventDate,
        eventTime,
        originalDateText,
        dateUncertain,
        priority,
        actionRequired: type === 'BIRTHDAY' ? false : raw.actionRequired !== false,
        confidence: Math.min(1, confidence),
        isForCurrentUser: forCurrentUser,
        targetPerson,
        entities: { ...entities, amounts },
        itemKey,
      });
    }
    return out;
  }

  private validateExtractionUpdates(
    rawUpdates: any[],
    ctx: { messageText: string; openItems: OpenItemRef[] }
  ): ExtractionUpdate[] {
    const loose = (s: string) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
    const message = loose(ctx.messageText);
    const byRef = new Map(ctx.openItems.map((o) => [o.ref, o.id]));
    const out: ExtractionUpdate[] = [];

    for (const raw of rawUpdates.slice(0, 10)) {
      const targetId = byRef.get(String(raw?.target));
      if (!targetId) continue; // only items we offered can be changed
      const action = raw.action as ExtractionUpdate['action'];
      if (!['RESCHEDULE', 'CANCEL', 'COMPLETE'].includes(action)) continue;
      if (!(Number(raw.confidence) >= 0.85)) continue;
      const evidence = loose(typeof raw.supportingText === 'string' ? raw.supportingText : '');
      if (evidence.length < 3 || !message.includes(evidence)) continue;

      const newEventDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.newDueDate || '') ? raw.newDueDate : null;
      const newEventTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.newDueTime || '') ? raw.newDueTime : null;
      if (action === 'RESCHEDULE' && !newEventDate && !newEventTime) continue;

      out.push({
        targetId,
        action,
        newEventDate,
        newEventTime,
        supportingText: String(raw.supportingText).trim(),
        confidence: Number(raw.confidence),
      });
    }
    return out;
  }

  /**
   * Generates AI reply suggestions with token metadata.
   */
  async generateReplySuggestionsWithTokens(
    messageText: string,
    senderName: string,
    groupName?: string | null,
    currentUserName: string = 'User',
    history: { sender: string; text: string; isFromMe?: boolean }[] = [],
    styleSamples: string[] = []
  ): Promise<{ items: ReplySuggestionItem[]; inputTokens: number; outputTokens: number }> {
    const historyText = history
      .slice(-10)
      .map((h) => `${h.sender}: "${h.text}"`)
      .join('\n');

    const ownFromHistory = history
      .filter((h) => h.isFromMe && h.text && h.text.length <= 120)
      .map((h) => h.text.trim());
    const samples = Array.from(new Set([...ownFromHistory.slice(-6), ...styleSamples])).slice(0, 12);
    const styleText = samples.length ? samples.map((s) => `- ${s}`).join('\n') : '(no samples)';

    const prompt = `You write ONE WhatsApp reply for ${currentUserName}, answering the latest message from ${senderName}.

Conversation history:
${historyText || '(none)'}

How ${currentUserName} actually types (copy this style: language, spelling, slang, casing, emoji use, length):
${styleText}

Latest message from ${senderName}:
"""${messageText}"""
${groupName ? `This is the group "${groupName}". Only reply if the message names ${currentUserName} or asks ${currentUserName} directly.` : ''}

Return [] (an empty array) unless ALL of these are true:
1. The latest message asks ${currentUserName} a direct question or requests an answer, a confirmation or a decision, OR it gives ${currentUserName} an important update that people normally acknowledge: a meeting, appointment, task, order or delivery, payment, invoice, document, deadline or change ("ok, see you tomorrow", "done, will do", "ok thanks, will collect it", "received, thanks").
2. The reply can be written using ONLY facts already in the message or the history. Never invent times, prices, places, names or promises. If the answer depends on something only ${currentUserName} knows (are you free, will you come), return [].
3. The message is not just a greeting, thanks, a forward, an ad, a link, a meme, casual small talk, or media without text. A plain acknowledgement of an important update (rule 1) IS wanted.

If you reply:
- Write like a real friend texting, in the same language and script as the latest message (Marathi, Hindi, Hinglish, English). Hinglish stays in roman letters.
- Use the chat slang and tone of ${currentUserName}'s samples above: short, lowercase if they type lowercase, "bhai", "yaar", "ho", "haan", "ok done" style words only if they use them.
- 1 to 12 words in most cases, never more than 25. One sentence. At most one emoji, and only if the samples use emojis.
- Never use formal or corporate phrases (no "I would be glad", "Kindly", "Regards", "Please find").
- Do not repeat the question back or add explanations.

Examples of the feel only (the facts must still come from the chat):
Message: "kal 5 baje milte hai na?" and history says ${currentUserName} agreed earlier -> "haan bhai 5 pe milte"
Message: "report bhej diya?" and history says it was sent -> "haan bhej diya"

Return ONLY valid JSON, no markdown:
[] or [{"text": "reply", "language": "mr | hi | hinglish | en", "confidence": 0.0}]`;

    try {
      const geminiRes = await this.callGeminiWithTokens(prompt);
      const parsed = JSON.parse(this.cleanJson(geminiRes.text));
      const item = Array.isArray(parsed) ? parsed[0] : null;
      const text = typeof item?.text === 'string' ? item.text.trim() : '';
      const valid =
        text.length > 0 &&
        text.length <= 200 &&
        typeof item?.confidence === 'number' &&
        item.confidence >= 0.85 &&
        (!groupName || !text.includes(groupName));
      if (valid) {
        return {
          items: [{ text, tone: 'friendly', language: item.language || 'en', confidence: item.confidence }],
          inputTokens: geminiRes.inputTokens,
          outputTokens: geminiRes.outputTokens,
        };
      }
      return { items: [], inputTokens: geminiRes.inputTokens, outputTokens: geminiRes.outputTokens };
    } catch (err: any) {
      this.logger.warn(`AI reply suggestion skipped: ${err.message}`);
    }

    return { items: [], inputTokens: 0, outputTokens: 0 };
  }

  /**
   * Likes and dislikes of a contact, taken from what THEY said in the chat.
   * Every item comes with the exact words that prove it; anything the chat does not prove is dropped.
   */
  async generateContactProfile(
    contactName: string,
    messages: { isFromMe: boolean; text: string }[]
  ): Promise<{ likes: ProfileItem[]; dislikes: ProfileItem[]; confidence: number }> {
    if (!messages.length) {
      throw new Error('NO_MESSAGES');
    }

    const conversationText = messages
      .map((m) => `${m.isFromMe ? 'Me' : contactName}: ${m.text.slice(0, 300)}`)
      .join('\n');

    const prompt = `Find what "${contactName}" likes and dislikes, using ONLY the chat below ("Me" is the user).

${conversationText}

Rules:
1. Only things ${contactName} says about THEMSELVES: "I love ...", "I like ...", "I hate ...", "I don't like ...", "mala ... awadta", "mala ... nahi awadat", "mujhe ... pasand hai", "mujhe ... nahi pasand", "I am crazy about ...", "I can't stand ...", "so boring", "irritating". Words from "Me" never count as ${contactName}'s opinion.
2. It must be said clearly. Do NOT guess from how often a topic comes up, from mood, or from teasing and jokes. Talking about food a lot is not a like.
3. A like or dislike is a thing, food, activity, place, habit or kind of person: "pani puri", "late night walks", "loud music". Not a mood, not a plan, not a third person.
4. "item": a short plain English label (1 to 4 words). "evidence": the exact words copied from ${contactName}'s own message that prove it.
5. At most 8 likes and 8 dislikes. If the chat does not say, return empty lists.

Return ONLY valid JSON, no markdown:
{"likes": [{"item": "pani puri", "evidence": "exact words"}], "dislikes": [{"item": "...", "evidence": "..."}], "confidence": 0.0}
"confidence" is 0 to 1: how clearly the chat states these.`;

    const geminiRes = await this.callGeminiWithTokens(prompt, { json: true, maxTokens: 2048 });
    let parsed: any;
    try {
      parsed = JSON.parse(this.cleanJson(geminiRes.text));
    } catch {
      throw new AIProcessingError('Model response was not valid JSON', 'INVALID_RESPONSE');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new AIProcessingError('Model response was empty', 'INVALID_RESPONSE');
    }

    // The proof must be in the contact's OWN messages.
    const loose = (t: string) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
    const theirs = loose(messages.filter((m) => !m.isFromMe).map((m) => m.text).join(' \n '));
    const keep = (raw: any): ProfileItem[] => {
      const out: ProfileItem[] = [];
      const seen = new Set<string>();
      for (const r of Array.isArray(raw) ? raw : []) {
        const item = typeof r?.item === 'string' ? r.item.trim().slice(0, 40) : '';
        const evidence = typeof r?.evidence === 'string' ? r.evidence.trim().slice(0, 160) : '';
        const proof = loose(evidence);
        if (!item || proof.length < 4 || !theirs.includes(proof)) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ item, evidence });
        if (out.length >= 8) break;
      }
      return out;
    };

    const likes = keep(parsed.likes);
    const dislikes = keep(parsed.dislikes);
    // The same thing cannot be both liked and disliked
    const disliked = new Set(dislikes.map((d) => d.item.toLowerCase()));
    return {
      likes: likes.filter((l) => !disliked.has(l.item.toLowerCase())),
      dislikes,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    };
  }

  /**
   * Fetches token usage statistics for settings / overview.
   */
  async getTokenUsageStats(userId: string, whatsappAccountId: string) {
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    const dailyLimit = settings?.dailyTokenLimit || 100000;
    const usedToday = settings?.usedTokensToday || 0;
    const percentage = Math.min(100, Math.round((usedToday / dailyLimit) * 100));

    let status = 'NORMAL';
    if (!TOKEN_LIMIT_ENFORCED) status = 'NORMAL';
    else if (percentage >= 100) status = 'PAUSED';
    else if (percentage >= 90) status = 'NEAR_LIMIT';
    else if (percentage >= 70) status = 'WARNING';

    return {
      usedToday,
      dailyLimit,
      percentage,
      status,
      monthlyLimit: settings?.monthlyTokenLimit || 3000000,
      usedThisMonth: settings?.usedTokensThisMonth || 0,
      autoAIAnalysis: settings?.autoAIAnalysis ?? true,
      realtimeAI: settings?.realtimeAI ?? true,
      aiReplySuggestions: settings?.aiReplySuggestions ?? true,
      aiExtractions: settings?.aiExtractions ?? true,
    };
  }

  /**
   * A reply in the chat answers the messages that were waiting for one. Open cards that came from
   * messages received since the user's previous reply (meetings, tasks, questions, invoices, ... and
   * a birthday wish for the user) are closed. Older cards, and cards from earlier conversations,
   * stay. Only called for live replies, never for history sync.
   */
  async resolveRepliedItems(userId: string, conversationId: string, repliedAt: Date): Promise<number> {
    try {
      const previous = await this.prisma.message.findFirst({
        where: { conversationId, isFromMe: true, messageTimestamp: { lt: repliedAt } },
        orderBy: { messageTimestamp: 'desc' },
        select: { messageTimestamp: true },
      });
      const since = previous?.messageTimestamp ?? new Date(0);

      const open = await this.prisma.aIExtraction.findMany({
        where: {
          userId,
          conversationId,
          status: { in: OPEN_STATUSES },
          extractionType: { in: [...ACK_TYPES, 'BIRTHDAY'] as string[] },
        },
      });
      const messageIds = open.map((o) => o.messageId).filter((x): x is string => !!x);
      if (messageIds.length === 0) return 0;
      const sources = await this.prisma.message.findMany({
        where: { id: { in: messageIds } },
        select: { id: true, messageTimestamp: true },
      });
      const sentAt = new Map(sources.map((m) => [m.id, m.messageTimestamp.getTime()]));

      let closed = 0;
      for (const item of open) {
        const ts = item.messageId ? sentAt.get(item.messageId) : undefined;
        if (ts === undefined || ts <= since.getTime() || ts > repliedAt.getTime()) continue;
        // A birthday wish for someone else is not answered by replying to the group.
        if (item.extractionType === 'BIRTHDAY' && (item.structuredData as any)?.isForCurrentUser !== true) continue;
        const history: any[] = Array.isArray(item.history) ? (item.history as any[]) : [];
        await this.prisma.aIExtraction.update({
          where: { id: item.id },
          data: {
            status: 'COMPLETED',
            history: [...history, { at: new Date().toISOString(), action: 'REPLIED', note: 'Replied in the chat' }],
          },
        });
        closed++;
      }
      if (closed > 0) this.eventsGateway.sendToUser(userId, 'dashboard:updated', { type: 'REPLIED', conversationId });
      return closed;
    } catch (err: any) {
      this.logger.warn(`Failed to close answered items for ${conversationId}: ${err.message}`);
      return 0;
    }
  }

  /**
   * Closes the Action Center card a reply was sent from. A suggested reply is marked used; a saved item
   * is marked COMPLETED and the reply is recorded in its history, so nothing is lost.
   */
  async resolveActionItem(userId: string, id: string, category?: string): Promise<void> {
    try {
      if (category === 'REPLY_NEEDED') {
        await this.prisma.aIReplySuggestion.updateMany({
          where: { id, userId },
          data: { isUsed: true, usedAt: new Date() },
        });
      } else {
        const item = await this.prisma.aIExtraction.findFirst({ where: { id, userId } });
        if (!item || !OPEN_STATUSES.includes(item.status)) return;
        const history: any[] = Array.isArray(item.history) ? (item.history as any[]) : [];
        await this.prisma.aIExtraction.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            history: [...history, { at: new Date().toISOString(), action: 'REPLIED', note: 'Reply sent from the Action Center card' }],
          },
        });
      }
      this.eventsGateway.sendToUser(userId, 'dashboard:updated', { type: 'ACTION_ITEM_RESOLVED', id });
    } catch (err: any) {
      this.logger.warn(`Failed to close action item ${id}: ${err.message}`);
    }
  }

  /**
   * Dismisses all pending Action Center items (suggestions & extractions) for a conversation when the user sends a reply.
   */
  async dismissActionItemsForConversation(conversationId: string, repliedAt: Date = new Date()): Promise<void> {
    try {
      // Only reply suggestions are closed by replying, and only those for messages that came
      // before the reply. Meetings, payments, birthdays etc. stay saved until the user
      // dismisses them or their date passes.
      await this.prisma.aIReplySuggestion.updateMany({
        where: {
          conversationId,
          isUsed: false,
          sourceMessage: { messageTimestamp: { lte: repliedAt } },
        },
        data: { isUsed: true, usedAt: new Date() },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to dismiss action items for conversation ${conversationId}: ${err.message}`);
    }
  }

  /**
   * Generates NRYN Action Center MVP items strictly categorized into:
   * 1. REPLY_NEEDED (💬 Reply Needed)
   * 2. FOLLOW_UP (🔄 Follow Up)
   * 3. BIRTHDAY (🎂 Birthday)
   */
  async getActionCenterItems(
    userId: string,
    whatsappAccountId: string,
    limit: number = 50,
    categoryFilter: string = 'ALL'
  ) {
    const items: any[] = [];

    const formatTimeAgo = (date: Date | string) => {
      if (!date) return 'recently';
      const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
      if (seconds < 60) return 'just now';
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      return `${days}d ago`;
    };

    // 1. REPLY_NEEDED (💬 Reply Needed - MOST IMPORTANT)
    if (categoryFilter === 'ALL' || categoryFilter === 'REPLY_NEEDED' || categoryFilter === 'REPLIES') {
      const suggestions = await this.prisma.aIReplySuggestion.findMany({
        where: {
          userId,
          whatsappAccountId,
          isUsed: false,
        },
        include: {
          conversation: {
            include: {
              contact: {
                select: { id: true, displayName: true, phoneNumber: true, profilePhotoUrl: true },
              },
              messages: {
                take: 1,
                orderBy: { messageTimestamp: 'desc' },
                select: { isFromMe: true },
              },
            },
          },
          sourceMessage: {
            include: {
              senderContact: {
                select: { id: true, displayName: true, pushName: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      for (const s of suggestions) {
        const lastMsg = s.conversation?.messages?.[0];
        // Skip if user has already replied (latest message is from me)
        if (lastMsg && lastMsg.isFromMe) {
          continue;
        }

        const isGroup = s.conversation?.chatType === 'GROUP' || s.conversation?.externalChatId?.includes('@g.us');
        const groupName = isGroup ? (s.conversation?.title || s.conversation?.contact?.displayName || null) : null;

        let senderName = 'Contact';
        if (isGroup) {
          if (s.sourceMessage?.senderContact?.displayName) {
            senderName = s.sourceMessage.senderContact.displayName;
          } else if ((s.sourceMessage?.metadata as any)?.senderName) {
            senderName = (s.sourceMessage?.metadata as any).senderName;
          } else if ((s.sourceMessage?.metadata as any)?.pushName) {
            senderName = (s.sourceMessage?.metadata as any).pushName;
          } else {
            senderName = 'Group member';
          }
        } else {
          senderName = resolveDisplayName(s.conversation?.contact, s.conversation?.title, false);
        }

        const timeAgoStr = s.sourceMessage?.messageTimestamp
          ? formatTimeAgo(s.sourceMessage.messageTimestamp)
          : 'recently';
        const preview = s.sourceMessage?.textContent || s.sourceMessagePreview || 'Incoming message';

        items.push({
          id: s.id,
          category: 'REPLY_NEEDED',
          badgeLabel: '💬 Reply Needed',
          badgeColor: '#10B981',
          title: isGroup ? `${senderName} in ${groupName}` : `${senderName} sent a message`,
          senderName,
          groupName,
          conversationName: groupName || senderName,
          contactName: senderName,
          contact: s.conversation?.contact || null,
          conversationId: s.conversationId,
          messageId: s.sourceMessageId,
          sourceMessageText: preview,
          suggestedReply: s.suggestion,
          summary: `AI has prepared a response for ${senderName}.`,
          timeAgo: timeAgoStr,
          createdAt: s.createdAt,
        });
      }
    }

    // 2. FOLLOW_UP (🔄 Follow Up)
    if (categoryFilter === 'ALL' || categoryFilter === 'FOLLOW_UP' || categoryFilter === 'TASK' || categoryFilter === 'MEETING' || categoryFilter === 'PAYMENT') {
      const extractions = await this.prisma.aIExtraction.findMany({
        where: {
          userId,
          whatsappAccountId,
          status: { in: OPEN_STATUSES },
          extractionType: { notIn: ['BIRTHDAY', 'BIRTHDAY_WISH', 'WISH'] },
        },
        include: {
          contact: {
            select: { id: true, displayName: true, phoneNumber: true, profilePhotoUrl: true },
          },
          conversation: {
            include: {
              contact: { select: { id: true, displayName: true } },
              messages: {
                take: 1,
                orderBy: { messageTimestamp: 'desc' },
                select: { isFromMe: true, messageTimestamp: true },
              },
            },
          },
          message: {
            include: {
              senderContact: { select: { id: true, displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      const replyRows = await this.prisma.aIReplySuggestion.findMany({
        where: { userId, sourceMessageId: { in: extractions.map((x) => x.messageId).filter((x): x is string => !!x) } },
        orderBy: { createdAt: 'desc' },
        select: { sourceMessageId: true, suggestion: true },
      });
      const replyByMessage = new Map<string, string>();
      for (const r of replyRows) if (!replyByMessage.has(r.sourceMessageId)) replyByMessage.set(r.sourceMessageId, r.suggestion);

      for (const e of extractions) {
        // Saved until the user dismisses it; past dates are flagged overdue, not hidden.

        const isGroup = e.conversation?.chatType === 'GROUP' || e.conversation?.externalChatId?.includes('@g.us');
        const groupName = isGroup ? (e.conversation?.title || e.conversation?.contact?.displayName || null) : null;

        let senderName = 'Contact';
        if (isGroup) {
          if (e.message?.senderContact?.displayName) {
            senderName = e.message.senderContact.displayName;
          } else if ((e.message?.metadata as any)?.senderName) {
            senderName = (e.message?.metadata as any).senderName;
          } else {
            senderName = 'Group member';
          }
        } else {
          senderName = e.contact?.displayName || 'Contact';
        }
        if (e.message?.isFromMe) {
          senderName = 'You';
        }

        const preview = e.message?.textContent || e.summary;
        let savedReply = e.messageId ? replyByMessage.get(e.messageId) : undefined;

        if (!savedReply && preview) {
          savedReply = this.generateFallbackReply(e.extractionType, preview, senderName, e.summary);

          if (e.messageId && e.conversationId) {
            this.ensureReplySuggestion(
              userId,
              whatsappAccountId,
              e.conversationId,
              e.messageId,
              preview,
              senderName,
              savedReply
            ).catch(() => {});
          }
        }

        items.push({
          id: e.id,
          category: 'FOLLOW_UP',
          badgeLabel: FOLLOW_UP_LABELS[e.extractionType] || '🔄 Follow Up',
          badgeColor: e.priority === 'URGENT' ? '#DC2626' : e.priority === 'HIGH' ? '#EA580C' : '#F59E0B',
          title: e.title || `${senderName} — Follow Up Due`,
          senderName,
          groupName,
          conversationName: groupName || senderName,
          contactName: senderName,
          contact: e.contact || null,
          conversationId: e.conversationId,
          messageId: e.messageId,
          sourceMessageText: preview,
          suggestedReply: savedReply ?? null,
          summary: e.description || e.summary,
          extractionType: e.extractionType,
          status: e.status,
          priority: e.priority,
          actionRequired: e.actionRequired,
          supportingText: e.supportingText,
          originalDateText: e.originalDateText,
          notes: e.notes,
          dateUncertain: Boolean((e.structuredData as any)?.dateUncertain),
          eventTime: (e.structuredData as any)?.eventTime ?? null,
          eventDate: e.eventDate,
          isOverdue: Boolean(e.eventDate && new Date(e.eventDate) < new Date(new Date().setHours(0, 0, 0, 0))),
          createdAt: e.createdAt,
        });
      }
    }

    // 3. BIRTHDAY (🎂 Birthday)
    if (categoryFilter === 'ALL' || categoryFilter === 'BIRTHDAY') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const currentUserName = user?.name || 'User';

      const birthdays = await this.prisma.aIExtraction.findMany({
        where: {
          userId,
          whatsappAccountId,
          status: { in: OPEN_STATUSES },
          extractionType: { in: ['BIRTHDAY', 'BIRTHDAY_WISH', 'WISH'] },
        },
        include: {
          contact: {
            select: { id: true, displayName: true, phoneNumber: true, profilePhotoUrl: true },
          },
          conversation: {
            include: {
              contact: { select: { id: true, displayName: true } },
              messages: {
                take: 1,
                orderBy: { messageTimestamp: 'desc' },
                select: { isFromMe: true, messageTimestamp: true },
              },
            },
          },
          message: {
            include: {
              senderContact: { select: { id: true, displayName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      for (const b of birthdays) {
        // Saved until the user dismisses it.

        const isGroup = b.conversation?.chatType === 'GROUP' || b.conversation?.externalChatId?.includes('@g.us');
        const groupName = isGroup ? (b.conversation?.title || b.conversation?.contact?.displayName || null) : null;

        let senderName = 'Contact';
        if (isGroup) {
          if (b.message?.senderContact?.displayName) {
            senderName = b.message.senderContact.displayName;
          } else if ((b.message?.metadata as any)?.senderName) {
            senderName = (b.message?.metadata as any).senderName;
          } else {
            senderName = 'Group member';
          }
        } else {
          senderName = b.contact?.displayName || 'Contact';
        }

        const sourceMsg = b.message?.textContent || b.summary;

        // Festival, anniversary and other wishes (not birthdays): a plain card in the same tab.
        if (b.extractionType === 'WISH') {
          items.push({
            id: b.id,
            category: 'BIRTHDAY',
            badgeLabel: '🎉 Wishes',
            badgeColor: '#F59E0B',
            title: b.title,
            extractionType: 'WISH',
            status: b.status,
            isForCurrentUser: false,
            senderName,
            groupName,
            conversationName: groupName || senderName,
            contactName: senderName,
            contact: b.contact || null,
            conversationId: b.conversationId,
            messageId: b.messageId,
            sourceMessageText: sourceMsg,
            suggestedReply: `Thank you so much${senderName && senderName !== 'Contact' ? ' ' + senderName.trim().split(/\s+/)[0] : ''}! Wishing you the same! 🎉`,
            summary: b.description || b.summary,
            eventDate: b.eventDate,
            createdAt: b.createdAt,
          });
          continue;
        }

        const sd: any = b.structuredData || {};
        // "Happy birthday sir" style wishes do not name the person: show them as a group card.
        const unnamed = !sd.targetPerson && !sd.birthdayPerson && b.title.startsWith('Birthday wishes');
        const rawTarget = unnamed
          ? ''
          : sd.targetPerson || sd.birthdayPerson || b.title.replace("'s Birthday", "").replace("Birthday: ", "") || senderName;
        const targetPerson = rawTarget.trim();

        let isForCurrentUser = Boolean((b.structuredData as any)?.isForCurrentUser);
        if (targetPerson) {
          const cleanTarget = targetPerson.toLowerCase();
          const cleanUser = currentUserName.trim().toLowerCase();
          if (cleanTarget === cleanUser || cleanUser.includes(cleanTarget) || cleanTarget.includes(cleanUser)) {
            isForCurrentUser = true;
          } else if (cleanTarget !== 'user' && cleanTarget !== 'me' && cleanTarget !== cleanUser) {
            isForCurrentUser = false;
          }
        }

        if (isForCurrentUser) {
          // First name only, the way people actually text.
          let wishText = `Thank you ${senderName.trim().split(/\s+/)[0]}! ❤️`;
          if (sourceMsg.includes('वाढदिवस') || sourceMsg.includes('शुभेच्छा')) {
            wishText = `खूप खूप धन्यवाद! ❤️`;
          } else if (sourceMsg.toLowerCase().includes('bhai') || sourceMsg.toLowerCase().includes('bro')) {
            wishText = `Thanks bhai ❤️`;
          }

          items.push({
            id: b.id,
            category: 'BIRTHDAY',
            badgeLabel: '🎂 Your Birthday',
            badgeColor: '#EC4899',
            title: 'Your Birthday',
            targetPerson: currentUserName,
            isForCurrentUser: true,
            senderName,
            groupName,
            conversationName: groupName || senderName,
            contactName: senderName,
            contact: b.contact || null,
            conversationId: b.conversationId,
            messageId: b.messageId,
            sourceMessageText: sourceMsg,
            suggestedReply: wishText,
            summary: `Birthday wish from ${senderName}`,
            eventDate: b.eventDate,
            createdAt: b.createdAt,
          });
        } else {
          items.push({
            id: b.id,
            category: 'BIRTHDAY',
            badgeLabel: '🎂 Birthday Mention',
            badgeColor: '#8B5CF6',
            title: unnamed ? b.title : `Birthday: ${targetPerson}`,
            targetPerson,
            isForCurrentUser: false,
            senderName,
            groupName,
            conversationName: groupName || senderName,
            contactName: senderName,
            contact: b.contact || null,
            conversationId: b.conversationId,
            messageId: b.messageId,
            sourceMessageText: sourceMsg,
            suggestedReply: null,
            summary: unnamed
              ? `${senderName} sent a birthday wish${groupName ? ` in ${groupName}` : ''}.`
              : `Birthday wish for ${targetPerson} from ${senderName}`,
            eventDate: b.eventDate,
            createdAt: b.createdAt,
          });
        }
      }
    }

    // Every saved item stays; only exact duplicates (same id) are dropped.
    const uniqueItems: any[] = [];
    const seenKeys = new Set<string>();

    for (const item of items) {
      const key = `${item.category}:${item.id}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        uniqueItems.push(item);
      }
    }

    uniqueItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return uniqueItems;
  }

  /**
   * Dashboard Overview data for NRYN Action Center.
   */
  async getDashboardOverview(userId: string, whatsappAccountId: string) {
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    const autoAIAnalysis = settings?.autoAIAnalysis ?? true;
    const tokenStats = await this.getTokenUsageStats(userId, whatsappAccountId);

    if (!autoAIAnalysis) {
      return {
        aiEnabled: false,
        actionCenterItems: [],
        totalActionItems: 0,
        tokenStats,
      };
    }

    const actionItems = await this.getActionCenterItems(userId, whatsappAccountId, 50, 'ALL');

    return {
      aiEnabled: true,
      actionCenterItems: actionItems.slice(0, 5),
      totalActionItems: actionItems.length,
      tokenStats,
    };
  }

  private generateFallbackReply(extractionType: string, previewText: string, senderName: string, summary?: string): string {
    const text = ((previewText || '') + ' ' + (summary || '')).toLowerCase();
    const name = senderName && senderName !== 'Contact' && senderName !== 'Group member' ? ` ${senderName.trim().split(/\s+/)[0]}` : '';

    if (extractionType === 'ORDER' || text.includes('order') || text.includes('delivery') || text.includes('deliver') || text.includes('reach')) {
      return `Thanks for the update${name}! I'll be available to receive it.`;
    }
    if (extractionType === 'MEETING' || extractionType === 'APPOINTMENT') {
      return `Sounds good${name}, looking forward to it!`;
    }
    if (extractionType === 'TASK' || extractionType === 'REQUIREMENT') {
      return `Got it${name}, I'll take care of this right away.`;
    }
    if (extractionType === 'PAYMENT' || extractionType === 'INVOICE') {
      return `Thanks for letting me know${name}. I'll check and confirm shortly.`;
    }
    if (extractionType === 'QUESTION') {
      return `Thanks for checking in${name}, let me get back to you with the details.`;
    }
    if (extractionType === 'TRAVEL') {
      return `Got the travel details, thank you${name}!`;
    }
    if (extractionType === 'COMPLAINT' || extractionType === 'URGENT') {
      return `Thanks for bringing this to my attention${name}. Looking into it right now.`;
    }
    if (extractionType === 'REMINDER' || extractionType === 'FOLLOW_UP') {
      return `Thanks for the reminder${name}! Will update you soon.`;
    }
    if (extractionType === 'DOCUMENT') {
      return `Received, thank you${name}! Going through it now.`;
    }
    if (extractionType === 'PROJECT_UPDATE') {
      return `Thanks for the update${name}, great progress!`;
    }
    return `Got it, thank you for the update${name}!`;
  }

  private async ensureReplySuggestion(
    userId: string,
    whatsappAccountId: string,
    conversationId: string,
    messageId: string,
    preview: string,
    senderName: string,
    fallbackText: string
  ) {
    try {
      const existing = await this.prisma.aIReplySuggestion.findFirst({
        where: { sourceMessageId: messageId },
      });
      if (existing) return;

      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      const currentUserName = user?.name || 'User';

      let replyText = fallbackText;
      try {
        const genResult = await this.generateReplySuggestionsWithTokens(
          preview,
          senderName,
          null,
          currentUserName
        );
        if (genResult && genResult.items.length > 0) {
          replyText = genResult.items[0].text;
        }
      } catch {
        // Fall back to fallbackText if Gemini generation fails
      }

      const created = await this.prisma.aIReplySuggestion.create({
        data: {
          userId,
          whatsappAccountId,
          conversationId,
          sourceMessageId: messageId,
          suggestion: replyText,
          tone: 'casual',
          language: 'en',
          sourceMessagePreview: preview.slice(0, 100),
          confidence: 0.9,
          contextSummary: `Generated for "${preview.slice(0, 40)}"`,
        },
      });

      this.eventsGateway.sendToUser(userId, 'ai:suggestion', {
        messageId,
        conversationId,
        suggestions: [{ text: replyText, tone: 'casual', confidence: 0.9 }],
      });
    } catch {
      // Ignore background persistence errors
    }
  }
}
