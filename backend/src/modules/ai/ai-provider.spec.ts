import { AIService } from './ai.service';
import { AIQueueService } from './ai-queue.service';
import { validateConfig } from '../../config-check';

const realFetch = global.fetch;
const realKey = process.env.OPENROUTER_API_KEY;

function service() {
  const svc: any = Object.create(AIService.prototype);
  svc.logger = { warn: () => {}, error: () => {} };
  return svc as AIService;
}
const reply = (status: number, body: any = {}, headers: Record<string, string> = {}) =>
  Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
const call = (svc: any, opts: any = {}) => svc.callGeminiWithTokens('prompt', opts);

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
});
afterEach(() => {
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = realKey;
});

describe('provider errors are classified and retry-aware', () => {
  it('429 is a retryable RATE_LIMIT and honours Retry-After', async () => {
    global.fetch = (() => reply(429, 'slow down', { 'retry-after': '7' })) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'RATE_LIMIT', retryable: true, retryAfterMs: 7000 });
  });

  it('5xx is a retryable PROVIDER_ERROR', async () => {
    global.fetch = (() => reply(503, 'unavailable')) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'PROVIDER_ERROR', retryable: true });
  });

  it('401 (bad key) is not retried', async () => {
    global.fetch = (() => reply(401, 'bad key')) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'PROVIDER_ERROR', retryable: false });
  });

  it('a hung request times out as PROVIDER_TIMEOUT', async () => {
    global.fetch = ((_u: any, init: any) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    await expect(call(service(), { timeoutMs: 30 })).rejects.toMatchObject({ category: 'PROVIDER_TIMEOUT', retryable: true });
  });

  it('a network failure is a retryable PROVIDER_ERROR', async () => {
    global.fetch = (() => Promise.reject(new Error('ECONNRESET'))) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'PROVIDER_ERROR', retryable: true });
  });

  it('a non-JSON body is INVALID_RESPONSE', async () => {
    global.fetch = (() => reply(200, '<html>oops</html>')) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'INVALID_RESPONSE' });
  });

  it('reports a cut-off answer', async () => {
    global.fetch = (() => reply(200, { choices: [{ message: { content: '{"items":[' }, finish_reason: 'length' }], usage: {} })) as any;
    const r = await call(service());
    expect(r.truncated).toBe(true);
  });

  it('an empty answer is never treated as "nothing found"', async () => {
    global.fetch = (() => reply(200, { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} })) as any;
    await expect(
      service().extractItemsWithTokens({ messageText: 'Call Rahul tomorrow', senderName: 'Amit' })
    ).rejects.toMatchObject({ category: 'INVALID_RESPONSE' });
  });

  it('uses the key from the environment and never sends anything else as the key', async () => {
    let auth = '';
    global.fetch = ((_u: any, init: any) => {
      auth = init.headers.Authorization;
      return reply(200, { choices: [{ message: { content: '{}' } }], usage: {} });
    }) as any;
    await call(service());
    expect(auth).toBe('Bearer sk-or-test-key');
  });

  it('without a key it fails fast, offline, and does not retry', async () => {
    delete process.env.OPENROUTER_API_KEY;
    let called = false;
    global.fetch = (() => ((called = true), reply(200))) as any;
    await expect(call(service())).rejects.toMatchObject({ category: 'PROVIDER_ERROR', retryable: false });
    expect(called).toBe(false);
  });
});

describe('startup configuration check', () => {
  it('names the problem but never prints a value', () => {
    const r = validateConfig({ DATABASE_URL: 'mongodb://x', JWT_SECRET: 's3cret', OPENROUTER_API_KEY: '' } as any);
    expect(r.fatal).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/OPENROUTER_API_KEY is not set/);
    expect(JSON.stringify(r)).not.toMatch(/s3cret|mongodb:\/\/x/);
  });

  it('stops the server when the database or JWT secret is missing', () => {
    const r = validateConfig({ OPENROUTER_API_KEY: 'sk-or-abc' } as any);
    expect(r.fatal).toEqual(['DATABASE_URL is not set', 'JWT_SECRET is not set']);
  });

  it('warns about a key that does not look like an OpenRouter key, without echoing it', () => {
    const r = validateConfig({ DATABASE_URL: 'x', JWT_SECRET: 'y', OPENROUTER_API_KEY: 'AIza-not-it-123' } as any);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toContain('AIza-not-it-123');
  });
});

describe('queue sweep', () => {
  const day = 24 * 60 * 60 * 1000;
  function queueWith(jobs: any[], messages: any[], settings: any) {
    const updated: any[] = [];
    const prisma: any = {
      aIProcessingJob: {
        findMany: async () => jobs,
        updateMany: async ({ where, data }: any) => (updated.push({ ids: where.id.in, data }), { count: where.id.in.length }),
        update: async ({ where, data }: any) => (updated.push({ ids: [where.id], data }), {}),
      },
      message: {
        findMany: async () => messages,
        findUnique: async ({ where }: any) => messages.find((m) => m.id === where.id) ?? null,
      },
      user: { findFirst: async () => ({ id: 'u1' }) },
      userSettings: { findUnique: async () => settings },
    };
    const queue: any = new AIQueueService(prisma, { processMessageAIJob: async () => {} } as any, {} as any);
    queue.processNextJob = () => {};
    return { queue, updated };
  }
  const job = (id: string, status: string, over: any = {}) => ({ id, entityId: `m-${id}`, userId: '64b000000000000000000001', whatsappAccountId: 'a1', jobType: 'MESSAGE_ANALYSIS', priority: 1, status, ...over });
  const msg = (id: string, ageMs: number) => ({ id: `m-${id}`, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1', messageTimestamp: new Date(Date.now() - ageMs) });

  it('skips jobs for old messages in bulk and revives recent ones', async () => {
    const { queue, updated } = queueWith(
      [job('old', 'QUEUED'), job('new', 'RETRYING')],
      [msg('old', 3 * day), msg('new', 60 * 1000)],
      { usedTokensToday: 0, dailyTokenLimit: 100000, lastTokenResetDate: new Date() }
    );
    await queue.sweepDueJobs();
    expect(updated[0]).toMatchObject({ ids: ['old'], data: { status: 'SKIPPED' } });
    expect(updated.some((u) => u.ids[0] === 'new' && u.data.status === 'QUEUED')).toBe(true);
    expect(queue.queue.map((q: any) => q.messageId)).toEqual(['m-new']);
  });

  it('a job paused by the token limit resumes on a new day instead of being stranded', async () => {
    const yesterday = new Date(Date.now() - day);
    const { queue } = queueWith([job('p', 'PAUSED_TOKEN_LIMIT')], [msg('p', 3 * 60 * 60 * 1000)], {
      usedTokensToday: 100000, dailyTokenLimit: 100000, lastTokenResetDate: yesterday,
    });
    await queue.sweepDueJobs();
    expect(queue.queue).toHaveLength(1);
  });

  it('the daily token cap is off by default, so an over-budget job is not held back', async () => {
    const { queue } = queueWith([job('p', 'PAUSED_TOKEN_LIMIT')], [msg('p', 60 * 1000)], {
      usedTokensToday: 100000, dailyTokenLimit: 100000, lastTokenResetDate: new Date(),
    });
    await queue.sweepDueJobs();
    expect(queue.queue).toHaveLength(1);
  });
});


describe('daily token cap', () => {
  it('does not stop analysis when usage is over the old limit', async () => {
    const svc: any = Object.create(AIService.prototype);
    svc.logger = { warn: () => {}, error: () => {} };
    svc.eventsGateway = { sendToUser: () => { throw new Error('must not announce a pause'); } };
    svc.prisma = { userSettings: { findUnique: async () => ({ dailyTokenLimit: 100000, usedTokensToday: 250000, lastTokenResetDate: new Date() }), update: async () => ({}) } };
    expect(await svc.checkTokenBudget('u1', 'a1')).toBe(true);
  });

  it('usage stats never report a pause', async () => {
    const svc: any = Object.create(AIService.prototype);
    svc.prisma = { userSettings: { findUnique: async () => ({ dailyTokenLimit: 100000, usedTokensToday: 250000 }) } };
    expect((await svc.getTokenUsageStats('u1', 'a1')).status).toBe('NORMAL');
  });
});
