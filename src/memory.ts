import type { DatabaseSync } from 'node:sqlite';
import type { Actor, Config, Memory, Source } from './types.ts';
import { ensure, textOf } from './types.ts';
import type { FamilyStore } from './store.ts';
import type { DurableCache } from './cache.ts';
import { digest } from './cache.ts';

// Original implementation, informed by the papers listed in MEMORY.md. This is a
// rebuildable lexical index, never an authored memory or a replacement for raw text.
export const INDEX_VERSION = 'lexical-turns-v1';
type Row = Record<string, any>;
export type RecallOptions = { limit?: number; beforeSeq?: number; recordedAfter?: string; recordedBefore?: string; asOf?: string };
export type Episode = { hitIds: string[]; sources: Source[]; complete: boolean; readWith: { tool: 'family_source'; sourceIds: string[] } };
export type Recall = { memories: Memory[]; episodes: Episode[]; metrics: { elapsedMs: number; memoryHit: boolean; evidenceHit: boolean; indexReady: boolean; mode: 'lexical'; candidates: number } };
const normalized = (text: string) => text.normalize('NFKC').toLocaleLowerCase('und');
const STOP = new Set(['的','了','呢','吗','吧','啊','我','你','他','她','是','在','和','有','the','a','an','is','was','to','of','and','what','when','do','did','please']);
// Unicode words plus Han bigrams make Chinese text searchable without a native
// tokenizer dependency. Hex encoding keeps all FTS syntax under server control.
export function tokens(text: string, query = false): string[] {
  const out: string[] = [];
  for (const part of normalized(text).match(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu) ?? []) {
    if (/^\p{Script=Han}+$/u.test(part)) {
      const chars = [...part];
      if (chars.length === 1) { if (!STOP.has(part)) out.push(part); }
      else for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    } else if (!STOP.has(part)) out.push(part);
  }
  const unique = [...new Set(out)];
  // Queries are bounded independently of stored evidence. Long messages keep
  // both their beginning and end represented rather than generating unbounded ORs.
  return query && unique.length > 64 ? [...unique.slice(0, 32), ...unique.slice(-32)] : unique;
}
const encoded = (words: string[]) => words.map(w => 't' + Buffer.from(w).toString('hex')).join(' ');
const timestamp = (value: unknown, label: string): string | undefined => {
  if (value === undefined) return undefined;
  ensure(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)), 400, 'bad_time', `${label} 需要带时区的 ISO 时间`);
  return new Date(value).toISOString();
};
export function recallOptions(input: RecallOptions = {}): RecallOptions {
  const limit = input.limit ?? 8;
  ensure(Number.isInteger(limit) && limit >= 1 && limit <= 30, 400, 'bad_limit', '召回 limit 需要在 1–30 之间');
  ensure(input.beforeSeq === undefined || Number.isSafeInteger(input.beforeSeq) && input.beforeSeq >= 0, 400, 'bad_cursor', '无效检索边界');
  const recordedAfter = timestamp(input.recordedAfter, 'recordedAfter'), recordedBefore = timestamp(input.recordedBefore, 'recordedBefore'), asOf = timestamp(input.asOf, 'asOf');
  ensure(!recordedAfter || !recordedBefore || recordedAfter <= recordedBefore, 400, 'bad_time_range', '记录时间范围颠倒');
  return { limit, ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}), ...(recordedAfter ? { recordedAfter } : {}), ...(recordedBefore ? { recordedBefore } : {}), ...(asOf ? { asOf } : {}) };
}
export function validity(input: any): { validFrom: string | null; validUntil: string | null; context: string | null } {
  ensure(!input || typeof input === 'object' && !Array.isArray(input), 400, 'bad_validity', 'validity 需要对象');
  const validFrom = timestamp(input?.validFrom, 'validFrom') ?? null, validUntil = timestamp(input?.validUntil, 'validUntil') ?? null;
  ensure(!validFrom || !validUntil || validFrom < validUntil, 400, 'bad_time_range', '适用时间需要起点早于终点（终点不含）');
  ensure(input?.context === undefined || typeof input.context === 'string' && input.context.length <= 300, 400, 'bad_context', '情境说明最多 300 字符');
  return { validFrom, validUntil, context: input?.context ?? null };
}

export class MemorySearch {
  store: FamilyStore; db: DatabaseSync; config: Config;
  private handle?: ReturnType<typeof setImmediate>; private stopped = false; private error: string | null = null;
  constructor(store: FamilyStore) {
    this.store = store; this.db = store.db; this.config = store.config;
    this.db.exec(`CREATE TABLE IF NOT EXISTS recall_docs(
      rowid INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,room_id TEXT NOT NULL,
      audience TEXT NOT NULL,actor_id TEXT NOT NULL,source_seq INTEGER NOT NULL,recorded_at TEXT,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recall_scope ON recall_docs(kind,room_id,audience,source_seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(body,aliases);
      CREATE TABLE IF NOT EXISTS recall_state(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      INSERT OR IGNORE INTO recall_state VALUES('events',0),('memories',0),('ops',0),('generation',0),('event_generation',0);`);
    this.schedule();
  }
  close(): void { this.stopped = true; if (this.handle) clearImmediate(this.handle); }
  private schedule(): void {
    if (this.stopped || this.handle) return;
    this.handle = setImmediate(() => {
      this.handle = undefined;
      try { if (!this.backfill(48)) this.schedule(); } catch { this.error = 'index_unavailable'; }
    });
    this.handle.unref();
  }
  private state(name: string): number { return Number((this.db.prepare('SELECT value FROM recall_state WHERE name=?').get(name) as Row).value); }
  private aliases(body: string): string {
    const n = normalized(body), aliases: string[] = [];
    for (const a of this.config.agents) if ([a.id, a.name, ...a.aliases].some(x => n.includes(normalized(x)))) aliases.push(a.id, a.name, ...a.aliases);
    return aliases.join(' ');
  }
  private put(id: string, kind: string, roomId: string, audience: string, actorId: string, seq: number, recordedAt: string | null, body: string): void {
    const old = this.db.prepare('SELECT rowid,body FROM recall_docs WHERE id=?').get(id) as Row | undefined;
    if (old?.body === body && this.db.prepare('SELECT rowid FROM recall_fts WHERE rowid=?').get(old.rowid)) return;
    if (old) this.db.prepare('DELETE FROM recall_fts WHERE rowid=?').run(old.rowid);
    this.db.prepare(`INSERT INTO recall_docs(id,kind,room_id,audience,actor_id,source_seq,recorded_at,body) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(id, kind, roomId, audience, actorId, seq, recordedAt, body);
    const row = this.db.prepare('SELECT rowid FROM recall_docs WHERE id=?').get(id) as Row;
    this.db.prepare('INSERT INTO recall_fts(rowid,body,aliases) VALUES(?,?,?)').run(row.rowid, encoded(tokens(body)), encoded(tokens(this.aliases(body))));
    this.db.prepare("UPDATE recall_state SET value=value+1 WHERE name='generation'").run();
    if (kind==='event') this.db.prepare("UPDATE recall_state SET value=value+1 WHERE name='event_generation'").run();
  }
  event(id: string): void {
    this.indexWrite(()=>{
      this.indexEvent(id);
      const row = this.db.prepare('SELECT seq FROM events WHERE id=?').get(id) as Row;
      this.advance('events',row.seq);
    });
  }
  private indexWrite(fn:()=>void):void {
    try {this.db.exec('SAVEPOINT recall_index_write');try{fn();this.db.exec('RELEASE recall_index_write');}catch(error){this.db.exec('ROLLBACK TO recall_index_write; RELEASE recall_index_write');throw error;}}
    catch{this.error='index_unavailable';this.schedule();}
  }
  private advance(name: string, seq: number): void { this.db.prepare('UPDATE recall_state SET value=? WHERE name=? AND value=?').run(seq,name,seq-1); }
  private indexEvent(id: string): void {
    const e = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row;
    const data = JSON.parse(e.data);
    if (e.kind !== 'user.note' && (e.kind !== 'message' || !['user','assistant'].includes(data.message?.role))) return;
    const body = e.kind === 'user.note' ? String(data.text ?? '') : textOf(data.message.content);
    if (body.trim()) this.put(id, 'event', e.room_id, data.privateTo ?? '*', e.actor_id, e.seq, e.created_at, body);
  }
  memory(id: string): void {
    this.indexWrite(()=>{
      this.indexMemory(id);
      const row = this.db.prepare('SELECT seq FROM memories WHERE id=?').get(id) as Row; this.advance('memories',row.seq);
      for (const op of this.db.prepare('SELECT seq FROM memory_ops WHERE memory_id=? ORDER BY seq').all(id) as Row[]) this.advance('ops',op.seq);
    });
  }
  private indexMemory(id: string): void {
    const m = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row;
    const ops = this.db.prepare('SELECT text FROM memory_ops WHERE memory_id=? ORDER BY seq').all(id) as Row[];
    this.put(id, 'memory', m.room_id, m.visibility === 'shared' ? '*' : m.owner_id, m.author_id, m.seq, m.recorded_at, [m.text, ...ops.map(o => o.text)].join('\n'));
  }
  // Old databases migrate in small yielding batches. New writes are indexed
  // immediately with local tokens; no extraction/embedding/answer model is called.
  backfill(batch = 48): boolean {
    this.db.exec('SAVEPOINT recall_backfill');
    try {
      for (const [name, table] of [['events','events'],['memories','memories'],['ops','memory_ops']] as const) {
        const rows = this.db.prepare(`SELECT seq,${name === 'ops' ? 'memory_id' : 'id'} AS id FROM ${table} WHERE seq>? ORDER BY seq LIMIT ?`).all(this.state(name), batch) as Row[];
        for (const id of new Set(rows.map(r=>r.id))) { if (name === 'events') this.indexEvent(id); else this.indexMemory(id); }
        if (rows.length) this.db.prepare('UPDATE recall_state SET value=? WHERE name=?').run(rows.at(-1)!.seq, name);
      }
      this.db.exec('RELEASE recall_backfill'); this.error = null;
    } catch (error) { this.db.exec('ROLLBACK TO recall_backfill; RELEASE recall_backfill'); throw error; }
    return this.ready();
  }
  ready(): boolean {
    return [['events','events'],['memories','memories'],['ops','memory_ops']].every(([name, table]) => Number((this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS n FROM ${table}`).get() as Row).n) <= this.state(name));
  }
  status(): any {
    try { return { version: INDEX_VERSION, mode: 'lexical', ready: this.ready(), error: this.error, documents: Number((this.db.prepare('SELECT COUNT(*) AS n FROM recall_docs').get() as Row).n) }; }
    catch { return { version: INDEX_VERSION, mode: 'lexical', ready: false, error: 'index_unavailable' }; }
  }
  rebuild(): any {
    this.db.exec(`BEGIN IMMEDIATE; DELETE FROM recall_docs; DROP TABLE IF EXISTS recall_fts;
      CREATE VIRTUAL TABLE recall_fts USING fts5(body,aliases);
      UPDATE recall_state SET value=0 WHERE name!='generation';
      UPDATE recall_state SET value=value+1 WHERE name='generation'; COMMIT;`);
    this.error = null; this.schedule(); return this.status();
  }
  scope(actor: Actor, roomId: string): unknown {
    const room = this.store.room(actor, roomId);
    const privateRoom = actor.kind === 'agent' ? this.store.room(actor, `private-${actor.id}`) : null;
    return { household: this.store.householdId, actor, room: roomId, members: room.members, privateMembers: privateRoom?.members,
      acl:digest(this.db.prepare('SELECT id,members FROM rooms ORDER BY id').all()),version: INDEX_VERSION, aliases: digest(this.config.agents.map(a => [a.id,a.name,a.aliases])) };
  }
  private match(query: string): string {
    const base = tokens(query, true), n = normalized(query);
    for (const a of this.config.agents) if ([a.id, a.name, ...a.aliases].some(x => n.includes(normalized(x)))) base.push(...tokens([a.id,a.name,...a.aliases].join(' '), true));
    return [...new Set(base)].map(w => '"' + encoded([w]) + '"').join(' OR ');
  }
  private ranked(actor: Actor, roomId: string, query: string, kind: 'event' | 'memory', options: RecallOptions): string[] {
    const match = this.match(query);
    const includePrivate = actor.kind === 'agent' && roomId !== `private-${actor.id}`;
    const rooms = includePrivate ? kind==='memory' ? '(d.room_id=? OR (d.room_id=? AND d.audience=?))' : '(d.room_id=? OR d.room_id=?)' : '(d.room_id=?)';
    const params: any[] = includePrivate ? kind==='memory' ? [roomId,`private-${actor.id}`,actor.id] : [roomId,`private-${actor.id}`] : [roomId];
    const filters = [rooms, "(? != 'agent' OR d.audience='*' OR d.audience=?)", 'd.kind=?']; params.push(actor.kind, actor.id, kind);
    if (actor.kind==='agent' && kind==='memory') {
      // Provenance is part of the live ACL, not merely a hydration check after
      // Top-K. Otherwise revoked records could crowd out legitimate evidence.
      filters.push(`NOT EXISTS(SELECT 1 FROM (
        SELECT j.value AS id FROM memories m,json_each(m.sources) j WHERE m.id=d.id
        UNION ALL SELECT j.value FROM memory_ops o,json_each(o.sources) j WHERE o.memory_id=d.id
        ) refs LEFT JOIN events s ON s.id=refs.id LEFT JOIN rooms r ON r.id=s.room_id
        WHERE s.id IS NULL OR NOT EXISTS(SELECT 1 FROM json_each(r.members) WHERE value=?)
        OR (json_extract(s.data,'$.privateTo') IS NOT NULL AND json_extract(s.data,'$.privateTo')!=?))`);
      params.push(actor.id,actor.id);
    }
    if (options.beforeSeq !== undefined && kind === 'event') { filters.push('(d.room_id!=? OR d.source_seq<?)'); params.push(roomId,options.beforeSeq); }
    if (options.recordedAfter) { filters.push('d.recorded_at>=?'); params.push(options.recordedAfter); }
    if (options.recordedBefore) { filters.push('d.recorded_at<=?'); params.push(options.recordedBefore); }
    if (options.asOf && kind === 'memory') {
      filters.push("EXISTS(SELECT 1 FROM memories m WHERE m.id=d.id AND (m.valid_from IS NULL OR m.valid_from<=?) AND (m.valid_until IS NULL OR m.valid_until>?))"); params.push(options.asOf, options.asOf);
    }
    const where = filters.join(' AND '), limit = options.limit! * 4;
    if (!match) return (this.db.prepare(`SELECT d.id FROM recall_docs d WHERE ${where} AND instr(d.body,?)>0 ORDER BY d.source_seq DESC LIMIT ?`).all(...params,query,options.limit) as Row[]).map(r=>r.id);
    // ACL WHERE clauses precede LIMIT in both lanes. RRF is a tested baseline,
    // not a claim that the papers prove this combination optimal.
    const lexical = this.db.prepare(`SELECT d.id FROM recall_fts JOIN recall_docs d ON d.rowid=recall_fts.rowid WHERE recall_fts MATCH ? AND ${where} ORDER BY bm25(recall_fts,1.0,0.6),d.source_seq DESC LIMIT ?`).all(match, ...params, limit) as Row[];
    const phrase = this.db.prepare(`SELECT d.id FROM recall_fts JOIN recall_docs d ON d.rowid=recall_fts.rowid WHERE recall_fts MATCH ? AND ${where} AND instr(lower(d.body),?)>0 ORDER BY d.source_seq DESC LIMIT ?`).all(match, ...params, normalized(query), limit) as Row[];
    const scores = new Map<string, number>();
    for (const lane of [lexical, phrase]) lane.forEach((row, rank) => scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + rank + 1)));
    return [...scores].sort((a,b) => b[1]-a[1]).map(([id]) => id).slice(0, options.limit);
  }
  private fallback(actor: Actor, roomId: string, query: string, kind: 'event' | 'memory', options: RecallOptions): string[] {
    // Bounded recent-raw fallback while a legacy database is still indexing or
    // after an index fault. It is explicitly reported as incomplete coverage.
    const queryTokens = new Set(tokens(query, true));
    if (kind === 'memory') return this.store.recentMemories(actor, roomId, 30).filter(m => this.memoryTimeMatches(m,options) && tokens(m.text + '\n' + m.operations.map(o=>o.text).join('\n')).some(t=>queryTokens.has(t))).slice(0,options.limit).map(m=>m.id);
    const history = [...this.store.history(actor,roomId,300),...(actor.kind==='agent' && roomId!==`private-${actor.id}` ? this.store.history(actor,`private-${actor.id}`,100):[])];
    return history.filter(e => {
      const row = this.db.prepare('SELECT seq FROM events WHERE id=?').get(e.id) as Row;
      return (options.beforeSeq === undefined || e.roomId!==roomId || row.seq < options.beforeSeq) && (!options.recordedAfter || e.createdAt>=options.recordedAfter) && (!options.recordedBefore || e.createdAt<=options.recordedBefore) && (e.kind === 'message' && ['user','assistant'].includes((e.data as any).message?.role)) && (queryTokens.size ? tokens(textOf((e.data as any).message.content)).some(t=>queryTokens.has(t)) : textOf((e.data as any).message.content).includes(query));
    }).reverse().slice(0,options.limit).map(e=>e.id);
  }
  private memoryTimeMatches(m: Memory, options: RecallOptions): boolean {
    return (!options.recordedAfter || !!m.recordedAt && m.recordedAt>=options.recordedAfter) && (!options.recordedBefore || !!m.recordedAt && m.recordedAt<=options.recordedBefore)
      && (!options.asOf || (!m.validity.validFrom || m.validity.validFrom<=options.asOf) && (!m.validity.validUntil || m.validity.validUntil>options.asOf));
  }
  private select(actor: Actor, roomId: string, query: string, kind: 'event' | 'memory', options: RecallOptions): string[] {
    try {
      const ranked = this.ranked(actor, roomId, query, kind, options);
      if (this.ready() && !this.error) return ranked;
      return [...new Set([...ranked, ...this.fallback(actor,roomId,query,kind,options)])].slice(0,options.limit);
    } catch { this.error = 'index_unavailable'; return this.fallback(actor, roomId, query, kind, options); }
  }
  search(actor: Actor, roomId: string, query: string, input: RecallOptions = {}, cache?: DurableCache): Recall {
    // Tools and management calls also batch cache hit bookkeeping. Without this,
    // several disk commits can cost more than the lexical query they replace.
    const started=performance.now();
    const result=cache ? cache.batch(()=>this.searchInner(actor,roomId,query,input,cache)) : this.searchInner(actor,roomId,query,input);
    result.metrics.elapsedMs=performance.now()-started;return result;
  }
  private searchInner(actor: Actor, roomId: string, query: string, input: RecallOptions, cache?: DurableCache): Recall {
    const started = performance.now(); const scope = this.scope(actor, roomId);
    ensure(typeof query === 'string' && query.trim().length > 0 && query.length <= 8000, 400, 'bad_query', '检索问题需要 1–8000 字符');
    const options = recallOptions(input), identity = { scope, query: normalized(query.trim()), options };
    const {beforeSeq:_cursor,...memoryOptions} = options;
    const memoryIdentity = {scope,query:identity.query,options:memoryOptions};
    const revision = this.store.memoryRevision(actor, roomId) + (this.ready() && !this.error ? ':ready' : `:building:${this.state('generation')}`);
    const memories = cache ? cache.remember<string[]>('recall', memoryIdentity, revision, () => this.select(actor, roomId, query, 'memory', options)) : { value: this.select(actor, roomId, query, 'memory', options), hit: false };
    let generation: string;
    try { generation = `${this.state('event_generation')}:${this.ready()}:${this.error}`; } catch { generation = 'unavailable'; }
    const evidence = cache ? cache.remember<string[]>('evidence', identity, generation, () => this.select(actor, roomId, query, 'event', options)) : { value: this.select(actor, roomId, query, 'event', options), hit: false };
    // Reauthorize and hydrate from authoritative tables even on cache hits. No
    // generated prose or old ACL snapshot is a source of truth.
    const selected: Memory[] = [];
    for (const id of memories.value) try { selected.push(this.store.memory(actor,id)); } catch {}
    const episodes: Episode[] = [], seen = new Set<string>();
    for (const id of evidence.value) {
      try {
        const source = this.store.source(actor,id);
        const episode = this.episode(actor, source.roomId, id, source.roomId===roomId ? options.beforeSeq : undefined);
        const key = episode.sources[0]?.id ?? id;
        if (seen.has(key)) { episodes.find(e => (e.sources[0]?.id ?? '') === key)?.hitIds.push(id); continue; }
        seen.add(key); episodes.push(episode);
      } catch {}
    }
    // One-hop revision/qualification edges only. Every neighbour is rechecked,
    // stays inside the current authorized memory scope, and counts toward cap.
    const ids = new Set(selected.map(m=>m.id));
    for (const memory of [...selected]) for (const link of memory.relations) {
      if (selected.length >= options.limit!) break;
      const id = link.fromId === memory.id ? link.toId : link.fromId;
      if (ids.has(id)) continue;
      try { const m = this.store.memory(actor,id); if (!this.memoryTimeMatches(m,options) || m.roomId !== roomId && !(actor.kind === 'agent' && m.roomId === `private-${actor.id}` && m.visibility === 'private')) continue; ids.add(id); selected.push(m); } catch {}
    }
    return { memories: selected, episodes, metrics: { elapsedMs: performance.now()-started, memoryHit: memories.hit, evidenceHit: evidence.hit, indexReady: this.ready() && !this.error, mode: 'lexical', candidates: memories.value.length + evidence.value.length } };
  }
  episode(actor: Actor, roomId: string, sourceId: string, beforeSeq?: number, adjacentTurns = 0): Episode {
    ensure(Number.isInteger(adjacentTurns) && adjacentTurns>=0 && adjacentTurns<=2,400,'bad_span','相邻轮数需要 0–2');
    const source = this.store.source(actor, sourceId);
    ensure(source.roomId === roomId, 403, 'wrong_room', '来源不在当前房间');
    const hit = this.db.prepare('SELECT seq FROM events WHERE id=?').get(sourceId) as Row;
    ensure(beforeSeq === undefined || hit.seq < beforeSeq, 400, 'bad_cursor', '来源在检索边界之外');
    if (source.kind !== 'message') return { hitIds:[sourceId], sources:[source], complete:true, readWith:{tool:'family_source',sourceIds:[sourceId]} };
    const start = this.db.prepare(`SELECT COALESCE(MAX(seq),?) AS n FROM events WHERE room_id=? AND seq<=? AND kind='message' AND json_extract(data,'$.message.role')='user'`).get(hit.seq, roomId, hit.seq) as Row;
    const end = this.db.prepare(`SELECT MIN(seq) AS n FROM events WHERE room_id=? AND seq>? AND kind='message' AND json_extract(data,'$.message.role')='user'`).get(roomId,start.n) as Row;
    let lower = start.n;
    for(let i=0;i<adjacentTurns;i++) {
      const prev = this.db.prepare(`SELECT MAX(seq) AS n FROM events WHERE room_id=? AND seq<? AND kind='message' AND json_extract(data,'$.message.role')='user'`).get(roomId,lower) as Row;
      lower = prev.n ?? lower;
      if (end.n!==null) end.n = (this.db.prepare(`SELECT MIN(seq) AS n FROM events WHERE room_id=? AND seq>? AND kind='message' AND json_extract(data,'$.message.role')='user'`).get(roomId,end.n) as Row).n;
    }
    const upper = Math.min(end.n ?? Number.MAX_SAFE_INTEGER, beforeSeq ?? Number.MAX_SAFE_INTEGER);
    const rows = this.db.prepare(`SELECT id FROM events WHERE room_id=? AND seq>=? AND seq<? AND kind='message'
      AND (? != 'agent' OR json_extract(data,'$.privateTo') IS NULL OR json_extract(data,'$.privateTo')=?) ORDER BY seq LIMIT 129`).all(roomId,lower,upper,actor.kind,actor.id) as Row[];
    const complete = rows.length <= 128;
    const sources = rows.slice(0,128).map(r=>this.store.source(actor,r.id));
    if (!sources.some(s=>s.id===sourceId)) { if(sources.length===128)sources.pop();sources.push(source); }
    return { hitIds:[sourceId], sources, complete, readWith:{tool:'family_source',sourceIds:sources.map(s=>s.id)} };
  }
}
