/**
 * Small in-memory cache with an expiry. The database is far from the server, so every lookup that can safely be
 * reused for a minute (who the user is, which account they own) is kept here instead of fetched on every request.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 500) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): V {
    if (this.store.size >= this.maxEntries) this.store.delete(this.store.keys().next().value as string);
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  delete(key: string) {
    this.store.delete(key);
  }

  /** Returns the cached value, or loads it. A missing result (null/undefined) is never cached. */
  async getOrLoad(key: string, load: () => Promise<V | null | undefined>): Promise<V | null> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const loaded = await load();
    return loaded == null ? null : this.set(key, loaded);
  }
}

/** Account ids per user, shared by every service. The row's id and owner never change. */
export const accountCache = new TtlCache<any>(60_000);
