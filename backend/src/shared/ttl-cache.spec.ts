import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  it('loads once and reuses the value until it expires', async () => {
    const c = new TtlCache<number>(50);
    let loads = 0;
    const load = async () => (loads++, 7);
    expect(await c.getOrLoad('k', load)).toBe(7);
    expect(await c.getOrLoad('k', load)).toBe(7);
    expect(loads).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    await c.getOrLoad('k', load);
    expect(loads).toBe(2);
  });
  it('never caches a missing result', async () => {
    const c = new TtlCache<number>(1000);
    let loads = 0;
    expect(await c.getOrLoad('k', async () => (loads++, null))).toBeNull();
    expect(await c.getOrLoad('k', async () => (loads++, null))).toBeNull();
    expect(loads).toBe(2);
  });
  it('keeps users separate and stays bounded', async () => {
    const c = new TtlCache<string>(1000, 2);
    c.set('a', '1'); c.set('b', '2'); c.set('c', '3');
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBe('2');
    expect(c.get('c')).toBe('3');
  });
});
