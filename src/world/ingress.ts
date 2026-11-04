import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FamilyGateway } from '../gateway.ts';
import type { FamilyWorld } from './world.ts';
import type { Account, Destination } from './types.ts';
import type { SecretResolver } from '../mcp/types.ts';
import { AppError, OWNER, ensure } from '../types.ts';
import { safeRequest } from '../mcp/http.ts';
import { MAX_ARTIFACT_BYTES } from './artifacts.ts';

type Incoming = { id: string; senderId: string; text: string; destination: Destination; files: { name: string; mime: string; url?: string; fileId?: string }[] };
export class Ingress {
  world: FamilyWorld; gateway: FamilyGateway; secrets: SecretResolver; allowHttpHosts: string[];
  private abort = new AbortController(); private jobs = new Set<Promise<void>>(); private messages = new Set<Promise<void>>(); private sockets = new Set<WebSocket>(); private status = new Map<string, string>(); private heartbeats = new Set<NodeJS.Timeout>();
  private reconnecting: Promise<void> = Promise.resolve();
  constructor(world: FamilyWorld, gateway: FamilyGateway, secrets: SecretResolver, allowHttpHosts: string[] = []) {
    this.world = world; this.gateway = gateway; this.secrets = secrets; this.allowHttpHosts = allowHttpHosts;
    world.store.db.exec('CREATE TABLE IF NOT EXISTS ingress_events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL)');
    world.store.db.prepare("UPDATE ingress_events SET status='interrupted' WHERE status IN ('queued','processing')").run();
  }
  states(): unknown { return Object.fromEntries(this.status); }
  private equal(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
  verify(account: Account, headers: Record<string, string | string[] | undefined>, raw: Buffer): void {
    ensure(account.inbound && account.webhookSecretRef, 403, 'webhook_disabled', '这个账号没有启用回调凭据'); const secret = this.secrets.value(account.webhookSecretRef);
    if (account.platform === 'telegram') ensure(this.equal(String(headers['x-telegram-bot-api-secret-token'] ?? ''), secret), 401, 'invalid_webhook_secret', '回调鉴权失败');
    else if (account.platform === 'onebot') ensure(this.equal(String(headers['x-signature'] ?? ''), 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex')), 401, 'invalid_webhook_secret', '回调签名失败');
    else ensure(this.equal(String(headers.authorization ?? ''), 'Bearer ' + secret), 401, 'invalid_webhook_secret', '回调鉴权失败');
  }
  private destination(account: Account, match: (d: Destination) => boolean): Destination | undefined { return this.world.config.destinations.find(d => d.accountId === account.id && match(d)); }
  private normalize(account: Account, event: any): Incoming | undefined {
    if (account.platform === 'telegram') {
      const m = event.message; if (!m || m.from?.is_bot || !account.ownerIds.includes(String(m.from?.id))) return;
      const destination = this.destination(account, d => d.target.chatId === String(m.chat?.id) && (!d.target.threadId || d.target.threadId === String(m.message_thread_id))); if (!destination) return;
      const files: Incoming['files'] = [];
      for (const [kind, a] of [['file', m.document], ['voice', m.voice], ['audio', m.audio], ['image', m.photo?.at(-1)]] as const) if (a?.file_id) files.push({ name: a.file_name ?? `${kind}-${m.message_id}.${kind === 'image' ? 'jpg' : kind === 'voice' ? 'ogg' : 'bin'}`, mime: a.mime_type ?? (kind === 'image' ? 'image/jpeg' : kind === 'voice' ? 'audio/ogg' : 'application/octet-stream'), fileId: a.file_id });
      return { id: String(event.update_id), senderId: String(m.from.id), text: m.text ?? m.caption ?? '请处理我上传的文件。', destination, files };
    }
    if (account.platform === 'discord') {
      const m = event; if (!m?.id || m.author?.bot || !account.ownerIds.includes(String(m.author?.id))) return;
      const destination = this.destination(account, d => d.target.channelId === String(m.channel_id)); if (!destination) return;
      return { id: m.id, senderId: m.author.id, text: m.content || '请处理我上传的文件。', destination, files: (m.attachments ?? []).slice(0, 8).map((a: any) => ({ name: a.filename, mime: a.content_type?.split(';')[0] ?? 'application/octet-stream', url: a.url })) };
    }
    if (account.platform === 'onebot') {
      if(event.post_type==='notice'&&['offline_file','group_upload'].includes(event.notice_type)&&account.ownerIds.includes(String(event.user_id))&&event.file?.url){
        const destination=this.destination(account,d=>event.group_id?d.target.groupId===String(event.group_id):d.target.userId===String(event.user_id)&&!d.target.groupId);if(!destination)return;
        return {id:'file:'+String(event.file.id??event.file.file_id??createHash('sha256').update(JSON.stringify([event.file.name,event.file.size,event.time])).digest('hex')),senderId:String(event.user_id),text:'请处理我上传的文件。',destination,files:[{name:String(event.file.name??'qq-file.bin'),mime:String(event.file.mime??'application/octet-stream'),url:String(event.file.url)}]};
      }
      if (event.post_type !== 'message' || !account.ownerIds.includes(String(event.user_id))) return;
      const destination = this.destination(account, d => event.message_type === 'group' ? d.target.groupId === String(event.group_id) : d.target.userId === String(event.user_id) && !d.target.groupId); if (!destination) return;
      const segments = Array.isArray(event.message) ? event.message : [];
      const text = segments.filter((s: any) => s.type === 'text').map((s: any) => s.data?.text ?? '').join('');
      const files: Incoming['files'] = segments.filter((s: any) => ['file', 'image', 'record'].includes(s.type) && s.data?.url).map((s: any) => ({ name: s.data.name ?? `${s.type}-${event.message_id}.${s.type === 'image' ? 'jpg' : s.type === 'record' ? 'ogg' : 'bin'}`, mime: s.type === 'image' ? 'image/jpeg' : s.type === 'record' ? 'audio/ogg' : 'application/octet-stream', url: s.data.url }));
      return { id: String(event.message_id), senderId: String(event.user_id), text: text || (files.length ? '请处理我上传的文件。' : typeof event.message === 'string' ? event.message : ''), destination, files };
    }
    // An authenticated owner-operated bridge may normalize OpenClaw events; raw public requests
    // cannot supply this envelope without the separate bridge credential and owner-ID match.
    if (!account.ownerIds.includes(String(event.senderId))) return;
    const destination = this.destination(account, d => d.id === event.destinationId); if (!destination) return;
    ensure(typeof event.id === 'string' && (typeof event.text === 'string'||Array.isArray(event.files)), 400, 'bad_ingress', '桥接事件需要 id 以及正文或文件');
    ensure(event.files===undefined||Array.isArray(event.files)&&event.files.length<=8&&event.files.every((f:any)=>f&&typeof f.name==='string'&&typeof f.url==='string'&&typeof f.mime==='string'&&/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(f.mime)),400,'bad_ingress','桥接文件需要 name、url 和 MIME');
    return { id: event.id, senderId: String(event.senderId), text: event.text||'请处理我上传的文件。', destination, files: (event.files??[]).map((f:any)=>({name:f.name,mime:f.mime,url:f.url})) };
  }
  accept(account: Account, event: unknown): { accepted: boolean; eventId?: string; duplicate?: boolean } {
    const incoming = this.normalize(account, event); if (!incoming || !incoming.text.trim()) return { accepted: false };
    ensure(incoming.id.length > 0 && incoming.id.length <= 150 && incoming.text.length <= 100000, 400, 'bad_ingress', '消息标识或正文过长');
    const key = createHash('sha256').update(JSON.stringify([account.id, incoming.destination.id, incoming.id])).digest('hex');
    const hit = this.world.store.db.prepare('SELECT status FROM ingress_events WHERE id=?').get(key); if (hit) return { accepted: true, eventId: key, duplicate: true };
    this.world.store.db.prepare('INSERT INTO ingress_events VALUES(?,?,?,?)').run(key, account.id, 'queued', JSON.stringify({ senderId: incoming.senderId, destinationId: incoming.destination.id }));
    const job = this.process(account, incoming, key).finally(() => { this.jobs.delete(job); this.messages.delete(job); }); this.jobs.add(job); this.messages.add(job); return { accepted: true, eventId: key };
  }
  private async process(account: Account, incoming: Incoming, key: string): Promise<void> {
    const store = this.world.store; store.db.prepare('UPDATE ingress_events SET status=? WHERE id=?').run('processing', key);
    const destination = incoming.destination; const actor = { kind: 'agent' as const, id: store.room(OWNER, destination.roomId).activeAgentId };
    try {
      const attachments: { artifactId: string }[] = [];
      for (const file of incoming.files.slice(0, 8)) {
        let url = file.url;
        if (file.fileId && account.platform === 'telegram') {
          const token = this.secrets.value(account.tokenRef!); const base = account.baseUrl ?? 'https://api.telegram.org';
          const resolved = await safeRequest(`${base}/bot${token}/getFile`, 'POST', { 'Content-Type': 'application/json' }, { file_id: file.fileId }, { allowPrivateHosts: this.allowHttpHosts }, this.abort.signal);
          const data = JSON.parse(resolved.text); ensure(data.ok && typeof data.result?.file_path === 'string' && !data.result.file_path.includes('..'), 502, 'platform_file_unavailable', '平台文件暂不可用'); url = `${base}/file/bot${token}/${data.result.file_path}`;
        }
        ensure(url, 400, 'missing_media_url', '附件缺少下载地址');
        const parsed = new URL(url);
        if (account.platform === 'discord') ensure(['cdn.discordapp.com', 'media.discordapp.net', 'cdn.discordapp.net'].includes(parsed.hostname) || this.allowHttpHosts.includes(parsed.hostname), 403, 'untrusted_media_host', 'Discord 附件必须来自平台 CDN');
        const response = await safeRequest(url, 'GET', {}, undefined, { allowPrivateHosts: this.allowHttpHosts, binary: true, maxBytes: MAX_ARTIFACT_BYTES }, this.abort.signal); ensure(response.status === 200 && response.bytes, 502, 'platform_file_unavailable', '附件下载失败');
        const name = file.name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 160); const artifact = await this.world.workspaces.create(actor, destination.roomId, { name, mime: file.mime, bytes: response.bytes }); attachments.push({ artifactId: artifact.id });
      }
      const result = await this.gateway.chat({ messages: [{ role: 'user', content: incoming.text }], attachments, sourceDestinationId: destination.id }, destination.roomId, account.id, undefined, this.abort.signal, key);
      const text = result.choices[0].message.content as string;
      for (let i = 0; i < text.length; i += 1900) this.world.delivery.enqueue({ kind: 'agent', id: result.family.agentId }, destination.roomId, { destination: destination.id, kind: 'text', text: text.slice(i, i + 1900), key: `reply:${key}:${i}` });
      store.db.prepare('UPDATE ingress_events SET status=? WHERE id=?').run('completed', key); void this.world.delivery.pump();
    } catch (e) {
      const error = e instanceof AppError ? e.code : 'incoming_message_failed'; store.db.prepare('UPDATE ingress_events SET status=?,data=? WHERE id=?').run('failed', JSON.stringify({ destinationId: destination.id, error }), key);
      this.world.delivery.addInbox({ key: `ingress:${key}:failed`, roomId: destination.roomId, agentId: actor.id, text: `来自 ${destination.id} 的消息处理未完成：${error}。`, artifactIds: [] });
    }
  }
  start(): void {
    for (const account of this.world.config.accounts.filter(a => a.inbound)) {
      if (account.platform === 'telegram' && !account.webhookSecretRef) { const poll = this.pollTelegram(account); this.jobs.add(poll); void poll.finally(() => this.jobs.delete(poll)); }
      else if (account.platform === 'discord') { const connection = this.discord(account); this.jobs.add(connection); void connection.finally(() => this.jobs.delete(connection)); }
      else this.status.set(account.id, 'waiting_for_authenticated_webhook');
    }
  }
  private async delay(ms: number): Promise<void> { if (this.abort.signal.aborted) return; await new Promise<void>(r => { const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); r(); }; const timer = setTimeout(done, ms); this.abort.signal.addEventListener('abort', done, { once: true }); }); }
  private async pollTelegram(account: Account): Promise<void> {
    const store = this.world.store; const key = 'tg_offset:' + account.id; let backoff = 1000;
    while (!this.abort.signal.aborted) {
      try {
        const token = this.secrets.value(account.tokenRef!); const offset = Number((store.db.prepare('SELECT value FROM world_meta WHERE key=?').get(key) as any)?.value ?? 0);
        const response = await safeRequest(`${account.baseUrl ?? 'https://api.telegram.org'}/bot${token}/getUpdates`, 'POST', { 'Content-Type': 'application/json' }, { offset, limit: 20, timeout: 20, allowed_updates: ['message'] }, { allowPrivateHosts: this.allowHttpHosts, timeoutMs: 30000 }, this.abort.signal);
        const result = JSON.parse(response.text); ensure(response.status === 200 && result.ok && Array.isArray(result.result), 502, 'telegram_poll_failed', 'TG 轮询失败'); this.status.set(account.id, 'connected'); backoff = 1000;
        for (const event of result.result) { this.accept(account, event); store.db.prepare('INSERT OR REPLACE INTO world_meta VALUES(?,?)').run(key, String(Number(event.update_id) + 1)); }
        if (!result.result.length) await this.delay(200);
      } catch { if (this.abort.signal.aborted) return; this.status.set(account.id, 'reconnecting'); await this.delay(backoff); backoff = Math.min(30000, backoff * 2); }
    }
  }
  private async discord(account: Account): Promise<void> {
    const key = 'dc_session:' + account.id; const store = this.world.store; let session = JSON.parse((store.db.prepare('SELECT value FROM world_meta WHERE key=?').get(key) as any)?.value ?? '{}');
    while (!this.abort.signal.aborted) {
      try {
        const token = this.secrets.value(account.tokenRef!);
        const response = await safeRequest(`${account.baseUrl ?? 'https://discord.com/api/v10'}/gateway/bot`, 'GET', { Authorization: `Bot ${token}` }, undefined, { allowPrivateHosts: this.allowHttpHosts }, this.abort.signal);
        const data = JSON.parse(response.text); ensure(response.status === 200 && data.url, 502, 'discord_gateway_failed', 'Discord 网关发现失败');
        const url = new URL(session.resume_gateway_url ?? data.url); ensure(url.protocol === 'wss:' || url.protocol === 'ws:' && this.allowHttpHosts.includes(url.hostname), 403, 'discord_gateway_url', 'Discord WebSocket 地址无效'); url.searchParams.set('v', '10'); url.searchParams.set('encoding', 'json');
        await new Promise<void>(done => {
          const socket = new WebSocket(url); this.sockets.add(socket); let heartbeat: NodeJS.Timeout | undefined; let ack = true;
          const beat = () => { if (!ack) { socket.close(); return; } ack = false; if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: session.seq ?? null })); };
          const cancel = () => socket.close(); this.abort.signal.addEventListener('abort', cancel, { once: true });
          const cleanup = () => { if (heartbeat) { clearInterval(heartbeat); this.heartbeats.delete(heartbeat); } this.sockets.delete(socket); this.abort.signal.removeEventListener('abort', cancel); done(); };
          socket.addEventListener('close', cleanup, { once: true }); socket.addEventListener('error', () => { socket.close(); cleanup(); }, { once: true });
          socket.addEventListener('message', message => {
            try {
              const event = JSON.parse(String(message.data)); if (event.s !== null && event.s !== undefined) session.seq = event.s;
              if (event.op === 10) {
                heartbeat = setInterval(beat, Math.max(1000, Number(event.d.heartbeat_interval))); heartbeat.unref(); this.heartbeats.add(heartbeat);
                socket.send(JSON.stringify(session.session_id ? { op: 6, d: { token, session_id: session.session_id, seq: session.seq } } : { op: 2, d: { token, intents: 37377, properties: { os: process.platform, browser: 'family-gateway', device: 'family-gateway' } } }));
              }
              if (event.op === 11) ack = true; if (event.op === 1) beat(); if (event.op === 7) socket.close(); if (event.op === 9) { session = {}; socket.close(); }
              if (event.t === 'READY') { session.session_id = event.d.session_id; session.resume_gateway_url = event.d.resume_gateway_url; this.status.set(account.id, 'connected'); }
              if (event.t === 'MESSAGE_CREATE') this.accept(account, event.d);
              store.db.prepare('INSERT OR REPLACE INTO world_meta VALUES(?,?)').run(key, JSON.stringify(session));
            } catch { this.status.set(account.id, 'event_rejected'); }
          });
        });
      } catch { this.status.set(account.id, 'reconnecting'); }
      if (!this.abort.signal.aborted) await this.delay(2000);
    }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.messages]); }
  restart(): Promise<void> { this.reconnecting = this.reconnecting.then(async () => { await this.close(); this.abort = new AbortController(); this.status.clear(); this.start(); }); return this.reconnecting; }
  async close(): Promise<void> { this.abort.abort(); for (const heartbeat of this.heartbeats) clearInterval(heartbeat); for (const socket of this.sockets) socket.close(); await Promise.allSettled([...this.jobs]); }
}
