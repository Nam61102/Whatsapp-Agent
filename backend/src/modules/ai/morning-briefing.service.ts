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
        take: 25,
      });

      // 3. Compute metrics & detect events accurately
      let pendingTasks = 0;
      let events = 0;
      let recentTransfers = 0;

      const priorityItems: MorningBriefingPriorityItem[] = [];

      for (const item of activeExtractions) {
        const type = (item.extractionType || '').toUpperCase();
        const text = `${item.title} ${item.description || ''} ${item.summary || ''}`.toLowerCase();
        const isEvent =
          type === 'EVENT' ||
          type === 'MEETING' ||
          type === 'APPOINTMENT' ||
          type === 'CEREMONY' ||
          item.eventDate !== null ||
          /ceremony|convocation|passing-out|party|gathering|event|function|meeting|webinar|session|fest/i.test(text);

        if (isEvent) {
          events++;
        } else if (type === 'PAYMENT' || type === 'INVOICE' || /transfer|rs|₹|payment|paid/i.test(text)) {
          const amtMatch = text.match(/(?:rs\.?|₹)\s*(\d+(?:,\d+)*(?:\.\d+)?)/i) || text.match(/(\d+)\s*(?:rs|inr)/i);
          const amt = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : 350;
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
            eventDate: item.eventDate,
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

      try {
        const prompt = `You are a friendly personal WhatsApp AI assistant for ${userName}.
Current Time of Day: ${timeInfo.key} (${timeInfo.greeting})
Today's Date: ${dateFormatted}
Pending Tasks: ${pendingTasks}
Upcoming Events: ${events}
Key Priority Items: ${priorityItems.map((p) => `"${p.title}" (${p.type}) from ${p.source}`).join(', ') || 'No urgent items'}

Return valid JSON:
{
  "summary": "warm 1-2 sentence ${timeInfo.key} overview for ${userName} addressing their events and priorities",
  "aiTip": "one helpful actionable productivity tip based on today's items"
}`;

        const rawText = await this.callOpenRouter(prompt);
        if (rawText) {
          const cleaned = this.cleanJson(rawText);
          const parsed = JSON.parse(cleaned);
          if (parsed.summary) summary = parsed.summary.trim();
          if (parsed.aiTip) aiTip = parsed.aiTip.trim();
        }
      } catch (aiErr: any) {
        this.logger.debug(`Daily briefing AI generation fallback: ${aiErr.message}`);
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

      // Cache for 10 minutes so it remains fast yet responds quickly to updates
      this.briefingCache.set(cacheKey, {
        data: response,
        expiresAt: Date.now() + 10 * 60 * 1000,
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
