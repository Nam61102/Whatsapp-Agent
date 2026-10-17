jest.mock('./adapters/baileys.adapter', () => ({ BaileysAdapter: class {}, unwrapMessage: () => null }));
import { WhatsAppEventService } from './whatsapp-event.service';
import { PrismaService } from '../../prisma/prisma.service';

function make(existing: any[] = []) {
  const calls = { findMany: 0, createMany: [] as any[], update: [] as any[], create: 0 };
  const svc: any = Object.create(WhatsAppEventService.prototype);
  svc.logger = { warn: () => {}, log: () => {} };
  svc.prisma = {
    lIDMapping: {
      findMany: async () => (calls.findMany++, existing),
      createMany: async ({ data }: any) => (calls.createMany.push(data), { count: data.length }),
      update: async (a: any) => (calls.update.push(a), {}),
      create: async () => (calls.create++, {}),
    },
  };
  return { svc, calls };
}

describe('saving LID mappings in batches', () => {
  it('uses one lookup and one insert for hundreds of pairs, not a query per pair', async () => {
    const { svc, calls } = make();
    const pairs = new Map<string, string>();
    for (let i = 0; i < 700; i++) pairs.set(`${i}@lid`, `91${i}@s.whatsapp.net`);
    expect(await svc.saveLidMappings('u1', 'a1', pairs)).toBe(700);
    expect(calls.findMany).toBe(1);
    expect(calls.createMany).toHaveLength(1);
    expect(calls.createMany[0]).toHaveLength(700);
    expect(calls.update).toHaveLength(0);
  });

  it('only updates pairs whose phone changed and inserts only the new ones', async () => {
    const { svc, calls } = make([
      { id: 'm1', lid: '1@lid', phoneJid: 'old@s.whatsapp.net' },
      { id: 'm2', lid: '2@lid', phoneJid: '2@s.whatsapp.net' },
    ]);
    await svc.saveLidMappings('u1', 'a1', new Map([['1@lid', 'new@s.whatsapp.net'], ['2@lid', '2@s.whatsapp.net'], ['3@lid', '3@s.whatsapp.net']]));
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0].where.id).toBe('m1');
    expect(calls.createMany[0].map((r: any) => r.lid)).toEqual(['3@lid']);
  });

  it('runLimited never runs more than the limit at once and finishes everything', async () => {
    const { svc } = make();
    let active = 0, peak = 0, done = 0;
    await svc.runLimited(Array.from({ length: 40 }), 10, async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; done++;
    });
    expect(done).toBe(40);
    expect(peak).toBeLessThanOrEqual(10);
  });
});

describe('database pool settings', () => {
  it('adds pool options once and keeps ones already present', () => {
    const base = 'mongodb://u:p@host:27017/vai4?ssl=true&replicaSet=rs';
    const out = PrismaService.buildUrl(base)!;
    expect(out).toContain('maxPoolSize=25');
    expect(out).toContain('connectTimeoutMS=15000');
    expect(out.startsWith(base + '&')).toBe(true);
    expect(PrismaService.buildUrl('mongodb://h/db?maxPoolSize=5&minPoolSize=1&connectTimeoutMS=1')).toBe('mongodb://h/db?maxPoolSize=5&minPoolSize=1&connectTimeoutMS=1');
    expect(PrismaService.buildUrl('mongodb://h/db')).toContain('/db?maxPoolSize=');
    expect(PrismaService.buildUrl(undefined)).toBeUndefined();
  });
});
