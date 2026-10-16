/**
 * Integration tests against a REAL MongoDB (and optionally the REAL AI model).
 * They are skipped unless explicitly enabled, so `npm test` stays offline and safe:
 *
 *   INTEGRATION_DATABASE_URL=mongodb://127.0.0.1:27018/vai4_itest?replicaSet=rs0   (a throwaway database!)
 *   RUN_LIVE_AI=1   (also calls the real model; needs OPENROUTER_API_KEY in backend/.env)
 *
 * Prepare the throwaway database once:  DATABASE_URL=<that url> npx prisma db push
 */
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { AIService } from './ai.service';
import { AIQueueService } from './ai-queue.service';
import { ExtractionsService } from '../extractions/extractions.service';
import { buildItemKey } from './ai-extraction.types';

const URL_ = process.env.INTEGRATION_DATABASE_URL;
const LIVE = process.env.RUN_LIVE_AI === '1';
const suite = URL_ ? describe : describe.skip;

if (URL_ && /\/vai4(\?|$)/.test(URL_)) {
  throw new Error('Refusing to run integration tests against the main database "vai4". Use a throwaway database.');
}
if (LIVE) {
  // Loads the key into the environment only; it is never printed.
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
}

const gateway = { sendToUser: () => {}, sendToAccount: () => {} } as any;

suite('real MongoDB: duplicate prevention and persistence', () => {
  const prisma: PrismaClient = URL_ ? new PrismaClient({ datasources: { db: { url: URL_ } } }) : (null as any);
  let ids: { userId: string; accountId: string; contactId: string; convId: string };
  let n = 0;

  const addMessage = (text: string, at = new Date()) =>
    prisma.message.create({
      data: {
        userId: ids.userId,
        whatsappAccountId: ids.accountId,
        conversationId: ids.convId,
        externalMessageId: `ext-${Date.now()}-${++n}`,
        senderContactId: ids.contactId,
        senderType: 'CONTACT',
        textContent: text,
        isFromMe: false,
        messageTimestamp: at,
      },
    });

  const addJob = (messageId: string) =>
    prisma.aIProcessingJob.create({
      data: {
        userId: ids.userId,
        whatsappAccountId: ids.accountId,
        idempotencyKey: `${ids.accountId}:${messageId}:MESSAGE_ANALYSIS`,
        jobType: 'MESSAGE_ANALYSIS',
        entityType: 'message',
        entityId: messageId,
        status: 'QUEUED',
      },
    });

  beforeAll(async () => {
    await prisma.$connect();
    // Start clean: this database is throwaway.
    for (const m of ['aIExtractionSource', 'aIExtraction', 'aIReplySuggestion', 'aIProcessingJob', 'aITokenUsageLog', 'message', 'conversation', 'contact', 'userSettings', 'whatsAppAccount', 'user'] as const) {
      await (prisma as any)[m].deleteMany({});
    }
    const user = await prisma.user.create({ data: { authUserId: 'itest', email: 'itest@example.com', name: 'Vaibhav' } });
    const account = await prisma.whatsAppAccount.create({ data: { userId: user.id } });
    const contact = await prisma.contact.create({
      data: { userId: user.id, whatsappAccountId: account.id, externalContactId: '919999999999@s.whatsapp.net', displayName: 'Amit' },
    });
    const conv = await prisma.conversation.create({
      data: { userId: user.id, whatsappAccountId: account.id, externalChatId: '919999999999@s.whatsapp.net', contactId: contact.id, title: 'Amit' },
    });
    await prisma.userSettings.create({ data: { userId: user.id, aiReplySuggestions: false, retentionDays: 30 } });
    ids = { userId: user.id, accountId: account.id, contactId: contact.id, convId: conv.id };
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('the unique (messageId, itemKey) index exists', async () => {
    const idx: any = await (prisma as any).$runCommandRaw({ listIndexes: 'ai_extractions' });
    const names = idx.cursor.firstBatch.filter((i: any) => i.unique).map((i: any) => i.name);
    expect(names).toContain('ai_extractions_messageId_itemKey_key');
  });

  it('parallel writers saving overlapping items end with exactly one copy of each', async () => {
    const ai: any = new AIService(prisma as any, gateway);
    const msg = await addMessage('call Rahul at ten, send Priya the proposal, pay the electricity bill');
    const item = (title: string, excerpt: string) => ({
      extractionType: 'TASK', title, description: title, supportingText: excerpt, eventDate: null, eventTime: null,
      originalDateText: null, dateUncertain: false, priority: 'NORMAL', actionRequired: true, confidence: 0.9,
      isForCurrentUser: true, targetPerson: null, entities: {}, itemKey: buildItemKey('TASK', excerpt),
    });
    const a = item('Call Rahul', 'call Rahul at ten');
    const b = item('Send Priya the proposal', 'send Priya the proposal');
    const c = item('Pay the electricity bill', 'pay the electricity bill');
    const ctx = {
      userId: ids.userId, whatsappAccountId: ids.accountId, conversationId: ids.convId, contactId: ids.contactId,
      messageId: msg.id, updates: [], senderName: 'Amit', groupName: null,
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => ai.persistExtractionResult({ ...ctx, items: i % 2 ? [a, b, c] : [c, b, a] }))
    );
    const saved = await prisma.aIExtraction.findMany({ where: { messageId: msg.id } });
    expect(saved.map((s) => s.title).sort()).toEqual(['Call Rahul', 'Pay the electricity bill', 'Send Priya the proposal']);
    // every item was reported as created by exactly one of the writers
    expect(results.reduce((sum: number, r: any) => sum + r.created.length, 0)).toBe(3);
  });

  it('the database itself rejects a second row with the same message and item key', async () => {
    const msg = await addMessage('pay the water bill');
    const data = {
      userId: ids.userId, whatsappAccountId: ids.accountId, conversationId: ids.convId, messageId: msg.id,
      itemKey: 'same-key', extractionType: 'TASK', title: 'Pay water bill', summary: 's',
    };
    await prisma.aIExtraction.create({ data });
    await expect(prisma.aIExtraction.create({ data })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('only one of many concurrent workers claims a job', async () => {
    const msg = await addMessage('hello there');
    const job = await addJob(msg.id);
    const claim = () =>
      prisma.aIProcessingJob.updateMany({
        where: { id: job.id, status: { in: ['QUEUED', 'RETRYING', 'PAUSED_TOKEN_LIMIT', 'FAILED'] } },
        data: { status: 'PROCESSING' },
      });
    const counts = await Promise.all(Array.from({ length: 10 }, claim));
    expect(counts.map((c) => c.count).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('a repeated webhook delivery creates one job; concurrent enqueues are safe', async () => {
    const queue = new AIQueueService(prisma as any, { processMessageAIJob: async () => {} } as any, gateway);
    const msg = await addMessage('Please send the report by Friday');
    const payload = { messageId: msg.id, conversationId: ids.convId, whatsappAccountId: ids.accountId, userId: ids.userId };
    await Promise.all(Array.from({ length: 6 }, () => queue.enqueueMessageJob(payload)));
    expect(await prisma.aIProcessingJob.count({ where: { entityId: msg.id } })).toBe(1);
  });

  it('history endpoint data is isolated per user and paginates without gaps', async () => {
    const other = await prisma.user.create({ data: { authUserId: 'itest2', email: 'itest2@example.com', name: 'Other' } });
    const otherAcc = await prisma.whatsAppAccount.create({ data: { userId: other.id } });
    const svc = new ExtractionsService(prisma as any, {} as any);

    const total = await prisma.aIExtraction.count({ where: { userId: ids.userId } });
    expect(total).toBeGreaterThanOrEqual(4);
    const seen: string[] = [];
    for (let offset = 0; offset < total; offset += 2) {
      const page = await svc.getHistory(ids.userId, { limit: 2, offset });
      seen.push(...page.items.map((i: any) => i.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    const theirs = await svc.getHistory(other.id, {});
    expect(theirs.total).toBe(0);
    expect(otherAcc.id).not.toBe(ids.accountId);
  });
});

const liveSuite = URL_ && LIVE ? describe : describe.skip;

liveSuite('LIVE: real model, real MongoDB - the five-message scenario', () => {
  jest.setTimeout(180000);
  const prisma: PrismaClient = URL_ ? new PrismaClient({ datasources: { db: { url: URL_ } } }) : (null as any);
  let ids: { userId: string; accountId: string; contactId: string; convId: string };
  let n = 0;

  const receive = async (text: string) => {
    const ai: any = new AIService(prisma as any, gateway);
    const msg = await prisma.message.create({
      data: {
        userId: ids.userId, whatsappAccountId: ids.accountId, conversationId: ids.convId,
        externalMessageId: `live-${Date.now()}-${++n}`, senderContactId: ids.contactId, senderType: 'CONTACT',
        textContent: text, isFromMe: false, messageTimestamp: new Date(),
      },
    });
    const job = await prisma.aIProcessingJob.create({
      data: {
        userId: ids.userId, whatsappAccountId: ids.accountId, idempotencyKey: `${ids.accountId}:${msg.id}:MESSAGE_ANALYSIS`,
        jobType: 'MESSAGE_ANALYSIS', entityType: 'message', entityId: msg.id, status: 'QUEUED',
      },
    });
    await ai.processMessageAIJob({ messageId: msg.id, conversationId: ids.convId, whatsappAccountId: ids.accountId, userId: ids.userId });
    return { msg, job: await prisma.aIProcessingJob.findUnique({ where: { id: job.id } }) };
  };
  const items = () => prisma.aIExtraction.findMany({ where: { userId: ids.userId }, orderBy: { createdAt: 'asc' } });
  const dump = (label: string, rows: any[]) =>
    console.log(
      `${label}\n` +
        rows.map((r) => `  [${r.status}] ${r.extractionType} "${r.title}" due=${r.eventDate?.toISOString().slice(0, 10) ?? '-'} time=${(r.structuredData as any)?.eventTime ?? '-'} hist=${(r.history as any[])?.length ?? 0}`).join('\n')
    );

  beforeAll(async () => {
    expect((process.env.OPENROUTER_API_KEY || '').length).toBeGreaterThan(10);
    for (const m of ['aIExtractionSource', 'aIExtraction', 'aIReplySuggestion', 'aIProcessingJob', 'aITokenUsageLog', 'message', 'conversation', 'contact', 'userSettings', 'whatsAppAccount', 'user'] as const) {
      await (prisma as any)[m].deleteMany({});
    }
    const user = await prisma.user.create({ data: { authUserId: 'live', email: 'live@example.com', name: 'Vaibhav' } });
    const account = await prisma.whatsAppAccount.create({ data: { userId: user.id } });
    const contact = await prisma.contact.create({
      data: { userId: user.id, whatsappAccountId: account.id, externalContactId: '919999999999@s.whatsapp.net', displayName: 'Amit' },
    });
    const conv = await prisma.conversation.create({
      data: { userId: user.id, whatsappAccountId: account.id, externalChatId: '919999999999@s.whatsapp.net', contactId: contact.id, title: 'Amit' },
    });
    await prisma.userSettings.create({ data: { userId: user.id, aiReplySuggestions: false } });
    ids = { userId: user.id, accountId: account.id, contactId: contact.id, convId: conv.id };
  });
  afterAll(async () => prisma.$disconnect());

  it('runs all five messages through the real model and the real database', async () => {
    // 1
    const r1 = await receive('Call Rahul tomorrow at 10 AM and send Priya the proposal by Friday.');
    expect(r1.job?.status).toBe('COMPLETED');
    let rows = await items();
    dump('after message 1', rows);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => /rahul/i.test(r.title))).toBe(true);
    expect(rows.some((r) => /priya|proposal/i.test(r.title))).toBe(true);
    const afterFirst = rows.length;

    // 2
    const r2 = await receive('Also remind me to review the invoice next Monday.');
    expect(r2.job?.status).toBe('COMPLETED');
    rows = await items();
    dump('after message 2', rows);
    expect(rows.length).toBeGreaterThan(afterFirst);
    expect(rows.some((r) => /invoice/i.test(r.title))).toBe(true);
    const afterSecond = rows.length;

    // 3
    const r3 = await receive("Move Rahul's call to 11 AM.");
    expect(r3.job?.status).toBe('COMPLETED');
    rows = await items();
    dump('after message 3', rows);
    const call = rows.find((r) => /rahul/i.test(r.title))!;
    expect((call.structuredData as any).eventTime).toBe('11:00');
    expect((call.history as any[]).length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBe(afterSecond);

    // 4
    const r4 = await receive('The proposal has been sent.');
    expect(r4.job?.status).toBe('COMPLETED');
    rows = await items();
    dump('after message 4', rows);
    expect(rows.find((r) => /priya|proposal/i.test(r.title))!.status).toBe('COMPLETED');
    expect(rows.find((r) => /invoice/i.test(r.title))!.status).toBe('ACTIVE');
    expect(rows.length).toBe(afterSecond);

    // 5
    const before = JSON.stringify(await items());
    const r5 = await receive('Hi, thanks!');
    expect(['SKIPPED', 'COMPLETED']).toContain(r5.job?.status);
    expect(JSON.stringify(await items())).toBe(before);

    // Re-analysis of message 1 creates no copies and keeps the statuses.
    const fresh = await items();
    const ai: any = new AIService(prisma as any, gateway);
    await prisma.aIProcessingJob.update({ where: { id: r1.job!.id }, data: { status: 'RETRYING' } });
    await ai.processMessageAIJob({ messageId: r1.msg.id, conversationId: ids.convId, whatsappAccountId: ids.accountId, userId: ids.userId });
    const again = await items();
    dump('after re-analysis of message 1', again);
    expect(again.length).toBe(fresh.length);

    // History endpoint reads the same rows from the database.
    const svc = new ExtractionsService(prisma as any, {} as any);
    const open = await svc.getHistory(ids.userId, { status: 'ACTIVE,REVIEWED,IN_PROGRESS' });
    const done = await svc.getHistory(ids.userId, { status: 'COMPLETED' });
    expect(open.total + done.total).toBe(again.length);
    expect(done.items.some((i: any) => /priya|proposal/i.test(i.title))).toBe(true);
  });
});
