import { AIService } from './ai.service';
import { AIQueueService } from './ai-queue.service';
import { ExtractionsService } from '../extractions/extractions.service';
import { AIProcessingError } from './ai-extraction.types';

/** Minimal in-memory stand-in for the Prisma models the AI pipeline touches. */
function makeFakePrisma() {
  let seq = 0;
  let seqId = 0;
  const tick = () => new Date(Date.UTC(2026, 9, 15, 8, 0, seq++));
  const db = {
    extractions: [] as any[],
    messages: new Map<string, any>(),
    jobs: new Map<string, any>(),
    settings: {
      userId: 'u1',
      autoAIAnalysis: true,
      aiExtractions: true,
      aiReplySuggestions: false,
      dailyTokenLimit: 100000,
      usedTokensToday: 0,
      usedTokensThisMonth: 0,
      lastTokenResetDate: new Date(Date.now() + 60_000),
    } as any,
  };

  const match = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('notIn' in v) return !v.notIn.includes(row[k]);
        if ('lte' in v) return new Date(row[k]) <= new Date(v.lte);
        if ('not' in v) return row[k] !== v.not;
        return true;
      }
      return row[k] === v;
    });

  const prisma: any = {
    db,
    // Like a real transaction: if any write fails, the ones that succeeded are rolled back.
    $transaction: async (ops: Promise<any>[]) => {
      const results = await Promise.allSettled(ops);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failed) {
        results.forEach((r) => {
          if (r.status === 'fulfilled') db.extractions.splice(db.extractions.indexOf(r.value), 1);
        });
        throw failed.reason;
      }
      return results.map((r) => (r as PromiseFulfilledResult<any>).value);
    },
    aIProcessingJob: {
      findUnique: async ({ where }: any) => db.jobs.get(where.idempotencyKey) ?? null,
      findFirst: async ({ where }: any) => [...db.jobs.values()].find((j) => match(j, where)) ?? null,
      create: async ({ data }: any) => {
        if (db.jobs.has(data.idempotencyKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        const job = { id: `job${db.jobs.size + 1}`, attempts: 0, maxAttempts: 3, backoffDelayMs: 2000, ...data };
        db.jobs.set(data.idempotencyKey, job);
        return job;
      },
      update: async ({ where, data }: any) => {
        const job = [...db.jobs.values()].find((j) => j.id === where.id)!;
        Object.assign(job, data);
        return job;
      },
      // Atomic claim: only one caller can move a claimable job to PROCESSING.
      updateMany: async ({ where, data }: any) => {
        const job = [...db.jobs.values()].find((j) => j.id === where.id);
        const claimable = ['QUEUED', 'RETRYING', 'PAUSED_TOKEN_LIMIT', 'FAILED'];
        if (!job || !claimable.includes(job.status)) return { count: 0 };
        Object.assign(job, data);
        return { count: 1 };
      },
    },
    userSettings: {
      findUnique: async () => db.settings,
      update: async ({ data }: any) => Object.assign(db.settings, { usedTokensToday: db.settings.usedTokensToday + (data.usedTokensToday?.increment ?? 0) }),
    },
    user: { findUnique: async () => ({ name: 'Vaibhav' }) },
    aITokenUsageLog: { create: async () => ({}) },
    aIReplySuggestion: { findFirst: async () => null, create: async () => ({}) },
    message: {
      findUnique: async ({ where }: any) => db.messages.get(where.id) ?? null,
      findMany: async ({ where }: any) => {
        if (where.isFromMe) return [];
        return [...db.messages.values()]
          .filter((m) => m.conversationId === where.conversationId && m.messageTimestamp <= where.messageTimestamp.lte)
          .sort((a, b) => b.messageTimestamp - a.messageTimestamp);
      },
    },
    aIExtraction: {
      findFirst: async ({ where }: any) => db.extractions.find((e) => match(e, where)) ?? null,
      findMany: async ({ where }: any) => {
        const rows = db.extractions.filter((e) => match(e, where)).sort((a, b) => b.createdAt - a.createdAt);
        await new Promise((r) => setImmediate(r)); // lets concurrent workers interleave between read and write
        return rows;
      },
      create: async ({ data }: any) => {
        const { sources, ...rest } = data;
        await new Promise((r) => setImmediate(r));
        // The unique (messageId, itemKey) index
        if (db.extractions.some((e) => e.messageId === rest.messageId && e.itemKey === rest.itemKey)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `x${++seqId}`, createdAt: tick(), priority: 'NORMAL', ...rest };
        db.extractions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = db.extractions.find((e) => e.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  return prisma;
}

const events = () => {
  const sent: { event: string; data: any }[] = [];
  return { sent, sendToUser: (_u: string, event: string, data: any) => sent.push({ event, data }), sendToAccount: () => {} };
};

/** Stand-in for the model. Reads the new message and the offered open items from the prompt. */
function fakeModel(prompt: string) {
  const text = /NEW MESSAGE[^\n]*\n"""([\s\S]*?)"""/.exec(prompt)![1];
  const ref = (name: string) => new RegExp(`(E\\d+): \\[[A-Z_]+\\] [^\\n]*${name}`).exec(prompt)?.[1];
  const item = (o: any) => ({ type: 'TASK', priority: 'NORMAL', actionRequired: true, confidence: 0.95, isForCurrentUser: true, dateCertain: true, ...o });
  let out: any = { items: [], updates: [] };
  if (text.startsWith('Call Rahul')) {
    out = {
      items: [
        item({ title: 'Call Rahul', description: 'Call Rahul', supportingText: 'Call Rahul tomorrow at 10 AM', dueDate: '2026-10-16', dueTime: '10:00', originalDateText: 'tomorrow at 10 AM' }),
        item({ title: 'Send Priya the proposal', description: 'Send proposal', supportingText: 'send Priya the proposal by Friday', dueDate: '2026-10-16', originalDateText: 'by Friday' }),
      ],
    };
  } else if (text.startsWith('Also remind me')) {
    out = {
      items: [item({ type: 'REMINDER', title: 'Review the invoice', description: 'Review invoice', supportingText: 'remind me to review the invoice next Monday', dueDate: '2026-10-19', originalDateText: 'next Monday' })],
    };
  } else if (text.startsWith("Move Rahul's call")) {
    out = { updates: [{ target: ref('Call Rahul'), action: 'RESCHEDULE', newDueDate: '2026-10-16', newDueTime: '11:00', supportingText: "Move Rahul's call to 11 AM", confidence: 0.95 }], items: [] };
  } else if (text.startsWith('The proposal has been sent')) {
    out = { updates: [{ target: ref('Send Priya'), action: 'COMPLETE', supportingText: 'The proposal has been sent', confidence: 0.92 }], items: [] };
  }
  return { text: JSON.stringify(out), inputTokens: 10, outputTokens: 5 };
}

function setup(model: (prompt: string) => any = fakeModel) {
  const prisma = makeFakePrisma();
  const gateway = events();
  const ai: any = new AIService(prisma, gateway as any);
  ai.callGeminiWithTokens = async (prompt: string) => model(prompt);

  let n = 0;
  const receive = async (text: string) => {
    const id = `m${++n}`;
    prisma.db.messages.set(id, {
      id,
      userId: 'u1',
      conversationId: 'c1',
      whatsappAccountId: 'a1',
      textContent: text,
      isFromMe: false,
      messageTimestamp: new Date(Date.UTC(2026, 9, 15, 8, 0, n)),
      metadata: {},
      senderContact: null,
      conversation: { chatType: 'INDIVIDUAL', externalChatId: '9199@s.whatsapp.net', title: 'Amit', contactId: 'ct1', contact: { displayName: 'Amit' } },
    });
    // The message row exists first; the job is created by the (idempotent) enqueue.
    prisma.db.jobs.set(`a1:${id}:MESSAGE_ANALYSIS`, {
      id: `job-${id}`, idempotencyKey: `a1:${id}:MESSAGE_ANALYSIS`, status: 'QUEUED', attempts: 0, maxAttempts: 3, backoffDelayMs: 2000, userId: 'u1', entityId: id,
    });
    await ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });
    return id;
  };
  const jobOf = (id: string) => prisma.db.jobs.get(`a1:${id}:MESSAGE_ANALYSIS`);
  const rows = () => prisma.db.extractions as any[];
  return { prisma, ai, gateway, receive, jobOf, rows };
}

describe('WhatsApp conversation to saved items (acceptance scenario)', () => {
  it('keeps and updates items across five messages', async () => {
    const { receive, rows, jobOf, gateway } = setup();

    // 1. two independent actions
    const m1 = await receive('Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.');
    expect(rows()).toHaveLength(2);
    expect(new Set(rows().map((r) => r.messageId))).toEqual(new Set([m1]));
    expect(rows().map((r) => r.title).sort()).toEqual(['Call Rahul', 'Send Priya the proposal']);
    expect(rows().every((r) => r.status === 'ACTIVE' && r.userId === 'u1' && r.conversationId === 'c1')).toBe(true);
    expect(gateway.sent.filter((e) => e.event === 'ai:extraction')).toHaveLength(2);

    // 2. one more; the first two are still there
    await receive('Also remind me to review the invoice next Monday.');
    expect(rows()).toHaveLength(3);
    expect(rows().filter((r) => r.status === 'ACTIVE')).toHaveLength(3);

    // 3. reschedule updates the call, adds no duplicate, keeps history
    const m3 = await receive("Move Rahul's call to 11 AM.");
    expect(rows()).toHaveLength(3);
    const call = rows().find((r) => r.title === 'Call Rahul');
    expect(call.structuredData.eventTime).toBe('11:00');
    expect(call.history).toHaveLength(1);
    expect(call.history[0]).toMatchObject({ action: 'RESCHEDULE', messageId: m3 });
    expect(call.history[0].before.eventTime).toBe('10:00');
    expect(call.messageId).toBe(m1); // still points at its original source message

    // 4. completion marks only the proposal
    await receive('The proposal has been sent.');
    expect(rows().find((r) => r.title === 'Send Priya the proposal').status).toBe('COMPLETED');
    expect(rows().find((r) => r.title === 'Call Rahul').status).toBe('ACTIVE');
    expect(rows().find((r) => r.title === 'Review the invoice').status).toBe('ACTIVE');

    // 5. small talk creates nothing and removes nothing
    const before = JSON.stringify(rows());
    const m5 = await receive('Hi, thanks!');
    expect(JSON.stringify(rows())).toBe(before);
    expect(jobOf(m5).status).toBe('SKIPPED');
    expect(rows()).toHaveLength(3);
  });

  it('a new message never changes the status of earlier items', async () => {
    const { receive, rows } = setup();
    await receive('Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.');
    await receive('Please share the address of the venue');
    await receive('ok see you');
    expect(rows().every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('running the same job twice does not duplicate items', async () => {
    const { receive, ai, rows, prisma, jobOf } = setup();
    const id = await receive('Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.');
    expect(rows()).toHaveLength(2);

    jobOf(id).status = 'RETRYING';
    await ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });
    expect(rows()).toHaveLength(2);
    expect(jobOf(id).status).toBe('COMPLETED');
    expect(prisma.db.extractions.map((r: any) => r.itemKey).every(Boolean)).toBe(true);
  });

  it('a completed job is not processed again', async () => {
    const { receive, ai, rows, jobOf } = setup();
    const id = await receive('Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.');
    expect(jobOf(id).status).toBe('COMPLETED');
    await ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });
    expect(rows()).toHaveLength(2);
  });
});

describe('duplicate prevention', () => {
  const MSG1 = 'Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.';
  const run = (ai: any, id: string) =>
    ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });

  it('two workers on the same job: only one processes it', async () => {
    let modelCalls = 0;
    const { prisma, ai, rows, jobOf } = setup((p) => (modelCalls++, fakeModel(p)));
    prisma.db.messages.set('mA', {
      id: 'mA', userId: 'u1', conversationId: 'c1', whatsappAccountId: 'a1', textContent: MSG1, isFromMe: false,
      messageTimestamp: new Date(Date.UTC(2026, 9, 15, 8, 0, 1)), metadata: {}, senderContact: null,
      conversation: { chatType: 'INDIVIDUAL', externalChatId: 'x@s.whatsapp.net', title: 'Amit', contactId: 'ct1', contact: { displayName: 'Amit' } },
    });
    prisma.db.jobs.set('a1:mA:MESSAGE_ANALYSIS', { id: 'jobA', idempotencyKey: 'a1:mA:MESSAGE_ANALYSIS', status: 'QUEUED', attempts: 0, maxAttempts: 3, backoffDelayMs: 2000, userId: 'u1', entityId: 'mA' });

    await Promise.all([run(ai, 'mA'), run(ai, 'mA'), run(ai, 'mA')]);
    expect(modelCalls).toBe(1);
    expect(rows()).toHaveLength(2);
    expect(jobOf('mA').status).toBe('COMPLETED');
  });

  it('racing writers saving the same items end with exactly one copy of each', async () => {
    const { ai, rows } = setup();
    const { buildItemKey } = require('./ai-extraction.types');
    const item = (title: string, excerpt: string) => ({
      extractionType: 'TASK', title, description: title, supportingText: excerpt, eventDate: null, eventTime: null,
      originalDateText: null, dateUncertain: false, priority: 'NORMAL', actionRequired: true, confidence: 0.9,
      isForCurrentUser: true, targetPerson: null, entities: {}, itemKey: buildItemKey('TASK', excerpt),
    });
    const a = item('Call Rahul', 'call Rahul at ten');
    const b = item('Send Priya the proposal', 'send Priya the proposal');
    const c = item('Pay the electricity bill', 'pay the electricity bill');
    const ctx = { userId: 'u1', whatsappAccountId: 'a1', conversationId: 'c1', contactId: 'ct1', messageId: 'mX', updates: [], senderName: 'Amit', groupName: null };

    await Promise.all([
      (ai as any).persistExtractionResult({ ...ctx, items: [a, b] }),
      (ai as any).persistExtractionResult({ ...ctx, items: [b, c] }),
      (ai as any).persistExtractionResult({ ...ctx, items: [a, b, c] }),
    ]);
    expect(rows().map((r) => r.title).sort()).toEqual(['Call Rahul', 'Pay the electricity bill', 'Send Priya the proposal']);
  });

  it('re-analysis with different wording does not copy existing items', async () => {
    let reworded = false;
    const { receive, ai, rows, jobOf } = setup((p) => {
      const r = fakeModel(p);
      if (!reworded) return r;
      const o = JSON.parse(r.text);
      o.items = o.items.map((i: any) => ({ ...i, title: i.title + ' (ASAP)', description: 'reworded', dueDate: '2026-10-17' }));
      return { ...r, text: JSON.stringify(o) };
    });
    const id = await receive(MSG1);
    expect(rows()).toHaveLength(2);
    reworded = true;
    jobOf(id).status = 'FAILED';
    await run(ai, id);
    expect(rows()).toHaveLength(2);
  });

  it('re-analysis does not duplicate a legacy item that has no excerpt or key', async () => {
    const { receive, ai, rows, jobOf } = setup();
    const id = await receive(MSG1);
    const [first] = rows();
    delete first.itemKey;
    delete first.supportingText;
    jobOf(id).status = 'FAILED';
    await run(ai, id);
    expect(rows()).toHaveLength(2);
    expect(rows().filter((r) => r.title === 'Call Rahul')).toHaveLength(1);
  });

  it('keeps a user-changed status when a message is re-analyzed', async () => {
    const { receive, ai, rows, jobOf } = setup();
    const id = await receive(MSG1);
    rows().find((r) => r.title === 'Call Rahul').status = 'COMPLETED';
    jobOf(id).status = 'FAILED';
    await run(ai, id);
    expect(rows()).toHaveLength(2);
    expect(rows().find((r) => r.title === 'Call Rahul').status).toBe('COMPLETED');
  });
});

describe('failures keep the message and are retried', () => {
  const MSG = 'Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.';

  it('a provider timeout is recorded, retried, and the message survives', async () => {
    let fail = true;
    const { receive, ai, rows, jobOf, prisma } = setup((p) => {
      if (fail) throw new AIProcessingError('timed out', 'PROVIDER_TIMEOUT');
      return fakeModel(p);
    });
    const id = await receive(MSG);
    const job = jobOf(id);
    expect(job).toMatchObject({ status: 'RETRYING', attempts: 1, errorCategory: 'PROVIDER_TIMEOUT', failedStage: 'EXTRACTION' });
    expect(job.nextRetryAt).toBeInstanceOf(Date);
    expect(prisma.db.messages.get(id).textContent).toBe(MSG);
    expect(rows()).toHaveLength(0);

    fail = false; // provider recovers; the retry runs
    await ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });
    expect(jobOf(id).status).toBe('COMPLETED');
    expect(rows()).toHaveLength(2);
  });

  it('gives up after the maximum attempts and reports it', async () => {
    const { receive, ai, jobOf, gateway } = setup(() => {
      throw new AIProcessingError('bad gateway', 'PROVIDER_ERROR');
    });
    const id = await receive(MSG);
    for (let i = 0; i < 2; i++) await ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });
    expect(jobOf(id)).toMatchObject({ status: 'FAILED', attempts: 3, errorCategory: 'PROVIDER_ERROR', nextRetryAt: null });
    expect(gateway.sent.some((e) => e.event === 'ai:failed')).toBe(true);
  });

  it('a permanent error is not retried', async () => {
    const { receive, jobOf } = setup(() => {
      throw new AIProcessingError('invalid api key', 'PROVIDER_ERROR', false);
    });
    const id = await receive(MSG);
    expect(jobOf(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
  });

  it('malformed model output is recorded as INVALID_RESPONSE and retried', async () => {
    const { receive, jobOf } = setup(() => ({ text: '{"items": [', inputTokens: 1, outputTokens: 1 }));
    const id = await receive(MSG);
    expect(jobOf(id)).toMatchObject({ status: 'RETRYING', errorCategory: 'INVALID_RESPONSE' });
  });

  it('a database write failure is surfaced and retried, not marked successful', async () => {
    const { receive, jobOf, prisma, rows } = setup();
    const create = prisma.aIExtraction.create;
    prisma.aIExtraction.create = async () => {
      throw new Error('write failed');
    };
    const id = await receive(MSG);
    expect(jobOf(id)).toMatchObject({ status: 'RETRYING', errorCategory: 'DATABASE', failedStage: 'PERSISTENCE' });
    expect(rows()).toHaveLength(0);
    prisma.aIExtraction.create = create;
  });
});

describe('queue', () => {
  it('a repeated webhook creates only one job', async () => {
    const prisma = makeFakePrisma();
    prisma.userSettings.findUnique = async () => prisma.db.settings;
    const ai: any = { processMessageAIJob: async () => {} };
    const queue = new AIQueueService(prisma, ai, events() as any);
    const payload = { messageId: 'm1', conversationId: 'c1', whatsappAccountId: 'a1', userId: '64b000000000000000000001' };
    await queue.enqueueMessageJob(payload);
    await queue.enqueueMessageJob(payload);
    expect(prisma.db.jobs.size).toBe(1);
  });
});

describe('Action Center data access', () => {
  function service(rows: any[]) {
    const calls: any[] = [];
    const prisma: any = {
      whatsAppAccount: { findFirst: async ({ where }: any) => (where.userId === 'u1' ? { id: 'a1' } : null) },
      aIExtraction: {
        count: async ({ where }: any) => (calls.push(where), rows.length),
        findMany: async (args: any) => (calls.push(args.where), rows.slice(args.skip, args.skip + args.take)),
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
        update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
      },
    };
    return { svc: new ExtractionsService(prisma, {} as any), calls };
  }
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, userId: 'u1', whatsappAccountId: 'a1', status: 'ACTIVE', history: [] }));

  it('every query is limited to the signed-in user and workspace', async () => {
    const { svc, calls } = service(rows);
    await svc.getHistory('u1', { search: 'rahul', status: 'ACTIVE,COMPLETED' });
    expect(calls[0]).toMatchObject({ userId: 'u1', whatsappAccountId: 'a1', status: { in: ['ACTIVE', 'COMPLETED'] } });
    expect(calls[0].OR.length).toBeGreaterThan(0);
  });

  it('pages through all records without losing any', async () => {
    const { svc } = service(rows);
    const first = await svc.getHistory('u1', { limit: 2, offset: 0 });
    const second = await svc.getHistory('u1', { limit: 2, offset: 2 });
    const third = await svc.getHistory('u1', { limit: 2, offset: 4 });
    expect([...first.items, ...second.items, ...third.items].map((r: any) => r.id)).toEqual(['x0', 'x1', 'x2', 'x3', 'x4']);
    expect(first.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
  });

  it('rejects unknown filters', async () => {
    const { svc } = service(rows);
    await expect(svc.getHistory('u1', { status: 'BOGUS' })).rejects.toThrow(/Unknown status/);
    await expect(svc.getHistory('u1', { priority: 'MEGA' })).rejects.toThrow(/priority/);
  });

  it('another user cannot read or edit these items', async () => {
    const { svc } = service(rows);
    await expect(svc.getHistory('u2', {})).rejects.toThrow();
    await expect(svc.updateItem('u2', 'x0', { status: 'COMPLETED' })).rejects.toThrow();
  });

  it('edits persist and are recorded in the history of the item', async () => {
    const { svc } = service(rows.map((r) => ({ ...r })));
    const out: any = await svc.updateItem('u1', 'x0', { status: 'COMPLETED', priority: 'high', notes: 'done by phone' });
    expect(out).toMatchObject({ status: 'COMPLETED', priority: 'HIGH', notes: 'done by phone' });
    expect(out.history[0]).toMatchObject({ action: 'USER_EDIT' });
  });

  it('rejects invalid edits', async () => {
    const { svc } = service(rows.map((r) => ({ ...r })));
    await expect(svc.updateItem('u1', 'x0', { status: 'GONE' })).rejects.toThrow();
    await expect(svc.updateItem('u1', 'x0', { title: '   ' })).rejects.toThrow();
    await expect(svc.updateItem('u1', 'x0', {})).rejects.toThrow(/Nothing to update/);
  });
});


describe('changes are applied in message order', () => {
  const MSG1 = 'Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.';
  const refOf = (prompt: string, name: string) => new RegExp(`(E\\d+): \\[[A-Z_]+\\] [^\\n]*${name}`).exec(prompt)?.[1];
  const run = (ai: any, id: string) =>
    ai.processMessageAIJob({ messageId: id, conversationId: 'c1', whatsappAccountId: 'a1', userId: 'u1' });

  it('re-analysing an old message cannot undo a later reschedule', async () => {
    let replay = false;
    const { receive, ai, rows, jobOf } = setup((p) => {
      const r = fakeModel(p);
      if (!replay || !/NEW MESSAGE[^\n]*\n"""Call Rahul/.test(p)) return r;
      const o = JSON.parse(r.text);
      // the model wrongly reads message 1 as a request to move the call back to 10:00
      o.updates = [{ target: refOf(p, 'Call Rahul'), action: 'RESCHEDULE', newDueDate: '2026-10-16', newDueTime: '10:00', supportingText: 'Call Rahul tomorrow at 10 AM', confidence: 0.95 }];
      return { ...r, text: JSON.stringify(o) };
    });
    const m1 = await receive(MSG1);
    await receive("Move Rahul's call to 11 AM.");
    expect(rows().find((r) => r.title === 'Call Rahul').structuredData.eventTime).toBe('11:00');

    replay = true;
    jobOf(m1).status = 'FAILED';
    await run(ai, m1);
    const call = rows().find((r) => r.title === 'Call Rahul');
    expect(call.structuredData.eventTime).toBe('11:00');
    expect(call.history).toHaveLength(1);
  });

  it('an update from a message older than the last change is ignored', async () => {
    const { receive, ai, rows, prisma } = setup();
    await receive(MSG1);
    await receive("Move Rahul's call to 11 AM."); // m2, newer
    // an older message that also asks for a reschedule
    prisma.db.messages.set('mOld', {
      id: 'mOld', userId: 'u1', conversationId: 'c1', whatsappAccountId: 'a1', textContent: "Move Rahul's call to 9 AM.", isFromMe: false,
      messageTimestamp: new Date(Date.UTC(2026, 9, 15, 7, 0, 0)), metadata: {}, senderContact: null,
      conversation: { chatType: 'INDIVIDUAL', externalChatId: 'x@s.whatsapp.net', title: 'Amit', contactId: 'ct1', contact: { displayName: 'Amit' } },
    });
    prisma.db.jobs.set('a1:mOld:MESSAGE_ANALYSIS', { id: 'jobOld', idempotencyKey: 'a1:mOld:MESSAGE_ANALYSIS', status: 'QUEUED', attempts: 0, maxAttempts: 3, backoffDelayMs: 2000, userId: 'u1', entityId: 'mOld' });
    ai.callGeminiWithTokens = async (p: string) => ({
      text: JSON.stringify({ items: [], updates: [{ target: refOf(p, 'Call Rahul'), action: 'RESCHEDULE', newDueDate: '2026-10-16', newDueTime: '09:00', supportingText: "Move Rahul's call to 9 AM", confidence: 0.95 }] }),
      inputTokens: 1, outputTokens: 1,
    });
    await run(ai, 'mOld');
    expect(rows().find((r) => r.title === 'Call Rahul').structuredData.eventTime).toBe('11:00');
  });

  it('the same sentence labelled differently on another run is not saved twice', async () => {
    let relabel = false;
    const { receive, ai, rows, jobOf } = setup((p) => {
      const r = fakeModel(p);
      if (!relabel) return r;
      const o = JSON.parse(r.text);
      o.items = o.items.map((i: any) => ({ ...i, type: i.type === 'TASK' ? 'REMINDER' : 'TASK' }));
      return { ...r, text: JSON.stringify(o) };
    });
    const id = await receive(MSG1);
    relabel = true;
    jobOf(id).status = 'FAILED';
    await run(ai, id);
    expect(rows()).toHaveLength(2);
  });
});

describe('group birthday wishes', () => {
  const wish = (extra: any = {}) => ({
    type: 'BIRTHDAY', title: 'Birthday wish', description: 'A group member wished happy birthday.', supportingText: 'Happy Birthday',
    dueDate: null, confidence: 0.95, birthdayPerson: null, isForCurrentUser: false, ...extra,
  });
  const persist = (ai: any, messageId: string, items: any[]) => {
    const { buildItemKey } = require('./ai-extraction.types');
    return ai.persistExtractionResult({
      userId: 'u1', whatsappAccountId: 'a1', conversationId: 'c1', contactId: 'ct1', messageId, updates: [], senderName: 'Member', groupName: 'MCA 2024-2026',
      items: items.map((i) => ({
        extractionType: 'BIRTHDAY', title: i.title, description: i.description, supportingText: i.supportingText, eventDate: '2026-10-16', eventTime: null,
        originalDateText: null, dateUncertain: false, priority: 'NORMAL', actionRequired: false, confidence: 0.95, isForCurrentUser: false,
        targetPerson: i.person ?? null, entities: {}, itemKey: buildItemKey('BIRTHDAY', i.supportingText),
      })),
    });
  };

  it('eight wishes for one birthday give one card, titled after the group', async () => {
    const { ai, rows } = setup();
    for (let n = 1; n <= 8; n++) await persist(ai, `w${n}`, [{ title: 'Birthday wish', description: 'wish', supportingText: `Happy Birthday sir ${n}` }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].title).toBe('Birthday wishes in MCA 2024-2026');
    expect(rows()[0].structuredData.birthdayPerson).toBeNull();
  });

  it('a wish that names the person is saved next to an unnamed one, once per person', async () => {
    const { ai, rows } = setup();
    await persist(ai, 'w1', [{ title: 'Birthday wish', description: 'x', supportingText: 'Happy Birthday sir' }]);
    await persist(ai, 'w2', [{ title: "Dabhade's birthday", description: 'x', supportingText: 'Happy Birthday Dabhade sir', person: 'Dabhade' }]);
    await persist(ai, 'w3', [{ title: "Dabhade's birthday", description: 'x', supportingText: 'Happiest Birthday Dabhade', person: 'Dabhade' }]);
    await persist(ai, 'w4', [{ title: 'Birthday wish', description: 'x', supportingText: 'Happy Birthday lord' }]);
    expect(rows().map((r) => r.structuredData.birthdayPerson)).toEqual([null, 'Dabhade']);
  });

  it('turns @number mentions into contact names', async () => {
    const { ai, prisma } = setup();
    prisma.contact = {
      findMany: async ({ where }: any) =>
        where.externalContactId ? [] : [{ displayName: 'Dabhade Sir', lid: '127831229104315@lid', externalContactId: '9199@s.whatsapp.net', phoneNumber: '+919999' }],
    };
    prisma.lIDMapping = { findMany: async () => [] };
    const map = await (ai as any).resolveMentions('u1', ['Happy Birthday @127831229104315 sir', 'no mention here']);
    expect(map.get('127831229104315')).toBe('Dabhade Sir');
  });

  it('a mention that matches nobody is left alone', async () => {
    const { ai, prisma } = setup();
    prisma.contact = { findMany: async () => [] };
    prisma.lIDMapping = { findMany: async () => [] };
    expect((await (ai as any).resolveMentions('u1', ['hi @127831229104315'])).size).toBe(0);
  });
});

describe('Reply Needed is only for important messages', () => {
  const replyingModel = (extraction: any) => (prompt: string) => {
    if (prompt.includes('You write ONE WhatsApp reply')) {
      return { text: JSON.stringify([{ text: 'ok bhai', language: 'hinglish', confidence: 0.95 }]), inputTokens: 1, outputTokens: 1 };
    }
    return { text: JSON.stringify(extraction), inputTokens: 1, outputTokens: 1 };
  };
  const meeting = {
    items: [{ type: 'MEETING', title: 'Meeting with Amit', description: 'Meeting at 5', supportingText: 'meeting tomorrow at 5pm', dueDate: '2026-10-16', dueTime: '17:00', originalDateText: 'tomorrow at 5pm', dateCertain: true, priority: 'NORMAL', actionRequired: true, confidence: 0.95, isForCurrentUser: true }],
    updates: [],
  };

  it('a casual question gets no saved reply and no AI call at all', async () => {
    let calls = 0;
    const { receive, prisma } = setup((p) => (calls++, replyingModel({ items: [], updates: [] })(p)));
    prisma.db.settings.aiReplySuggestions = true;
    const created: any[] = [];
    prisma.aIReplySuggestion.create = async ({ data }: any) => (created.push(data), data);
    await receive('tu aala ka?');
    await receive('Changl ye');
    await receive('Mi radli tari');
    expect(created).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('an important message that needs an answer does get one', async () => {
    const { receive, prisma } = setup(replyingModel(meeting));
    prisma.db.settings.aiReplySuggestions = true;
    const created: any[] = [];
    prisma.aIReplySuggestion.create = async ({ data }: any) => (created.push(data), data);
    await receive('Hello, we have a meeting tomorrow at 5pm, can you join?');
    expect(created).toHaveLength(1);
    expect(created[0].suggestion).toBe('ok bhai');
  });

  it('an important item without anything to answer gets no reply', async () => {
    const info = { items: [{ ...meeting.items[0], type: 'INSTRUCTION', title: 'Note', supportingText: 'meeting tomorrow at 5pm' }], updates: [] };
    const { receive, prisma } = setup(replyingModel(info));
    prisma.db.settings.aiReplySuggestions = true;
    const created: any[] = [];
    prisma.aIReplySuggestion.create = async ({ data }: any) => (created.push(data), data);
    await receive('FYI meeting tomorrow at 5pm');
    expect(created).toHaveLength(0);
  });
});

describe('a reply sent from a card closes that card', () => {
  const MSG = 'Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.';

  it('marks only that item completed, records the reply, and keeps the others', async () => {
    const { receive, ai, rows, gateway } = setup();
    await receive(MSG);
    const [first, second] = rows();
    await ai.resolveActionItem('u1', first.id, 'FOLLOW_UP');
    expect(rows().find((r) => r.id === first.id).status).toBe('COMPLETED');
    expect(rows().find((r) => r.id === first.id).history.at(-1)).toMatchObject({ action: 'REPLIED' });
    expect(rows().find((r) => r.id === second.id).status).toBe('ACTIVE');
    expect(gateway.sent.some((e) => e.event === 'dashboard:updated')).toBe(true);
  });

  it('marks a suggested-reply card as used', async () => {
    const { ai, prisma } = setup();
    const calls: any[] = [];
    prisma.aIReplySuggestion.updateMany = async (a: any) => (calls.push(a), { count: 1 });
    await ai.resolveActionItem('u1', 'sug1', 'REPLY_NEEDED');
    expect(calls[0]).toMatchObject({ where: { id: 'sug1', userId: 'u1' }, data: { isUsed: true } });
  });

  it('does nothing for a closed item, another user, or an unknown id', async () => {
    const { receive, ai, rows } = setup();
    await receive(MSG);
    const item = rows()[0];
    item.status = 'DISMISSED';
    await ai.resolveActionItem('u1', item.id, 'FOLLOW_UP');
    expect(item.status).toBe('DISMISSED');
    await expect(ai.resolveActionItem('u1', 'nope', 'FOLLOW_UP')).resolves.toBeUndefined();
  });
});

describe('replying in the chat closes the cards it answers', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 9, 16, 16, min, 0));
  function world() {
    const w = setup();
    const msgs: Record<string, Date> = { old: T(0), mine1: T(10), new1: T(20), new2: T(25) };
    w.prisma.message.findFirst = async ({ where }: any) => {
      const lt = where.messageTimestamp.lt;
      return lt > msgs.mine1 ? { messageTimestamp: msgs.mine1 } : null; // my previous reply was at T(10)
    };
    w.prisma.message.findMany = async ({ where }: any) =>
      (where.id.in as string[]).map((id) => ({ id, messageTimestamp: msgs[id] }));
    const add = (messageId: string, type: string, over: any = {}) =>
      w.prisma.db.extractions.push({ id: `x-${messageId}-${type}`, userId: 'u1', conversationId: 'c1', messageId, extractionType: type, status: 'ACTIVE', history: [], structuredData: {}, ...over });
    return { ...w, add };
  }

  it('closes cards from messages received since my previous reply, and keeps older ones', async () => {
    const { ai, rows, add } = world();
    add('old', 'MEETING'); // answered by my earlier reply, still open for other reasons: stays
    add('new1', 'MEETING');
    add('new2', 'QUESTION');
    const closed = await ai.resolveRepliedItems('u1', 'c1', T(30));
    expect(closed).toBe(2);
    expect(rows().find((r) => r.messageId === 'old').status).toBe('ACTIVE');
    expect(rows().filter((r) => r.status === 'COMPLETED').map((r) => r.extractionType).sort()).toEqual(['MEETING', 'QUESTION']);
    expect(rows().find((r) => r.messageId === 'new1').history.at(-1)).toMatchObject({ action: 'REPLIED' });
  });

  it('leaves information-only items and other chats alone', async () => {
    const { ai, rows, add } = world();
    add('new1', 'INSTRUCTION');
    add('new1', 'CONTACT');
    add('new2', 'MEETING', { conversationId: 'other-chat' });
    expect(await ai.resolveRepliedItems('u1', 'c1', T(30))).toBe(0);
    expect(rows().every((r) => r.status === 'ACTIVE')).toBe(true);
  });

  it('closes a birthday wish for me but not a wish for someone else', async () => {
    const { ai, rows, add } = world();
    add('new1', 'BIRTHDAY', { structuredData: { isForCurrentUser: true } });
    add('new2', 'BIRTHDAY', { structuredData: { isForCurrentUser: false } });
    await ai.resolveRepliedItems('u1', 'c1', T(30));
    expect(rows().find((r) => r.messageId === 'new1').status).toBe('COMPLETED');
    expect(rows().find((r) => r.messageId === 'new2').status).toBe('ACTIVE');
  });

  it('does not touch items that are already closed', async () => {
    const { ai, rows, add } = world();
    add('new1', 'MEETING', { status: 'DISMISSED' });
    expect(await ai.resolveRepliedItems('u1', 'c1', T(30))).toBe(0);
    expect(rows()[0].status).toBe('DISMISSED');
  });
});
