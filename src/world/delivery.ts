import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import type { FamilyStore } from '../store.ts';
import { OWNER, ensure } from '../types.ts';
import type { Actor } from '../types.ts';
import type { Workspaces } from './artifacts.ts';
import type { Channels, Outgoing, MediaKind, InboxItem } from './types.ts';
import type { Adapter } from './adapters.ts';
import { resolveDestination } from './channels.ts';

export class Delivery {
  store: FamilyStore; workspaces: Workspaces; config: Channels; adapter: Adapter; clock: () => number; private running = new Map<string, Promise<void>>(); private closing = false; private abort = new AbortController(); private mediaKey: Buffer;
  constructor(store: FamilyStore, workspaces: Workspaces, config: Channels, adapter: Adapter, clock = Date.now, mediaKey = Buffer.from(randomUUID())) {
    this.store = store; this.workspaces = workspaces; this.config = config; this.adapter = adapter; this.clock = clock; this.mediaKey = mediaKey;
    store.db.exec(`CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,dedupe TEXT UNIQUE NOT NULL,data TEXT NOT NULL);`);
    store.db.exec("CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(json_extract(data,'$.status'),json_extract(data,'$.notBefore'))");
    for (const row of store.db.prepare('SELECT data FROM deliveries').all() as any[]) { const d: Outgoing = JSON.parse(row.data); if (d.status === 'sending') { d.status = 'unknown'; d.error = 'interrupted_after_dispatch'; this.save(d); } }
  }
  private save(value: Outgoing): void { this.store.db.prepare('INSERT OR REPLACE INTO deliveries VALUES(?,?,?)').run(value.id, value.key, JSON.stringify(value)); }
  get(id: string): Outgoing { const row = this.store.db.prepare('SELECT data FROM deliveries WHERE id=?').get(id) as any; ensure(row, 404, 'delivery_not_found', '没有这个发送任务'); return JSON.parse(row.data); }
  list(): Outgoing[] { return (this.store.db.prepare('SELECT data FROM deliveries ORDER BY rowid DESC LIMIT 100').all() as any[]).map(r => JSON.parse(r.data)); }
  addInbox(input: Omit<InboxItem, 'id' | 'createdAt'>): InboxItem {
    const hit = this.store.db.prepare('SELECT data FROM inbox WHERE dedupe=?').get(input.key) as any;
    if (hit) { const value: InboxItem = JSON.parse(hit.data); value.artifactIds = [...new Set([...value.artifactIds, ...input.artifactIds])]; this.store.db.prepare('UPDATE inbox SET data=? WHERE id=?').run(JSON.stringify(value), value.id); return value; }
    const value: InboxItem = { ...input, id: randomUUID(), createdAt: new Date(this.clock()).toISOString() }; this.store.db.prepare('INSERT INTO inbox VALUES(?,?,?)').run(value.id, value.key, JSON.stringify(value)); return value;
  }
  inbox(actor: Actor, roomId: string): InboxItem[] { this.store.room(actor, roomId); return (this.store.db.prepare('SELECT data FROM inbox ORDER BY rowid DESC LIMIT 200').all() as any[]).map(r => JSON.parse(r.data)).filter(i => i.roomId === roomId && (actor.kind === 'user' || i.agentId === actor.id)); }
  markRead(id: string): void { const row = this.store.db.prepare('SELECT data FROM inbox WHERE id=?').get(id) as any; ensure(row, 404, 'inbox_not_found', '收件项不存在'); const item: InboxItem = JSON.parse(row.data); item.readAt = new Date(this.clock()).toISOString(); this.store.db.prepare('UPDATE inbox SET data=? WHERE id=?').run(JSON.stringify(item), id); }
  enqueue(actor: Actor, roomId: string, input: { destination: string; kind: MediaKind; text?: string; artifactId?: string; key: string; notBefore?: number }): Outgoing {
    this.store.room(actor, roomId); ensure(actor.kind !== 'controller', 403, 'controller_read_only', '总控不能冒用成员发消息');
    const hit = this.store.db.prepare('SELECT data FROM deliveries WHERE dedupe=?').get(input.key) as any; if (hit) return JSON.parse(hit.data);
    const destination = resolveDestination(this.config, input.destination);
    ensure(['text', 'file', 'voice', 'image'].includes(input.kind), 400, 'bad_delivery_kind', '发送类型无效');
    ensure(input.text === undefined || typeof input.text === 'string' && input.text.length > 0 && input.text.length <= (input.kind === 'text' ? 2000 : 1000), 400, 'bad_delivery_text', '文字单条最多 2000 字符，文件说明最多 1000 字符');
    ensure(input.kind !== 'text' || input.text, 400, 'empty_delivery', '文字消息需要正文'); ensure(input.kind === 'text' || input.artifactId, 400, 'artifact_required', '媒体发送需要文件 ID');
    ensure(input.kind !== 'voice' || !input.text, 400, 'voice_caption_unsupported', '语音只发送音频；文字说明请另发一条');
    const artifact = input.artifactId ? this.workspaces.get(actor, input.artifactId, roomId) : undefined;
    if (input.kind === 'voice') ensure(artifact?.mime === 'audio/ogg' && artifact.voice, 400, 'voice_not_prepared', '语音需要先转换为原生语音格式');
    if (input.kind === 'image') ensure(artifact?.mime.startsWith('image/'), 400, 'image_required', '图片发送需要图片文件');
    const blocked = !destination.capabilities.includes(input.kind) || artifact && artifact.bytes > (destination.maxBytes ?? 8 * 1024 * 1024);
    const value: Outgoing = { id: randomUUID(), key: input.key, roomId, actor, destinationId: destination.id, kind: input.kind, ...(input.text ? { text: input.text } : {}), ...(input.artifactId ? { artifactId: input.artifactId } : {}), status: blocked ? 'blocked' : 'queued', ...(blocked ? { error: 'destination_capability_or_size' } : {}), attempts: 0, notBefore: input.notBefore ?? this.clock(), createdAt: new Date(this.clock()).toISOString() };
    this.save(value);
    if (!blocked && this.config.accounts.find(a => a.id === destination.accountId)?.platform === 'client') {
      value.status = 'available'; this.save(value); this.addInbox({ key: 'client-delivery:' + value.id, roomId, agentId: actor.kind === 'agent' ? actor.id : this.store.room(OWNER, roomId).activeAgentId, text: input.text ?? `文件已放入 ${destination.id} 收件箱，等待客户端领取。`, artifactIds: input.artifactId ? [input.artifactId] : [] });
    }
    if (blocked) this.addInbox({ key: 'blocked:' + value.id, roomId, agentId: actor.id === 'owner' ? this.store.room(OWNER, roomId).activeAgentId : actor.id, text: `无法向 ${destination.id} 发送 ${input.kind}：目的地能力或大小限制，未更换平台或降级类型。`, artifactIds: input.artifactId ? [input.artifactId] : [] });
    return value;
  }
  retry(id: string, confirmUnknown = false): Outgoing { const value = this.get(id); ensure(value.status === 'failed' || value.status === 'blocked' || value.status === 'unknown' && confirmUnknown, 409, 'delivery_not_retryable', '只有明确失败可重试；结果不明时需要用户核对后明确允许重发'); value.status = 'queued'; value.notBefore = this.clock(); value.error = undefined; this.save(value); return value; }
  async pump(): Promise<void> {
    if (this.closing) return;
    const rows = this.store.db.prepare("SELECT data FROM deliveries WHERE json_extract(data,'$.status')='queued' AND json_extract(data,'$.notBefore')<=? ORDER BY rowid LIMIT 100").all(this.clock()) as any[];
    const destinations = new Set(rows.map(r => (JSON.parse(r.data) as Outgoing).destinationId));
    for (const id of destinations) if (!this.running.has(id)) {
      const promise = this.sendQueue(id).finally(() => { this.running.delete(id); }); this.running.set(id, promise);
    }
    await Promise.allSettled([...this.running.values()]);
  }
  private async sendQueue(destinationId: string): Promise<void> {
    const queue = (this.store.db.prepare('SELECT data FROM deliveries ORDER BY rowid').all() as any[]).map(r => JSON.parse(r.data) as Outgoing).filter(d => d.destinationId === destinationId && d.status === 'queued');
    for (const value of queue) {
      if (this.closing || value.notBefore > this.clock()) break;
      let destination;
      try { destination = resolveDestination(this.config, value.destinationId); } catch { value.status = 'blocked'; value.error = 'destination_removed'; this.save(value); continue; }
      const account = this.config.accounts.find(a => a.id === destination.accountId)!;
      if (!destination.capabilities.includes(value.kind)) { value.status = 'blocked'; value.error = 'destination_capability_changed'; this.save(value); continue; }
      value.status = 'sending'; value.attempts++; this.save(value);
      let result;
      try { result = await this.adapter(account, destination, value, this.abort.signal); } catch { result = { status: 'unknown' as const, error: 'adapter_result_unknown' }; }
      value.status = result.status === 'rate_limited' ? value.attempts < 4 ? 'queued' : 'failed' : result.status;
      value.messageId = result.messageId; value.error = result.error;
      if (result.status === 'rate_limited') value.notBefore = this.clock() + (Number.isFinite(result.retryAfterMs) ? Math.max(1000, Math.min(result.retryAfterMs!, 300000)) : 5000);
      this.save(value); this.store.event(OWNER, value.roomId, 'delivery.updated', { deliveryId: value.id, destinationId, status: value.status, privateTo: value.actor.kind === 'agent' ? value.actor.id : undefined });
      if (value.status === 'unknown' || result.status === 'rate_limited') break;
    }
  }
  mediaToken(value: Outgoing, expires: number): string { return createHmac('sha256', this.mediaKey).update(JSON.stringify([value.id, value.artifactId, expires])).digest('hex'); }
  media(id: string, expires: number, token: string): Outgoing {
    const value = this.get(id); const expected = Buffer.from(this.mediaToken(value, expires)); const received = Buffer.from(token);
    ensure(value.artifactId && Number.isSafeInteger(expires) && expires > this.clock() && expires <= this.clock() + 3600000 && expected.length === received.length && timingSafeEqual(expected, received), 403, 'invalid_media_link', '媒体链接无效或已过期'); return value;
  }
  async close(): Promise<void> { this.closing = true; this.abort.abort(); await Promise.allSettled([...this.running.values()]); }
}
