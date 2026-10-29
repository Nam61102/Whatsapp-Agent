import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface MorningBriefingPriorityItem {
  id: string;
  type: string;
  title: string;
  description: string;
  source: string;
  priority: string;
  eventDate?: Date | string | null;
}

export interface MorningBriefingResponse {
  success: boolean;
  greeting: string;
  dateFormatted: string;
  briefingTitle?: string;
  badgeIcon?: string;
  timeOfDay?: string;
  summary: string;
  metrics: {
    pendingTasks: number;
    events: number;
    recentTransfers: number;
  };
  priorityItems: MorningBriefingPriorityItem[];
  aiTip: string;
  generatedAt: string;
}

function getTimeOfDayInfo(): {
  greeting: string;
  icon: string;
  title: string;
  key: 'morning' | 'afternoon' | 'evening' | 'night';
} {
  const now = new Date();
  const kolkataHourStr = now.toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: '2-digit',
  });
  const hour = parseInt(kolkataHourStr, 10) || now.getHours();

  if (hour >= 4 && hour < 12) {
    return {
      greeting: 'Good Morning',
      icon: '☀️',
      title: 'AI MORNING BRIEFING',
      key: 'morning',
    };
  } else if (hour >= 12 && hour < 17) {
    return {
      greeting: 'Good Afternoon',
      icon: '🌤️',
      title: 'AI AFTERNOON BRIEFING',
      key: 'afternoon',
    };
  } else if (hour >= 17 && hour < 21) {
    return {
      greeting: 'Good Evening',
      icon: '🌆',
      title: 'AI EVENING BRIEFING',
      key: 'evening',
    };
  } else {
    return {
      greeting: 'Good Evening',
      icon: '🌙',
      title: 'AI NIGHT BRIEFING',
      key: 'night',
    };
  }
}

@Injectable()
export class MorningBriefingService {
  private readonly logger = new Logger(MorningBriefingService.name);
  // In-memory cache by userId:YYYY-MM-DD:period
  private briefingCache = new Map<string, { data: MorningBriefingResponse; expiresAt: number }>();

  constructor(private readonly prisma: PrismaService) {}

  clearCache(userId?: string): void {
    if (!userId) {
      this.briefingCache.clear();
      return;
    }
    for (const key of this.briefingCache.keys()) {
      if (key.startsWith(userId + ':')) {
        this.briefingCache.delete(key);
      }
    }
  }

  private cleanJson(raw: string): string {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return stripped.slice(start, end + 1);
    }
    return stripped;
  }

  private async callOpenRouter(prompt: string): Promise<string | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://whatsapp-ai.local',
          'X-Title': 'VAI-4 WhatsApp AI Daily Briefing',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 500,
          response_format: { type: 'json_object' },
        }),
      });
      clearTimeout(timer);
      if (!response.ok) return null;
      const data: any = await response.json();
      return data?.choices?.[0]?.message?.content || null;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Generates or retrieves cached daily briefing for the user with dynamic time-of-day awareness
   */
  async getMorningBriefing(userId: string, forceRefresh = false): Promise<MorningBriefingResponse> {
    const timeInfo = getTimeOfDayInfo();
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${userId}:${today}:${timeInfo.key}`;

    if (!forceRefresh) {
      const cached = this.briefingCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
      }
    }

    try {
      // 1. Fetch user profile
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const userName = (user?.name || 'Namrata').trim().split(/\s+/)[0];

      // 2. Fetch active action items & extractions
      const activeExtractions = await this.prisma.aIExtraction.findMany({
        where: {
          userId,
          status: { in: ['ACTIVE', 'IN_PROGRESS', 'REVIEWED'] },
        },
        include: {
          conversation: { select: { title: true } },
          contact: { select: { displayName: true } },
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        take: 30,
      });

      // 3. Compute metrics & strictly classify real events vs work/dev tasks
      let pendingTasks = 0;
      let events = 0;
      let recentTransfers = 0;

      const priorityItems: MorningBriefingPriorityItem[] = [];

      for (const item of activeExtractions) {
        const type = (item.extractionType || '').toUpperCase();
        const text = `${item.title} ${item.description || ''} ${item.summary || ''}`.toLowerCase();

        // Technical tasks, APK releases, optimization goals, sheets are NEVER events
        const isTechOrWorkTask = /\b(apk|optimization|analytics|engine|scanner|radar|intelligence|integration|database|frontend|backend|sheet|spreadsheet)\b/i.test(text);
        const isExplicitNonEvent = ['QUESTION', 'DOCUMENT', 'PAYMENT', 'INVOICE'].includes(type) || isTechOrWorkTask;

        // True calendar events: ceremonies, convocations, parties, meetings, gatherings, celebrations
        const hasEventKeyword = /\b(ceremony|convocation|passing[- ]out|party|gathering|celebration|wedding|reception|farewell|fest|festival|function|meetup|conference|webinar|seminar|annual day|get[- ]together)\b/i.test(text);

        const isEvent =
          !isExplicitNonEvent &&
          ((type === 'EVENT' || type === 'MEETING' || type === 'APPOINTMENT' || type === 'CEREMONY') || hasEventKeyword);

        if (isEvent) {
          events++;
        } else if (type === 'PAYMENT' || type === 'INVOICE') {
          // Strictly count real payment/invoice amounts
          let amt = 0;
          const sdAmounts = (item.structuredData as any)?.amounts || (item.structuredData as any)?.entities?.amounts;
          if (Array.isArray(sdAmounts) && sdAmounts.length > 0 && typeof sdAmounts[0].amount === 'number') {
            amt = sdAmounts[0].amount;
          } else {
            const amtMatch = text.match(/(?:rs\.?|₹|inr)\s*(\d+(?:,\d+)*(?:\.\d+)?)/i) || text.match(/(\d+)\s*(?:rs|inr|₹)/i);
            amt = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 0;
          }
          recentTransfers += amt;
        } else {
          pendingTasks++;
        }

        if (priorityItems.length < 5) {
          const sourceName =
            item.conversation?.title || item.contact?.displayName || 'WhatsApp Contact';
          priorityItems.push({
            id: item.id,
            type: isEvent ? 'EVENT' : type || 'TASK',
            title: item.title,
            description: item.summary || item.description || item.title,
            source: sourceName,
            priority: item.priority || 'NORMAL',
            eventDate: isEvent ? item.eventDate : null,
          });
        }
      }

      // 4. Generate AI summary
      const dateFormatted = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      });

      let summary = `${timeInfo.greeting}, ${userName}! You have ${events} upcoming event${events === 1 ? '' : 's'} and ${pendingTasks} active task${pendingTasks === 1 ? '' : 's'}.`;
      let aiTip = 'Stay on top of your daily WhatsApp tasks and communication goals.';

      if (pendingTasks === 0 && events === 0 && recentTransfers === 0) {
        summary = `Good ${timeInfo.key}, ${userName}! You have a clear schedule today with no pending tasks or upcoming events.`;
        aiTip = 'With no urgent items, consider dedicating some time to proactive planning or focusing on key priorities.';
      } else {
        try {
          const prompt = `You are a friendly personal WhatsApp AI assistant for ${userName}.
Current Time of Day: ${timeInfo.key} (${timeInfo.greeting})
Today's Date: ${dateFormatted}
Pending Tasks: ${pendingTasks}
Upcoming Events: ${events}
Key Priority Items: ${priorityItems.map((p) => `"${p.title}" (${p.type}) from ${p.source}`).join(", ") || "No urgent items"}

Note: Only real-world social/college/office gatherings (like Convocation, Ceremonies, Parties, Meetings) are events. Technical goals and tasks are tasks.
Return valid JSON:
{
  "summary": "warm 1-2 sentence ${timeInfo.key} overview for ${userName} addressing their events and priorities",
  "aiTip": "one helpful actionable productivity tip based on today's items"
}`;

          const rawText = await Promise.race<string | null>([
            this.callOpenRouter(prompt),
            new Promise<null>((r) => setTimeout(() => r(null), 2500)),
          ]);
          if (rawText) {
            const cleaned = this.cleanJson(rawText);
            const parsed = JSON.parse(cleaned);
            if (parsed.summary) summary = parsed.summary.trim();
            if (parsed.aiTip) aiTip = parsed.aiTip.trim();
          }
        } catch (aiErr: any) {
          this.logger.debug(`Daily briefing AI generation fallback: ${aiErr.message}`);
        }
      }

      const response: MorningBriefingResponse = {
        success: true,
        greeting: `${timeInfo.greeting}, ${userName}! ${timeInfo.icon}`,
        dateFormatted,
        briefingTitle: timeInfo.title,
        badgeIcon: timeInfo.icon,
        timeOfDay: timeInfo.key,
        summary,
        metrics: {
          pendingTasks,
          events,
          recentTransfers,
        },
        priorityItems,
        aiTip,
        generatedAt: new Date().toISOString(),
      };

      // Cache for 10 minutes, but if empty (during initial scan), cache for only 5 seconds
      const isEmpty = response.metrics.events === 0 && response.metrics.pendingTasks === 0;
      this.briefingCache.set(cacheKey, {
        data: response,
        expiresAt: Date.now() + (isEmpty ? 5000 : 10 * 60 * 1000),
      });

      return response;
    } catch (err: any) {
      this.logger.error(`Failed to generate briefing for user ${userId}: ${err.message}`);
      const fallbackInfo = getTimeOfDayInfo();
      return {
        success: true,
        greeting: `${fallbackInfo.greeting}! ${fallbackInfo.icon}`,
        dateFormatted: new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          timeZone: 'Asia/Kolkata',
        }),
        briefingTitle: fallbackInfo.title,
        badgeIcon: fallbackInfo.icon,
        timeOfDay: fallbackInfo.key,
        summary: 'Your daily WhatsApp communication overview is ready.',
        metrics: { pendingTasks: 0, events: 0, recentTransfers: 0 },
        priorityItems: [],
        aiTip: 'Keep your communications organized with AI Action Center.',
        generatedAt: new Date().toISOString(),
      };
    }
  }
}
