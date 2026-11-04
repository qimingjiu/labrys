import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CacheConfig = {
  enabled: boolean; ttlSeconds: number; maxEntries: number; maxBytes: number;
  providerMode: 'automatic' | 'openai';
};
export const CACHE_DEFAULTS: CacheConfig = {
  enabled: true, ttlSeconds: 604800, maxEntries: 256, maxBytes: 16 * 1024 * 1024, providerMode: 'automatic',
};
export type Tier = 'prefix' | 'history' | 'memory' | 'handoff' | 'recall' | 'evidence';
export function canonical<T>(value: T): T {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return stable(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export type CacheLookup<T> = { hit: boolean; value: T | null };

// Derived data only. The event/memory store remains authoritative; cache faults fail open.
// Keys are server-created identities, never transport/client IDs or model-supplied scopes.
export class DurableCache {
  db: DatabaseSync; config: CacheConfig; clock: () => number; private lastAccess = 0;
  constructor(db: DatabaseSync, config: Partial<CacheConfig> = {}, clock = Date.now) {
    this.db = db; this.config = { ...CACHE_DEFAULTS, ...config }; this.clock = clock;
    db.exec(`CREATE TABLE IF NOT EXISTS gateway_cache(
      key TEXT PRIMARY KEY,tier TEXT NOT NULL,revision TEXT NOT NULL,value TEXT NOT NULL,
      bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL,accessed_at INTEGER NOT NULL,checksum TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS gateway_cache_lru ON gateway_cache(accessed_at);
      CREATE TABLE IF NOT EXISTS cache_counters(name TEXT PRIMARY KEY,value REAL NOT NULL);`);
    this.lastAccess = Number((db.prepare('SELECT COALESCE(MAX(accessed_at),0) AS n FROM gateway_cache').get() as any).n);
  }
  private tick(): number { this.lastAccess = Math.max(this.clock(), this.lastAccess + 1); return this.lastAccess; }
  batch<T>(fn: () => T): T {
    // Cache bookkeeping uses one short synchronous transaction; model calls stay outside it.
    try { this.db.exec('SAVEPOINT family_cache_batch'); } catch { return fn(); }
    let value: T;
    try { value = fn(); }
    catch (error) { try { this.db.exec('ROLLBACK TO family_cache_batch; RELEASE family_cache_batch'); } catch {} throw error; }
    try { this.db.exec('RELEASE family_cache_batch'); }
    catch { try { this.db.exec('ROLLBACK TO family_cache_batch; RELEASE family_cache_batch'); } catch {} this.count('errors'); }
    return value;
  }
  count(name: string, amount = 1): void {
    try { this.db.prepare('INSERT INTO cache_counters VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value').run(name, amount); } catch { /* cache metrics never interrupt chat */ }
  }
  get<T>(tier: Tier, identity: unknown, revision: string): CacheLookup<T> {
    if (!this.config.enabled) return { hit: false, value: null };
    const key = `${tier}:${digest(identity)}`;
    try {
      const row = this.db.prepare('SELECT * FROM gateway_cache WHERE key=?').get(key) as any;
      if (!row) { this.count(`${tier}.misses`); return { hit: false, value: null }; }
      if (row.revision !== revision || row.expires_at <= this.clock()) {
        this.db.prepare('DELETE FROM gateway_cache WHERE key=?').run(key);
        this.count(`${tier}.misses`); this.count(`${tier}.invalidations`); return { hit: false, value: null };
      }
      if (createHash('sha256').update(row.value).digest('hex') !== row.checksum) throw new Error('cache integrity check failed');
      const value = JSON.parse(row.value) as T;
      this.db.prepare('UPDATE gateway_cache SET accessed_at=?,expires_at=? WHERE key=?').run(this.tick(), this.clock() + this.config.ttlSeconds * 1000, key);
      this.count(`${tier}.hits`); return { hit: true, value };
    } catch {
      try { this.db.prepare('DELETE FROM gateway_cache WHERE key=?').run(key); } catch {}
      this.count('errors'); this.count(`${tier}.misses`); return { hit: false, value: null };
    }
  }
  put(tier: Tier, identity: unknown, revision: string, value: unknown): void {
    if (!this.config.enabled) return;
    try {
      const encoded = JSON.stringify(value); const bytes = Buffer.byteLength(encoded);
      if (bytes > this.config.maxBytes) { this.count('oversized'); return; }
      const now = this.clock();
      this.db.prepare('DELETE FROM gateway_cache WHERE expires_at<=?').run(now);
      this.db.prepare('INSERT OR REPLACE INTO gateway_cache VALUES(?,?,?,?,?,?,?,?)').run(`${tier}:${digest(identity)}`, tier, revision, encoded, bytes, now + this.config.ttlSeconds * 1000, this.tick(), createHash('sha256').update(encoded).digest('hex'));
      for (;;) {
        const size = this.db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM gateway_cache').get() as any;
        if (size.n <= this.config.maxEntries && size.bytes <= this.config.maxBytes) break;
        this.db.prepare('DELETE FROM gateway_cache WHERE key=(SELECT key FROM gateway_cache ORDER BY accessed_at,key LIMIT 1)').run(); this.count('evictions');
      }
      this.count(`${tier}.writes`);
    } catch { this.count('errors'); }
  }
  remember<T>(tier: Tier, identity: unknown, revision: string, build: () => T): { value: T; hit: boolean } {
    const cached = this.get<T>(tier, identity, revision);
    if (cached.hit) return { value: cached.value!, hit: true };
    const value = build(); this.put(tier, identity, revision, value); return { value, hit: false };
  }
  observeProvider(usage: Record<string, number>): void {
    this.batch(() => {
      this.count('provider.requests');
      if (typeof usage.cached_tokens === 'number') { this.count('provider.usage_reports'); this.count('provider.cached_tokens', usage.cached_tokens); }
      if (typeof usage.cache_write_tokens === 'number') this.count('provider.cache_write_tokens', usage.cache_write_tokens);
    });
  }
  stats(): any {
    try {
      const size = this.db.prepare('SELECT COUNT(*) AS entries,COALESCE(SUM(bytes),0) AS bytes FROM gateway_cache WHERE expires_at>?').get(this.clock());
      const counters = this.db.prepare('SELECT name,value FROM cache_counters').all() as any[];
      return { enabled: this.config.enabled, providerMode: this.config.providerMode, ttlSeconds: this.config.ttlSeconds,
        limits: { entries: this.config.maxEntries, bytes: this.config.maxBytes }, ...size,
        counters: Object.fromEntries(counters.map(r => [r.name, r.value])) };
    } catch { return { enabled: this.config.enabled, unavailable: true }; }
  }
}
