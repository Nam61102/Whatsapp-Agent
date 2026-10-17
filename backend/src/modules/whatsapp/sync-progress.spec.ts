// The Baileys library is ESM-only and not needed for progress maths.
jest.mock('./adapters/baileys.adapter', () => ({ BaileysAdapter: class {}, unwrapMessage: () => null }));
import { WhatsAppEventService } from './whatsapp-event.service';

function makeService() {
  const sent: any[] = [];
  const svc: any = Object.create(WhatsAppEventService.prototype);
  svc.syncProgressMap = new Map();
  svc.eventsGateway = { sendToUser: (_u: string, event: string, data: any) => sent.push({ event, data }) };
  return { svc: svc as any, sent };
}

describe('sync progress numbers', () => {
  it('counters stay consistent: processed never exceeds total, percentage is real', () => {
    const { svc } = makeService();
    const c1 = svc.stageCounters({ total: 0, processed: 0 }, 26, 26);
    expect(c1).toEqual({ total: 26, processed: 26, percentage: 100 });
    const c2 = svc.stageCounters(c1, 10, 4); // a batch where 4 of 10 could be handled
    expect(c2.processed).toBe(30);
    expect(c2.total).toBe(36);
    expect(c2.percentage).toBe(83);
    expect(c2.processed).toBeLessThanOrEqual(c2.total);
  });

  it('a new sync starts from zero after a finished one (no "26 of 1")', () => {
    const { svc } = makeService();
    svc.updateSyncProgress('u1', { currentStage: 'CONVERSATIONS', conversations: svc.stageCounters(svc.getWorkingProgress('u1').conversations, 26, 26) });
    svc.updateSyncProgress('u1', { status: 'COMPLETED', currentStage: 'COMPLETED', progress: 100 });
    expect(svc.getSyncProgress('u1').status).toBe('COMPLETED');

    // next cycle
    const working = svc.getWorkingProgress('u1');
    expect(working.conversations).toEqual({ total: 0, processed: 0, percentage: 0 });
    svc.updateSyncProgress('u1', { currentStage: 'CONVERSATIONS', conversations: svc.stageCounters(working.conversations, 3, 3) });
    const now = svc.getSyncProgress('u1');
    expect(now.conversations).toEqual({ total: 3, processed: 3, percentage: 100 });
    expect(now.status).not.toBe('COMPLETED');
  });

  it('skipped stages are left out, stages not reached yet count as zero', () => {
    const { svc } = makeService();
    svc.updateSyncProgress('u1', { currentStage: 'CONTACTS', contacts: { total: 1, processed: 1, percentage: 100 } });
    svc.updateSyncProgress('u1', { currentStage: 'CONVERSATIONS', conversations: { total: 26, processed: 26, percentage: 100 } });
    const p = svc.getSyncProgress('u1').progress;
    // contacts 100, groups skipped (nothing to do), conversations 100, messages not reached: 50 of 90 weight
    expect(p).toBe(56);
    expect(p).toBeLessThanOrEqual(99); // only a finished sync shows 100
  });

  it('never goes backwards while syncing, and only COMPLETED shows 100', () => {
    const { svc } = makeService();
    svc.updateSyncProgress('u1', { currentStage: 'CONVERSATIONS', conversations: { total: 10, processed: 10, percentage: 100 } });
    const before = svc.getSyncProgress('u1').progress;
    // the messages stage starts: more work appears, the overall bar must not drop
    svc.updateSyncProgress('u1', { currentStage: 'MESSAGES', messages: { total: 1000, processed: 0, percentage: 0 } });
    expect(svc.getSyncProgress('u1').progress).toBeGreaterThanOrEqual(before);
    svc.updateSyncProgress('u1', { currentStage: 'MESSAGES', messages: { total: 1000, processed: 1000, percentage: 100 } });
    expect(svc.getSyncProgress('u1').progress).toBeLessThan(100);
    svc.updateSyncProgress('u1', { status: 'COMPLETED', currentStage: 'COMPLETED' });
    expect(svc.getSyncProgress('u1').progress).toBe(100);
  });

  it('weights messages most when there is history to load', () => {
    const { svc } = makeService();
    svc.updateSyncProgress('u1', { currentStage: 'CONTACTS', contacts: { total: 5, processed: 5, percentage: 100 } });
    svc.updateSyncProgress('u1', { currentStage: 'MESSAGES', messages: { total: 100, processed: 10, percentage: 10 } });
    const p = svc.getSyncProgress('u1').progress;
    expect(p).toBeGreaterThan(20);
    expect(p).toBeLessThan(60);
  });

  it('contacts alone never jump the bar near 100%', () => {
    const { svc } = makeService();
    svc.updateSyncProgress('u1', { currentStage: 'CONTACTS', contacts: { total: 1, processed: 1, percentage: 100 } });
    expect(svc.getSyncProgress('u1').progress).toBeLessThanOrEqual(25);
  });
});

describe('waiting for the first history', () => {
  function svcWith(chatCount: number) {
    const { svc, sent } = makeService();
    svc.historySeen = new Set();
    svc.historyTimers = new Map();
    svc.prisma = { conversation: { count: async () => chatCount } };
    return { svc, sent };
  }
  afterEach(() => jest.useRealTimers());

  it('says what it is waiting for instead of sitting at 0%', async () => {
    const { svc } = svcWith(0);
    await svc.startHistoryWait('u1', 'a1');
    const p = svc.getSyncProgress('u1');
    expect(p.progress).toBeGreaterThan(0);
    expect(p.message).toMatch(/Waiting for WhatsApp/i);
    svc.markHistoryArrived('u1'); // clears the timer
  });

  it('does nothing for an account that already has chats (a plain reconnect)', async () => {
    const { svc } = svcWith(12);
    await svc.startHistoryWait('u1', 'a1');
    expect(svc.getSyncProgress('u1').status).toBe('IDLE');
    expect(svc.historyTimers.size).toBe(0);
  });

  it('ends the wait with a clear message if WhatsApp never sends history', async () => {
    jest.useFakeTimers();
    const { svc } = svcWith(0);
    await svc.startHistoryWait('u1', 'a1');
    jest.advanceTimersByTime(4 * 60 * 1000 + 100);
    const p = svc.getSyncProgress('u1');
    expect(p.status).toBe('COMPLETED');
    expect(p.progress).toBe(100);
    expect(p.message).toMatch(/did not send older chats/i);
  });

  it('does not end the wait once history has arrived', async () => {
    jest.useFakeTimers();
    const { svc } = svcWith(0);
    await svc.startHistoryWait('u1', 'a1');
    svc.markHistoryArrived('u1');
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(svc.getSyncProgress('u1').status).not.toBe('COMPLETED');
  });
});
