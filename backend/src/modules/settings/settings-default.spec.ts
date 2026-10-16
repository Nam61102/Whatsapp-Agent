import { SettingsService } from './settings.service';

describe('data retention default', () => {
  it('a new user starts with 3 days', async () => {
    let created: any = null;
    const svc: any = Object.create(SettingsService.prototype);
    svc.resolveUserId = async (id: string) => id;
    svc.prisma = {
      userSettings: {
        findUnique: async () => null,
        create: async ({ data }: any) => ((created = data), data),
      },
    };
    const s = await svc.getSettings('64b000000000000000000001');
    expect(created.retentionDays).toBe(3);
    expect(s.retentionDays).toBe(3);
  });

  it('keeps what the user already chose', async () => {
    const svc: any = Object.create(SettingsService.prototype);
    svc.resolveUserId = async (id: string) => id;
    svc.prisma = { userSettings: { findUnique: async () => ({ retentionDays: 7 }), create: async () => { throw new Error('must not create'); } } };
    expect((await svc.getSettings('64b000000000000000000001')).retentionDays).toBe(7);
  });
});
