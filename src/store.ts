import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor, Agent, Config, Memory, MemoryRelation, Message, Source } from './types.ts';
import { ensure, OWNER } from './types.ts';
import { MemorySearch, validity, tokens } from './memory.ts';

type Row = Record<string, any>;
export class FamilyStore {
  db: DatabaseSync; config: Config; householdId: string; search: MemorySearch;
  constructor(path: string, config: Config) {
    this.config = config;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, name TEXT NOT NULL, members TEXT NOT NULL, active_agent TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id),actor_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_room ON events(room_id,seq);
      CREATE TABLE IF NOT EXISTS memories(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,room_id TEXT NOT NULL REFERENCES rooms(id),author_id TEXT NOT NULL,owner_id TEXT,visibility TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_ops(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,memory_id TEXT NOT NULL REFERENCES memories(id),actor_id TEXT NOT NULL,op TEXT NOT NULL,text TEXT NOT NULL,sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY,response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_calls(room_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,client_id TEXT NOT NULL,calls TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_identity(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(room_id,visibility,owner_id,seq);
      CREATE INDEX IF NOT EXISTS memory_ops_target ON memory_ops(memory_id,seq);
      CREATE TABLE IF NOT EXISTS memory_epochs(room_id TEXT NOT NULL,audience TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(room_id,audience));
      CREATE TABLE IF NOT EXISTS memory_relations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
        from_id TEXT NOT NULL REFERENCES memories(id),to_id TEXT NOT NULL REFERENCES memories(id),type TEXT NOT NULL,
        actor_id TEXT NOT NULL,status TEXT NOT NULL,sources TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(from_id,seq);
      CREATE INDEX IF NOT EXISTS memory_relations_to ON memory_relations(to_id,seq);
    `);
    const columns = new Set((this.db.prepare('PRAGMA table_info(memories)').all() as Row[]).map(r=>r.name));
    for (const name of ['recorded_at','valid_from','valid_until','context']) if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} TEXT`);
    if (!(this.db.prepare('PRAGMA table_info(memory_ops)').all() as Row[]).some(r=>r.name==='recorded_at')) this.db.exec('ALTER TABLE memory_ops ADD COLUMN recorded_at TEXT');
    // Trigger epochs also cover writes from migration/admin SQL. Unknown legacy
    // timestamps stay null rather than inventing a recording date.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS memories_epoch AFTER INSERT ON memories BEGIN
      INSERT INTO memory_epochs VALUES(NEW.room_id,CASE WHEN NEW.visibility='shared' THEN '*' ELSE NEW.owner_id END,1)
      ON CONFLICT(room_id,audience) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS memory_ops_epoch AFTER INSERT ON memory_ops BEGIN
      INSERT INTO memory_epochs SELECT room_id,CASE WHEN visibility='shared' THEN '*' ELSE owner_id END,1 FROM memories WHERE id=NEW.memory_id
      ON CONFLICT(room_id,audience) DO UPDATE SET revision=revision+1; END;
      CREATE TRIGGER IF NOT EXISTS memory_relations_epoch AFTER INSERT ON memory_relations BEGIN
      INSERT INTO memory_epochs SELECT room_id,CASE WHEN visibility='shared' THEN '*' ELSE owner_id END,1 FROM memories WHERE id=NEW.from_id OR id=NEW.to_id
      ON CONFLICT(room_id,audience) DO UPDATE SET revision=revision+1; END;`);
    this.db.prepare('INSERT OR IGNORE INTO gateway_identity VALUES(?,?)').run('household', randomUUID());
    this.householdId = String((this.db.prepare('SELECT value FROM gateway_identity WHERE name=?').get('household') as Row).value);
    this.db.prepare('INSERT OR IGNORE INTO rooms VALUES(?,?,?,?)').run('family', '家庭客厅', JSON.stringify(config.agents.map(a => a.id)), config.defaultAgentId);
    for (const agent of config.agents) this.db.prepare('INSERT OR IGNORE INTO rooms VALUES(?,?,?,?)').run(`private-${agent.id}`, `${agent.name}的房间`, JSON.stringify([agent.id]), agent.id);
    this.search = new MemorySearch(this);
  }
  close(): void { this.search.close(); this.db.close(); }
  private write<T>(fn:()=>T):T {
    this.db.exec('SAVEPOINT family_store_write');
    try {const result=fn();this.db.exec('RELEASE family_store_write');return result;}
    catch(error){this.db.exec('ROLLBACK TO family_store_write; RELEASE family_store_write');throw error;}
  }
  agent(id: string): Agent {
    const agent = this.config.agents.find(a => a.id === id);
    ensure(agent, 404, 'unknown_agent', `未知成员 ${id}`); return agent;
  }
  room(actor: Actor, id: string): Row {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id=?').get(id) as Row | undefined;
    ensure(row, 404, 'unknown_room', '房间不存在');
    if (actor.kind === 'agent') { this.agent(actor.id); ensure(JSON.parse(row.members).includes(actor.id), 403, 'room_forbidden', '该成员没有进入这个房间的权限'); }
    else ensure(actor.id === (actor.kind === 'user' ? 'owner' : 'controller'), 403, 'invalid_identity', '身份无效');
    return { id: row.id, name: row.name, members: JSON.parse(row.members), activeAgentId: row.active_agent };
  }
  rooms(actor: Actor): Row[] {
    const rows = this.db.prepare('SELECT id FROM rooms').all() as Row[];
    return rows.flatMap(r => { try { return [this.room(actor, r.id)]; } catch { return []; } });
  }
  createRoom(actor: Actor, id: string, name: string, members: string[], active: string): Row {
    ensure(actor.kind === 'user' && actor.id === 'owner', 403, 'user_required', '房间配置由用户管理');
    ensure(/^[a-z][a-z0-9-]{0,47}$/.test(id), 400, 'bad_room_id', '房间 ID 格式错误');
    ensure(typeof name === 'string' && name.length > 0 && name.length <= 100, 400, 'bad_name', '房间名需要 1–100 字符');
    ensure(Array.isArray(members) && members.length > 0 && members.includes(active), 400, 'bad_members', '接话成员必须在房间成员内');
    members.forEach(m => this.agent(m));
    ensure(!this.db.prepare('SELECT id FROM rooms WHERE id=?').get(id), 409, 'room_exists', '房间已存在');
    this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?)').run(id, name, JSON.stringify([...new Set(members)]), active);
    return this.room(actor, id);
  }
  event(actor: Actor, roomId: string, kind: string, data: unknown): Source {
    this.room(actor, roomId);
    // Events are an attributed operational ledger. They are separate from authored memories.
    const source = { id: randomUUID(), kind, roomId, actorId: actor.id, data, createdAt: new Date().toISOString() };
    this.write(()=>{
      this.db.prepare('INSERT INTO events(id,kind,room_id,actor_id,data,created_at) VALUES(?,?,?,?,?,?)')
        .run(source.id, kind, roomId, actor.id, JSON.stringify(data), source.createdAt);
      this.search.event(source.id);
    });
    return source;
  }
  source(actor: Actor, id: string): Source {
    const row = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | undefined;
    ensure(row, 404, 'source_not_found', '来源记录不存在'); this.room(actor, row.room_id);
    const data = JSON.parse(row.data);
    ensure(actor.kind !== 'agent' || !data.privateTo || data.privateTo === actor.id, 403, 'source_forbidden', '不能读取其他成员的私密操作记录');
    return { id: row.id, kind: row.kind, roomId: row.room_id, actorId: row.actor_id, data, createdAt: row.created_at };
  }
  history(actor: Actor, roomId: string, limit = 100): Source[] {
    this.room(actor, roomId);
    ensure(Number.isFinite(limit), 400, 'bad_limit', 'limit 需要有效数字');
    const rows = this.db.prepare(`SELECT id FROM events WHERE room_id=? AND (? != 'agent' OR json_extract(data,'$.privateTo') IS NULL OR json_extract(data,'$.privateTo')=?) ORDER BY seq DESC LIMIT ?`)
      .all(roomId, actor.kind, actor.id, Math.max(1, Math.min(Math.floor(limit), 1000))) as Row[];
    return rows.reverse().map(r => this.source(actor, r.id));
  }
  historySince(actor: Actor, roomId: string, afterSeq: number, limit = 300): { seq: number; source: Source }[] {
    this.room(actor, roomId);
    const rows = this.db.prepare(`SELECT seq,id FROM events WHERE room_id=? AND seq>? AND (? != 'agent' OR json_extract(data,'$.privateTo') IS NULL OR json_extract(data,'$.privateTo')=?) ORDER BY seq DESC LIMIT ?`)
      .all(roomId, afterSeq, actor.kind, actor.id, limit) as Row[];
    return rows.reverse().map(r => ({ seq: Number(r.seq), source: this.source(actor, r.id) }));
  }
  memoryRevision(actor: Actor, roomId: string): string {
    this.room(actor, roomId);
    if (actor.kind === 'agent') this.room(actor, `private-${actor.id}`);
    return JSON.stringify(this.db.prepare(`SELECT room_id,audience,revision FROM memory_epochs
      WHERE (room_id=? OR (?='agent' AND room_id=? AND audience=?))
      AND (?!='agent' OR audience='*' OR audience=?) ORDER BY room_id,audience`).all(roomId,actor.kind,`private-${actor.id}`,actor.id,actor.kind,actor.id));
  }
  handoffRevision(actor: Actor, roomId: string): string {
    this.room(actor, roomId);
    const r = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE room_id=? AND kind='agent.switched' AND (json_extract(data,'$.from')=? OR json_extract(data,'$.to')=?)`).get(roomId, actor.id, actor.id) as Row;
    return String(r.seq);
  }
  handoffs(actor: Actor, roomId: string): Source[] {
    this.room(actor, roomId);
    const rows = this.db.prepare(`SELECT id FROM events WHERE room_id=? AND kind='agent.switched' AND (json_extract(data,'$.from')=? OR json_extract(data,'$.to')=?) ORDER BY seq DESC LIMIT 10`).all(roomId, actor.id, actor.id) as Row[];
    return rows.reverse().map(r => this.source(actor, r.id));
  }
  searchHistory(actor: Actor, roomId: string, query: string): Source[] {
    this.room(actor,roomId);
    ensure(typeof query==='string' && query.trim().length>0 && query.length<=8000,400,'bad_query','检索问题需要 1–8000 字符');
    // Keep literal punctuation searches useful, including visible tool records.
    if (!tokens(query,true).length) {
      const rows = this.db.prepare(`SELECT id FROM events WHERE room_id=? AND kind='message' AND (? != 'agent' OR json_extract(data,'$.privateTo') IS NULL OR json_extract(data,'$.privateTo')=?) AND instr(data,?)>0 ORDER BY seq DESC LIMIT 30`).all(roomId,actor.kind,actor.id,query) as Row[];
      return rows.reverse().map(r=>this.source(actor,r.id));
    }
    const episodes = this.search.search(actor,roomId,query,{limit:8}).episodes;
    return [...new Map(episodes.flatMap(e=>e.sources).map(s=>[s.id,s])).values()];
  }
  switchAgent(actor: Actor, roomId: string, target: string, reason: string, sourceId: string, clientId: string): Source | null {
    ensure(actor.kind === 'user' && actor.id === 'owner', 403, 'user_required', '只有用户可以决定切换接话成员');
    const room = this.room(actor, roomId); this.agent(target);
    ensure(room.members.includes(target), 403, 'agent_not_in_room', '该成员不在这个房间，需要用户先修改房间成员');
    ensure(this.source(actor, sourceId).roomId === roomId, 400, 'wrong_source_room', '切换来源不在当前房间');
    if (room.activeAgentId === target) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE rooms SET active_agent=? WHERE id=?').run(target, roomId);
      this.db.prepare('DELETE FROM pending_calls WHERE room_id=?').run(roomId);
      const e = this.event({ kind: 'controller', id: 'controller' }, roomId, 'agent.switched', {
        from: room.activeAgentId, to: target, reason, sourceId, clientId,
        // Raw pending work remains in the room's message ledger; no private-memory copying.
      });
      this.db.exec('COMMIT'); return e;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private memoryRow(actor: Actor, id: string): Row {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined;
    ensure(row, 404, 'memory_not_found', '记忆不存在'); this.room(actor, row.room_id);
    ensure(actor.kind !== 'agent' || row.visibility === 'shared' || row.owner_id === actor.id, 403, 'memory_forbidden', '不能读取其他成员的私密记忆');
    // Revoking access to a source also revokes its derived memory. Check live
    // provenance before candidate limiting and again on cached hydration.
    if (actor.kind==='agent') {
      const operations = this.db.prepare('SELECT sources FROM memory_ops WHERE memory_id=?').all(id) as Row[];
      for (const sourceId of [...JSON.parse(row.sources),...operations.flatMap(o=>JSON.parse(o.sources))]) this.source(actor,sourceId);
    }
    return row;
  }
  private requireWriter(actor: Actor): void {
    ensure(actor.kind !== 'controller', 403, 'controller_read_only', '总控可以审计记忆，不能写入记忆');
    if (actor.kind === 'agent') this.agent(actor.id);
    else ensure(actor.kind === 'user' && actor.id === 'owner', 403, 'invalid_identity', '身份无效');
  }
  private validateSources(actor: Actor, ids: string[], roomId: string, visibility: string): void {
    ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 20, 400, 'sources_required', '记忆必须关联 1–20 条原始来源');
    const target = this.room(actor, roomId);
    for (const id of ids) {
      const source = this.source(actor, id);
      const sourceRoom = this.room(actor, source.roomId);
      // Sharing must never silently widen visibility of a private conversation.
      if (visibility === 'shared') {
        const privateTo = (source.data as any)?.privateTo;
        ensure(target.members.every((m: string) => sourceRoom.members.includes(m) && (!privateTo || privateTo === m)), 403, 'private_source', '不能把私密来源直接写进更多成员可见的共享记忆');
      }
    }
  }
  append(actor: Actor, input: { roomId: string; visibility: 'private' | 'shared'; text: string; sources: string[]; kind?: 'fact' | 'observation'; ownerId?: string; validity?: { validFrom?: string; validUntil?: string; context?: string } }): Memory {
    this.requireWriter(actor); this.room(actor, input.roomId);
    ensure(input.visibility === 'private' || input.visibility === 'shared', 400, 'bad_visibility', 'visibility 需要 private 或 shared');
    ensure(typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 4000, 400, 'bad_text', '记忆正文需要 1–4000 字符');
    ensure(!input.kind || ['fact', 'observation'].includes(input.kind), 400, 'bad_kind', '记忆类型无效');
    const owner = input.visibility === 'private' ? (actor.kind === 'agent' ? actor.id : input.ownerId) : null;
    ensure(input.visibility !== 'private' || !!owner, 400, 'owner_required', '用户写入私密记忆需要指定 ownerId');
    if (owner) { this.agent(owner); ensure(this.room(OWNER, input.roomId).members.includes(owner), 400, 'owner_not_in_room', '私密记忆归属成员必须在房间内'); }
    ensure(actor.kind !== 'agent' || !input.ownerId || input.ownerId === actor.id, 403, 'owner_spoofing', '成员不能冒用他人的身份写记忆');
    this.validateSources(actor, input.sources, input.roomId, input.visibility);
    const time = validity(input.validity), recordedAt = new Date().toISOString();
    const id = randomUUID();
    this.write(()=>{
      this.db.prepare('INSERT INTO memories(id,room_id,author_id,owner_id,visibility,text,kind,sources,recorded_at,valid_from,valid_until,context) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.roomId, actor.id, owner ?? null, input.visibility, input.text, input.kind ?? 'observation', JSON.stringify(input.sources),recordedAt,time.validFrom,time.validUntil,time.context);
      if (actor.kind === 'user' && input.kind === 'fact') this.db.prepare('INSERT INTO memory_ops(id,memory_id,actor_id,op,text,sources,recorded_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, actor.id, 'confirm', '用户直接确认', '[]',recordedAt);
      this.search.memory(id);
    });
    return this.memory(actor, id);
  }
  memory(actor: Actor, id: string): Memory {
    const r = this.memoryRow(actor, id);
    const ops = (this.db.prepare('SELECT * FROM memory_ops WHERE memory_id=? ORDER BY seq').all(id) as Row[])
      .map(o => ({ id: o.id, actorId: o.actor_id, type: o.op, text: o.text, sources: JSON.parse(o.sources), recordedAt:o.recorded_at }));
    let status: Memory['status'] = 'candidate';
    for (const op of ops) { if (op.type === 'challenge') status = 'contested'; if (op.type === 'confirm') status = 'confirmed'; }
    const relations = (this.db.prepare('SELECT * FROM memory_relations WHERE from_id=? OR to_id=? ORDER BY seq DESC LIMIT 30').all(id,id) as Row[]).flatMap(link=>{
      try { this.memoryRow(actor,link.from_id); this.memoryRow(actor,link.to_id); for (const s of JSON.parse(link.sources)) this.source(actor,s); return [{ id:link.id,fromId:link.from_id,toId:link.to_id,type:link.type,actorId:link.actor_id,status:link.status,sources:JSON.parse(link.sources),recordedAt:link.recorded_at } as MemoryRelation]; } catch { return []; }
    });
    return { id: r.id, roomId: r.room_id, authorId: r.author_id, ownerId: r.owner_id, visibility: r.visibility, text: r.text, kind: r.kind, status, sources: JSON.parse(r.sources), operations: ops, recordedAt:r.recorded_at, validity:{validFrom:r.valid_from,validUntil:r.valid_until,context:r.context},relations };
  }
  recentMemories(actor: Actor, roomId: string, limit = 4): Memory[] {
    this.room(actor,roomId);
    if (actor.kind === 'agent') this.room(actor,`private-${actor.id}`);
    // Balanced lanes are only a small recency fallback, not relevance ranking.
    const shared = this.db.prepare(`SELECT id FROM memories WHERE room_id=? AND visibility='shared' ORDER BY seq DESC LIMIT ?`).all(roomId,limit) as Row[];
    const own = this.db.prepare(`SELECT id FROM memories WHERE (room_id=? OR room_id=?) AND visibility='private' AND (?!='agent' OR owner_id=?) ORDER BY seq DESC LIMIT ?`).all(roomId,`private-${actor.id}`,actor.kind,actor.id,limit) as Row[];
    return Array.from({length:limit},(_,i)=>[shared[i],own[i]]).flat().filter(Boolean).slice(0,limit).flatMap(r=>{try{return [this.memory(actor,r.id)];}catch{return [];}});
  }
  memories(actor: Actor, roomId: string, query = ''): Memory[] {
    this.room(actor, roomId);
    // Permission filtering happens in SQL BEFORE retrieval/limits.
    const rows = this.db.prepare(`SELECT id FROM memories WHERE room_id=? AND (? != 'agent' OR visibility='shared' OR owner_id=?) AND (text LIKE ? ESCAPE '\\') ORDER BY seq DESC LIMIT 100`)
      .all(roomId, actor.kind, actor.id, `%${query.replace(/[\\%_]/g, '\\$&')}%`) as Row[];
    return rows.map(r => this.memory(actor, r.id));
  }
  operate(actor: Actor, id: string, op: 'supplement' | 'challenge' | 'confirm', text: string, sources: string[]): Memory {
    this.requireWriter(actor); const row = this.memoryRow(actor, id);
    ensure(['supplement', 'challenge', 'confirm'].includes(op), 400, 'bad_operation', '操作无效');
    ensure(op !== 'confirm' || actor.kind === 'user', 403, 'user_confirmation_required', '共享事实的确认由用户决定');
    ensure(actor.kind !== 'agent' || row.visibility === 'shared' || row.owner_id === actor.id, 403, 'memory_forbidden', '不能改写其他成员的私密记忆');
    ensure(typeof text === 'string' && text.length > 0 && text.length <= 4000, 400, 'bad_text', '操作说明需要 1–4000 字符');
    this.validateSources(actor, sources, row.room_id, row.visibility);
    this.write(()=>{
      this.db.prepare('INSERT INTO memory_ops(id,memory_id,actor_id,op,text,sources,recorded_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, actor.id, op, text, JSON.stringify(sources),new Date().toISOString());
      this.search.memory(id);
    });
    return this.memory(actor, id);
  }
  relate(actor: Actor, fromId: string, toId: string, type: MemoryRelation['type'], sources: string[]): MemoryRelation {
    this.requireWriter(actor);
    ensure(['supersedes','corrects','qualifies','contradicts'].includes(type) && fromId !== toId,400,'bad_relation','关系类型无效或指向自身');
    const from = this.memoryRow(actor,fromId), to = this.memoryRow(actor,toId);
    this.validateSources(actor,sources,from.room_id,from.visibility);
    if (from.visibility === 'shared') {
      ensure(to.visibility === 'shared',403,'private_source','不能用共享关系暴露私人记忆');
      const target = this.room(actor,from.room_id), origin = this.room(actor,to.room_id);
      ensure(target.members.every((m:string)=>origin.members.includes(m)),403,'private_source','关系不能扩大目标记忆的可见范围');
    }
    // A source visible to the author may still be private to a single member.
    // Validate against both endpoints since links appear on both records.
    this.validateSources(actor,sources,to.room_id,to.visibility);
    if (type === 'supersedes' || type === 'corrects') {
      const cycle = this.db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT r.to_id FROM memory_relations r JOIN chain c ON r.from_id=c.id WHERE r.type IN ('supersedes','corrects')) SELECT id FROM chain WHERE id=? LIMIT 1`).get(toId,fromId);
      ensure(!cycle,400,'relation_cycle','修订关系不能形成循环');
    }
    const link: MemoryRelation = { id:randomUUID(),fromId,toId,type,actorId:actor.id,status:actor.kind==='user'?'confirmed':'candidate',sources,recordedAt:new Date().toISOString() };
    this.db.prepare('INSERT INTO memory_relations(id,from_id,to_id,type,actor_id,status,sources,recorded_at) VALUES(?,?,?,?,?,?,?,?)').run(link.id,fromId,toId,type,actor.id,link.status,JSON.stringify(sources),link.recordedAt);
    return link;
  }
  receipt(key: string): any { const r = this.db.prepare('SELECT response FROM receipts WHERE key=?').get(key) as Row | undefined; return r ? JSON.parse(r.response) : null; }
  saveReceipt(key: string, response: unknown): void { this.db.prepare('INSERT OR REPLACE INTO receipts VALUES(?,?)').run(key, JSON.stringify(response)); }
  pending(roomId: string): Row | null { const r = this.db.prepare('SELECT * FROM pending_calls WHERE room_id=?').get(roomId) as Row | undefined; return r ? { agentId: r.agent_id, clientId: r.client_id, calls: JSON.parse(r.calls) } : null; }
  setPending(roomId: string, agentId: string, clientId: string, calls: unknown): void { this.db.prepare('INSERT OR REPLACE INTO pending_calls VALUES(?,?,?,?)').run(roomId, agentId, clientId, JSON.stringify(calls)); }
  clearPending(roomId: string): void { this.db.prepare('DELETE FROM pending_calls WHERE room_id=?').run(roomId); }
}
