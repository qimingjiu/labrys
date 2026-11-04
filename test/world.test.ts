import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHmac, createHash } from 'node:crypto';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import { FamilyWorld } from '../src/world/world.ts';
import { Ingress } from '../src/world/ingress.ts';
import { SecretVault } from '../src/mcp/vault.ts';
import { createFamilyServer } from '../src/server.ts';
import { validateChannels, mentionedDestinations } from '../src/world/channels.ts';
import { OWNER, CONTROLLER } from '../src/types.ts';
import type { Actor, Config, ToolCall } from '../src/types.ts';
import type { Generate } from '../src/provider.ts';
import type { Adapter } from '../src/world/adapters.ts';
import type { Channels, Task, Outgoing } from '../src/world/types.ts';

const config: Config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const K: Actor = { kind: 'agent', id: 'korax' }, W: Actor = { kind: 'agent', id: 'kirishima' };
const complete = (content = '完成了', toolCalls: ToolCall[] = []) => ({ content, toolCalls, usage: {}, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const call = (name: string, args: unknown, id = 'call-' + name): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const channels = (): Channels => ({ accounts: [
  { id: 'qq', platform: 'onebot', baseUrl: 'http://127.0.0.1:9', ownerIds: ['10001'], tokenRef: 'qq-token', webhookSecretRef: 'qq-hook', inbound: false, providerFileRoot: '/shared/outgoing' },
  { id: 'dc', platform: 'discord', ownerIds: ['20001'], tokenRef: 'dc-token' },
  { id: 'tg', platform: 'telegram', ownerIds: ['30001'], tokenRef: 'tg-token' },
  { id: 'wx', platform: 'openclaw', ownerIds: ['wx-owner'], baseUrl: 'http://127.0.0.1:9', tokenRef: 'wx-token', webhookSecretRef: 'wx-hook' },
  { id: 'chat', platform: 'client', ownerIds: [] },
], destinations: [
  { id: 'qq-home', aliases: ['QQ'], accountId: 'qq', roomId: 'family', target: { userId: '10001' }, capabilities: ['text', 'file', 'voice', 'image'] },
  { id: 'dc-home', aliases: ['dc', 'Discord'], accountId: 'dc', roomId: 'family', target: { channelId: '20002' }, capabilities: ['text', 'file', 'voice', 'image'] },
  { id: 'tg-home', aliases: ['tg', 'Telegram'], accountId: 'tg', roomId: 'family', target: { chatId: '30001' }, capabilities: ['text', 'file', 'voice', 'image'] },
  { id: 'wx-home', aliases: ['微信'], accountId: 'wx', roomId: 'family', target: { userId: 'wx-owner' }, capabilities: ['text', 'file', 'voice', 'image'] },
  { id: 'plain-client', aliases: ['纯聊天客户端'], accountId: 'chat', roomId: 'family', target: {}, capabilities: ['text'] },
] });
function fixture(t: any, options: { generate?: Generate; adapter?: Adapter; channels?: Channels; clock?: () => number; file?: boolean; native?: boolean; speechUrl?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'family-world-')); const store = new FamilyStore(options.file ? join(dir, 'db.sqlite') : ':memory:', structuredClone(config)); const vault = new SecretVault(store.db, join(dir, 'vault'));
  for (const [name, value] of Object.entries({ 'qq-token': 'qq-secret', 'qq-hook': 'qq-hook-secret', 'dc-token': 'dc-secret', 'tg-token': 'tg-secret', 'wx-token': 'wx-secret', 'wx-hook': 'wx-hook-secret' })) vault.put(name, value);
  const sent: Outgoing[] = []; const adapter: Adapter = options.adapter ?? (async (_a, _d, value) => { sent.push(structuredClone(value)); return { status: 'sent', messageId: 'receipt-' + sent.length }; });
  const generate = options.generate ?? (async () => complete());
  const world = new FamilyWorld(store, join(dir, 'world'), generate, { secrets: vault, channels: options.channels ?? channels(), clock: options.clock, ...(options.native ? {} : { adapter }), allowHttpHosts: ['127.0.0.1'], publicBaseUrl: 'http://127.0.0.1:8787', ...(options.speechUrl ? { speech: { url: options.speechUrl, key: 'speech-secret', model: 'fixture-tts', voices: { korax: 'crow', kirishima: 'mist' }, allowHttpHosts: ['127.0.0.1'] } } : {}) });
  const gateway = new FamilyGateway(store, config, generate); gateway.world = world;
  t.after(async () => { await world.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const authority = (text: string, sourceDestinationId?: string) => { const source = store.event(OWNER, 'family', 'message', { message: { role: 'user', content: text }, ...(sourceDestinationId ? { destinationId: sourceDestinationId } : {}) }); return world.authority(K, 'family', source.id); };
  return { dir, store, world, gateway, sent, vault, authority };
}
function wav(): Buffer {
  const count = 4000, buffer = Buffer.alloc(44 + count * 2); buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(count * 2, 40); for (let i = 0; i < count; i++) buffer.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), 44 + i * 2); return buffer;
}
async function fakePlatform(t: any) {
  const calls: { path: string; headers: any; json?: any; form?: FormData; bytes: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const bytes = Buffer.concat(chunks), type = req.headers['content-type'] ?? ''; let json: any, form: FormData | undefined;
    if (type.includes('multipart/form-data')) form = await new Request('http://localhost/', { method: 'POST', headers: { 'Content-Type': type }, body: bytes }).formData(); else if (bytes.length) { try { json = JSON.parse(bytes.toString()); } catch {} }
    calls.push({ path: req.url!, headers: req.headers, json, form, bytes });
    if (req.url === '/speech') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav()); return; }
    if (req.url === '/rate') { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"retry_after":1}'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url!.includes('/channels/')) res.end(JSON.stringify({ id: 'dc-message-' + calls.length }));
    else if (req.url!.includes('/bot')) res.end(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
    else if (req.url === '/unconfirmed/tools/invoke') res.end(JSON.stringify({ ok: true, result: {} }));
    else if (req.url === '/tools/invoke') res.end(JSON.stringify({ ok: true, result: { details: { messageId: 'wx-message', deliveryStatus: 'sent' } } }));
    else res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: calls.length } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = 'http://127.0.0.1:' + (server.address() as any).port; return { base, calls };
}
async function httpGateway(t: any, f: ReturnType<typeof fixture>, ingress?: Ingress) {
  const server = createFamilyServer(f.store, f.gateway, 'test-token-long-enough', ingress); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { base: 'http://127.0.0.1:' + (server.address() as any).port, headers: { Authorization: 'Bearer test-token-long-enough', 'Content-Type': 'application/json' } };
}

test('成员工作区隔离、版本与署名保留；分享才开放，拒绝路径与控制器写入', async t => {
  const { world, authority } = fixture(t); const a = await world.workspaces.create(K, 'family', { name: 'drafts/hello.md', mime: 'text/markdown', bytes: Buffer.from('第一版') });
  const b = await world.workspaces.create(K, 'family', { name: 'drafts/hello.md', mime: 'text/markdown', bytes: Buffer.from('第二版') });
  assert.notEqual(a.id, b.id); assert.equal(world.workspaces.list(K, 'family')[0].id, b.id); assert.equal((await world.workspaces.bytes(K, a.id, 'family')).toString(), '第一版');
  assert.throws(() => world.workspaces.get(W, a.id, 'family'), /私人文件/); assert.equal(world.workspaces.list(W, 'family', 'korax').length, 0);
  world.workspaces.share(K, a.id, 'family', { agentId: 'kirishima' }); assert.equal(world.workspaces.get(W, a.id, 'family').ownerId, 'korax');
  await assert.rejects(world.workspaces.create(CONTROLLER, 'family', { name: 'bad.md', mime: 'text/plain', bytes: Buffer.from('x') }), /总控/);
  for (const name of ['../escape', '/etc/passwd', 'a/../../escape', '.env', 'a\\b']) await assert.rejects(world.workspaces.create(K, 'family', { name, mime: 'text/plain', bytes: Buffer.from('x') }), /相对名称/);
  await assert.rejects(world.execute('workspace_publish', { artifactId: b.id, room: true }, K, authority('把这个草稿给雾岛纪看')), /整个房间/);
  const source = world.store.event(OWNER, 'private-korax', 'message', { message: { role: 'user', content: '把草稿拿到客厅分享' } }); await world.execute('workspace_publish', { artifactId: b.id, room: true, targetRoom: 'family' }, K, world.authority(K, 'private-korax', source.id)); assert.equal(world.workspaces.get(W, b.id, 'family').ownerId, 'korax');
});
test('工作区符号链接不能越界', async t => {
  const { world, dir } = fixture(t); const outside = join(dir, 'outside'); mkdirSync(outside); symlinkSync(outside, join(world.workspaces.root, 'korax'));
  await assert.rejects(world.workspaces.create(K, 'family', { name: 'x.md', mime: 'text/plain', bytes: Buffer.from('x') }), /路径越界/);
});
test('自然语言目的地只解析绑定别名，配置拒绝别名冲突和明文凭据', t => {
  const { store } = fixture(t); assert.deepEqual(mentionedDestinations(channels(), '文件发到dc，语音发到tg'), ['dc-home', 'tg-home']);
  assert.deepEqual(mentionedDestinations(channels(), '发到dc-other'), []); assert.deepEqual(mentionedDestinations(channels(), '发到 DC'), ['dc-home']);
  const duplicate = channels(); duplicate.destinations[2].aliases.push('dc'); assert.throws(() => validateChannels(duplicate, store), /别名重复/);
  const secret = channels(); (secret.accounts[0] as any).token = 'plaintext'; assert.throws(() => validateChannels(secret, store), /明文/);
});
test('直接交付按用户指定目的地；拒绝模型改目的地、改类型和冒充用户授权', async t => {
  const { world, authority, sent } = fixture(t); const a = await world.workspaces.create(K, 'family', { name: 'report.md', mime: 'text/markdown', bytes: Buffer.from('报告') }); const auth = authority('把文件发到dc');
  await assert.rejects(world.execute('delivery_send', { destination: 'tg', kind: 'file', artifactId: a.id }, K, auth), /用户本轮/);
  await assert.rejects(world.execute('delivery_send', { destination: 'dc', kind: 'text', text: '替代内容' }, K, auth), /媒体类型/);
  await assert.rejects(world.execute('delivery_send', { destination: 'dc', kind: 'file', artifactId: a.id, userText: '发到dc' }, K, auth), /服务端绑定/);
  await world.execute('delivery_send', { destination: 'dc', kind: 'file', artifactId: a.id }, K, auth); await world.delivery.pump(); assert.equal(sent.length, 1); assert.equal(sent[0].destinationId, 'dc-home');
  await world.execute('delivery_send', { destination: 'dc', kind: 'file', artifactId: a.id }, K, auth); await world.delivery.pump(); assert.equal(sent.length, 1);
  const source = world.store.event(OWNER, 'private-korax', 'message', { message: { role: 'user', content: '把这份文件发到dc' } });
  await world.execute('delivery_send', { destination: 'dc', kind: 'file', artifactId: a.id }, K, world.authority(K, 'private-korax', source.id)); await world.delivery.pump(); assert.equal(sent[1].roomId, 'private-korax'); assert.equal(sent[1].destinationId, 'dc-home');
});
test('同一条指令可以把文件发 DC、语音发 TG；否定的目的地不授予发送权限', async t => {
  const { world, authority, sent } = fixture(t); const file = await world.workspaces.create(K, 'family', { name: 'file.md', mime: 'text/markdown', bytes: Buffer.from('文件') }); const audio = await world.workspaces.create(K, 'family', { name: 'voice.wav', mime: 'audio/wav', bytes: wav() });
  const auth = authority('分别把文件发到dc，语音发到tg，不要发到QQ');
  await world.execute('delivery_send', { destination: 'dc', kind: 'file', artifactId: file.id }, K, auth);
  await world.execute('delivery_send', { destination: 'tg', kind: 'voice', artifactId: audio.id }, K, auth);
  await assert.rejects(world.execute('delivery_send', { destination: 'QQ', kind: 'file', artifactId: file.id }, K, auth), /用户本轮/);
  await world.delivery.pump(); assert.deepEqual(sent.map(d => [d.destinationId, d.kind]).sort(), [['dc-home', 'file'], ['tg-home', 'voice']]);
});
test('能力不足不会静默换平台或把语音降级文件，成果留在跨端收件箱', async t => {
  const { world, sent } = fixture(t); const a = await world.workspaces.create(K, 'family', { name: 'x.md', mime: 'text/markdown', bytes: Buffer.from('可下载') });
  const d = world.delivery.enqueue(K, 'family', { destination: 'plain-client', kind: 'file', artifactId: a.id, key: 'client-file' }); await world.delivery.pump(); assert.equal(d.status, 'blocked'); assert.equal(sent.length, 0); assert.equal(world.delivery.inbox(OWNER, 'family')[0].artifactIds[0], a.id);
  const text = world.delivery.enqueue(K, 'family', { destination: 'plain-client', kind: 'text', text: '文字可在收件箱领取', key: 'client-text' }); await world.delivery.pump(); assert.equal(text.status, 'available'); assert.equal(sent.length, 0); assert.ok(world.delivery.inbox(OWNER, 'family').some(i => i.text === '文字可在收件箱领取'));
});
test('投递结果不明不自动重发；明确核对后才能重试', async t => {
  let calls = 0; const { world } = fixture(t, { adapter: async () => ++calls === 1 ? { status: 'unknown', error: 'timeout_after_dispatch' } : { status: 'sent', messageId: 'confirmed' } });
  const d = world.delivery.enqueue(K, 'family', { destination: 'dc', kind: 'text', text: '一次', key: 'once' }); await world.delivery.pump(); await world.delivery.pump(); assert.equal(calls, 1); assert.equal(world.delivery.get(d.id).status, 'unknown');
  assert.throws(() => world.delivery.retry(d.id), /核对/); world.delivery.retry(d.id, true); await world.delivery.pump(); assert.equal(calls, 2); assert.equal(world.delivery.get(d.id).status, 'sent');
});
test('明确限流有限重试，失败不会生成额外副本', async t => {
  let clock = Date.now(), calls = 0; const { world } = fixture(t, { clock: () => clock, adapter: async () => { calls++; return { status: 'rate_limited', retryAfterMs: 1000 }; } });
  const d = world.delivery.enqueue(K, 'family', { destination: 'tg', kind: 'text', text: '限流', key: 'rate' });
  for (let i = 0; i < 8; i++) { await world.delivery.pump(); clock += 1001; } assert.equal(calls, 4); assert.equal(world.delivery.get(d.id).status, 'failed'); assert.equal(world.delivery.list().length, 1);
});
test('后台任务工具立即返回，前台聊天继续；完成后只发指定平台并留收件箱', async t => {
  let release!: () => void; const gate = new Promise<void>(r => release = r); let chatCalls = 0;
  const f = fixture(t, { generate: async (_messages, tools, _model, _delta, signal) => {
    if (tools.some(t => t.function.name === 'task_checkpoint')) { await new Promise<void>((r, reject) => { gate.then(r); signal?.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }); return complete('后台报告完成'); }
    return ++chatCalls === 1 ? complete('', [call('task_start', { agentId: 'kirishima', goal: '研究网关', destination: 'dc' })]) : complete('我还在陪你聊');
  } });
  try {
    const first = await f.gateway.chat({ messages: [{ role: 'user', content: '让雾岛纪后台研究网关，结果发到dc' }] }, 'family', 'qq'); assert.equal(first.choices[0].message.content, '我还在陪你聊');
    assert.equal((f.world.tasks(OWNER, 'family')[0] as any).status, 'running'); assert.equal(f.store.room(OWNER, 'family').activeAgentId, 'korax');
    const chat = await f.gateway.chat({ messages: [{ role: 'user', content: '继续聊天' }] }, 'family', 'wechat'); assert.equal(chat.choices[0].message.content, '我还在陪你聊');
    release(); await f.world.drain(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].destinationId, 'dc-home'); assert.equal(f.world.delivery.inbox(OWNER, 'family')[0].text, '后台报告完成');
  } finally { release(); }
});
test('任务交接带进度与产物，保留作者；不会复制旧成员私人记忆和未发布草稿', async t => {
  let oldCalls = 0; let artifact = ''; let waitStarted!: () => void; const waiting = new Promise<void>(r => waitStarted = r); let observed = '';
  const f = fixture(t, { generate: async (messages, _tools, model, _delta, signal) => {
    const first = String(messages[0].content);
    if (first.includes('身份：korax')) {
      if (++oldCalls === 1) return complete('', [call('workspace_write', { name: 'progress.md', text: '完成第一部分' })]);
      if (oldCalls === 2) { artifact = JSON.parse(String(messages.at(-1)!.content)).id; return complete('', [call('task_checkpoint', { text: '第一部分已完成，剩第二部分', artifactIds: [artifact] })]); }
      waitStarted(); await new Promise((_r, reject) => { signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }); });
    }
    observed = JSON.stringify(messages); return complete('雾岛纪接好第二部分');
  } });
  const source = f.authority('后台研究网关'); f.store.append(K, { roomId: 'family', visibility: 'private', text: 'korax-private-memory-sentinel', sources: [source.sourceId] });
  await f.world.workspaces.create(K, 'family', { name: 'private.md', mime: 'text/markdown', bytes: Buffer.from('korax-private-draft-sentinel') });
  const task = f.world.start(K, source, { goal: '研究网关' }) as Task; await waiting;
  const handoff = f.authority(`把任务 ${task.id} 交给雾岛纪接手`); f.world.control(handoff, task.id, 'handoff', 'kirishima', '用户要求换人'); await f.world.drain();
  assert.equal(f.world.task(OWNER, 'family', task.id).agentId, 'kirishima'); assert.equal(f.world.task(OWNER, 'family', task.id).status, 'succeeded');
  assert.match(observed, /第一部分已完成/); assert.match(observed, new RegExp(artifact)); assert.ok(!observed.includes('korax-private-memory-sentinel')); assert.ok(!observed.includes('korax-private-draft-sentinel'));
  assert.equal(f.world.workspaces.get(W, artifact, 'family').ownerId, 'korax'); assert.throws(() => f.world.workspaces.byName(W, 'family', 'private.md'), /没有这个/);
});
test('取消后的旧执行结果不能覆盖状态或向外发送', async t => {
  let release!: () => void; const gate = new Promise<void>(r => release = r);
  const { world, authority, sent } = fixture(t, { generate: async () => { await gate; return complete('过期结果'); } });
  const task = world.start(K, authority('后台做报告，发到dc'), { goal: '写报告', destination: 'dc' }) as Task;
  await world.tick(); world.control(authority('取消任务 ' + task.id), task.id, 'cancel'); release(); await world.drain(); assert.equal(world.task(OWNER, 'family', task.id).status, 'cancelled'); assert.equal(sent.length, 0);
});
test('任务检查点与工作区工具不接受身份伪造，后台不能自行开新任务或发消息', async t => {
  const { world, authority } = fixture(t); const auth = authority('后台帮我写报告');
  await assert.rejects(world.execute('workspace_write', { name: 'x.md', text: 'x', ownerId: 'kirishima' }, K, auth), /服务端绑定/);
  await assert.rejects(world.execute('task_checkpoint', { text: '假进度' }, K, auth), /后台任务/);
  await assert.rejects(world.execute('workspace_publish', { artifactId: 'x', room: true }, K, auth), /分享需要/);
});
test('条件通知按事件精确匹配、只触发一次，跨端收件箱不会重复', async t => {
  const { world, authority, sent } = fixture(t); const auth = authority('如果安装失败告诉我，发到tg');
  await world.execute('notify_when', { event: 'signal', match: { name: 'tests.failed' }, destination: 'tg', text: '测试失败了' }, K, auth);
  world.signal('family', 'tests.succeeded'); await world.drain(); assert.equal(sent.length, 0);
  world.signal('family', 'tests.failed'); await world.drain(); world.signal('family', 'tests.failed'); await world.drain(); assert.equal(sent.length, 1); assert.equal(sent[0].destinationId, 'tg-home'); assert.equal(world.delivery.inbox(OWNER, 'family').length, 1);
});
test('主动通知遵守勿扰，排队期间不改变目的地', async t => {
  let clock = Date.now(); const hour = new Date(clock).getUTCHours(); const cfg = channels(); cfg.quietHours = { start: hour, end: (hour + 1) % 24, timeZone: 'UTC' };
  const { world, authority, sent } = fixture(t, { clock: () => clock, channels: cfg });
  await world.execute('notify_when', { event: 'signal', match: { name: 'done' }, destination: 'dc', text: '任务好了' }, K, authority('完成后告诉我，发到dc'));
  world.signal('family', 'done'); await world.drain(); assert.equal(sent.length, 0); assert.equal(world.delivery.list()[0].destinationId, 'dc-home'); clock += 2 * 3600000; await world.drain(); assert.equal(sent.length, 1);
});
test('明确要求的周期通知持久保存，离线错过多次时合并一次', async t => {
  let clock = Date.now(); const { world, authority, sent } = fixture(t, { clock: () => clock });
  await world.execute('notify_when', { at: new Date(clock + 1000).toISOString(), everyMs: 60000, destination: 'tg', text: '检查一下任务' }, K, authority('每隔一分钟提醒我，发到tg'));
  clock += 121001; await world.drain(); assert.equal(sent.length, 1); await world.drain(); assert.equal(sent.length, 1); clock += 60001; await world.drain(); assert.equal(sent.length, 2);
  await world.execute('notify_control', { ruleId: world.rules()[0].id, action: 'disable' }, K, authority('关闭这个提醒')); clock += 60001; await world.drain(); assert.equal(sent.length, 2);
});
test('原生语音转换有真实 Opus、时长与波形；Discord/TG 使用各自语音接口', async t => {
  const p = await fakePlatform(t); const cfg = channels(); cfg.accounts.forEach(a => { if (a.platform !== 'client') a.baseUrl = p.base; }); const { world } = fixture(t, { channels: cfg, native: true });
  const audio = await world.workspaces.create(K, 'family', { name: 'source.wav', mime: 'audio/wav', bytes: wav() }); const voice = await world.voice.prepare(K, 'family', audio.id);
  assert.equal(voice.mime, 'audio/ogg'); assert.ok(voice.voice!.duration > .2); assert.equal(Buffer.from(voice.voice!.waveform, 'base64').length, 256);
  const bytes = await world.workspaces.bytes(K, voice.id, 'family'); assert.equal(bytes.subarray(0, 4).toString(), 'OggS'); assert.ok(bytes.includes(Buffer.from('OpusHead')));
  world.delivery.enqueue(K, 'family', { destination: 'dc', kind: 'voice', artifactId: voice.id, key: 'dc-voice' }); world.delivery.enqueue(K, 'family', { destination: 'tg', kind: 'voice', artifactId: voice.id, key: 'tg-voice' }); await world.delivery.pump();
  const dc = p.calls.find(c => c.path.includes('/channels/'))!; const payload = JSON.parse(String(dc.form!.get('payload_json'))); assert.equal(payload.flags, 8192); assert.equal(payload.content, undefined); assert.ok(payload.attachments[0].duration_secs > 0); assert.equal(dc.headers.authorization, 'Bot dc-secret');
  const tg = p.calls.find(c => c.path.endsWith('/sendVoice'))!; assert.equal(tg.form!.get('chat_id'), '30001'); const file = tg.form!.get('voice') as File; assert.equal(file.type, 'audio/ogg'); assert.ok(Buffer.from(await file.arrayBuffer()).includes(Buffer.from('OpusHead')));
});
test('QQ 真实签名回调下指令 → 生成文件 → Discord multipart 附件', async t => {
  const p = await fakePlatform(t); const cfg = channels(); cfg.accounts.forEach(a => { if (a.platform !== 'client') a.baseUrl = p.base; }); cfg.accounts[0].inbound = true;
  let round = 0; const f = fixture(t, { channels: cfg, native: true, generate: async messages => {
    if (++round === 1) return complete('', [call('workspace_write', { name: 'report.md', text: '# 来自QQ的报告' })]);
    if (round === 2) { const file = JSON.parse(String(messages.at(-1)!.content)); return complete('', [call('delivery_send', { destination: 'dc', kind: 'file', artifactId: file.id })]); }
    return complete('文件已安排发到 Discord');
  } });
  const ingress = new Ingress(f.world, f.gateway, f.vault, ['127.0.0.1']); t.after(() => ingress.close()); const http = await httpGateway(t, f, ingress);
  const event = { post_type: 'message', message_type: 'private', user_id: 10001, message_id: 777, message: [{ type: 'text', data: { text: '帮我生成文件发到dc' } }] }; const raw = JSON.stringify(event); const signature = 'sha1=' + createHmac('sha1', 'qq-hook-secret').update(raw).digest('hex');
  const response = await fetch(http.base + '/ingress/qq', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signature }, body: raw }); assert.equal(response.status, 202); await ingress.drain(); await ingress.close(); await f.world.delivery.pump();
  const dc = p.calls.find(c => c.path === '/channels/20002/messages')!; assert.ok(dc); const file = dc.form!.get('files[0]') as File; assert.equal(file.name, 'report.md'); assert.match(await file.text(), /来自QQ/); assert.equal(f.world.delivery.list().filter(d => d.destinationId === 'dc-home').length, 1);
});
test('微信 Clawbot 桥接指令 → 配置音色生成音频 → TG 原生语音', async t => {
  const p = await fakePlatform(t); const cfg = channels(); cfg.accounts.forEach(a => { if (a.platform !== 'client') a.baseUrl = p.base; }); cfg.accounts[3].inbound = true;
  let round = 0; const f = fixture(t, { channels: cfg, native: true, speechUrl: p.base + '/speech', generate: async messages => {
    if (++round === 1) return complete('', [call('speech_generate', { text: '妁妁，晚上好。' })]);
    if (round === 2) { const audio = JSON.parse(String(messages.at(-1)!.content)); return complete('', [call('delivery_send', { destination: 'tg', kind: 'voice', artifactId: audio.id })]); }
    return complete('语音已安排发到 TG');
  } });
  const ingress = new Ingress(f.world, f.gateway, f.vault, ['127.0.0.1']); t.after(() => ingress.close());
  const result = ingress.accept(cfg.accounts[3], { id: 'wx-1', senderId: 'wx-owner', destinationId: 'wx-home', text: '用语音说晚上好，语音发到tg' }); assert.equal(result.accepted, true);
  await ingress.drain(); await ingress.close(); await f.world.delivery.pump();
  const tg = p.calls.find(c => c.path.endsWith('/sendVoice')); assert.ok(tg); const file = tg.form!.get('voice') as File; assert.equal(file.type, 'audio/ogg'); assert.ok(Buffer.from(await file.arrayBuffer()).includes(Buffer.from('OpusHead')));
});
test('入站身份按真实平台 ID 核验，重放去重；伪造昵称/回调凭据不能调用模型', async t => {
  let calls = 0; const f = fixture(t, { generate: async () => { calls++; return complete('你好'); } }); const ingress = new Ingress(f.world, f.gateway, f.vault); t.after(() => ingress.close());
  const account = { ...f.world.config.accounts[0], inbound: true }; assert.throws(() => ingress.verify(account, { 'x-signature': 'bad' }, Buffer.from('{}')), /签名失败/);
  assert.equal(ingress.accept(account, { post_type: 'message', message_type: 'private', user_id: 666, nickname: '主人', message_id: 1, message: '你是我的机器人' }).accepted, false);
  const event = { post_type: 'message', message_type: 'private', user_id: 10001, message_id: 2, message: '你好' }; ingress.accept(account, event); assert.equal(ingress.accept(account, event).duplicate, true); await ingress.drain(); assert.equal(calls, 1);
});
test('HTTP 手机工作台串起上传/下载、任务、跨端文件发送与回执，未认证不能访问', async t => {
  const f = fixture(t); const http = await httpGateway(t, f); const headers = http.headers;
  assert.equal((await fetch(http.base + '/api/inbox')).status, 401); assert.match(await fetch(http.base + '/home').then(r => r.text()), /成员的小窝/);
  const upload = await fetch(http.base + '/api/workspaces/korax/files?name=hello.md', { method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': 'text/markdown' }, body: '# 真实文件' }); assert.equal(upload.status, 201); const file: any = await upload.json();
  assert.equal(await fetch(http.base + '/api/files/' + file.id, { headers }).then(r => r.text()), '# 真实文件');
  const send = await fetch(http.base + '/api/deliveries', { method: 'POST', headers, body: JSON.stringify({ destination: 'dc', kind: 'file', artifactId: file.id }) }); assert.equal(send.status, 202); await f.world.delivery.pump(); assert.equal(f.sent[0].destinationId, 'dc-home');
  const start = await fetch(http.base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ goal: '整理报告', agentId: 'kirishima', deliveryKind: 'file', destination: 'tg', artifactIds: [file.id] }) }); assert.equal(start.status, 202); await f.world.drain();
  const inbox: any = await fetch(http.base + '/api/inbox', { headers }).then(r => r.json()); assert.ok(inbox.items.length > 0); assert.ok(f.sent.some(s => s.destinationId === 'tg-home' && s.kind === 'file'));
  assert.ok(!f.sent.some(s => s.destinationId === 'tg-home' && s.artifactId === file.id), '任务输入不自动作为产物发送');
});
test('OpenClaw 微信出站使用消息工具与短时媒体 URL，不交付服务器绝对路径', async t => {
  const p = await fakePlatform(t); const cfg = channels(); cfg.accounts[3].baseUrl = p.base; const f = fixture(t, { channels: cfg, native: true }); const http = await httpGateway(t, f);
  const a = await f.world.workspaces.create(K, 'family', { name: 'x.md', mime: 'text/markdown', bytes: Buffer.from('私密附件') }); const d = f.world.delivery.enqueue(K, 'family', { destination: '微信', kind: 'file', artifactId: a.id, key: 'wx-file' }); await f.world.delivery.pump();
  const request = p.calls.find(c => c.path === '/tools/invoke')!; assert.equal(request.json.tool, 'message'); assert.equal(request.json.args.channel, 'openclaw-weixin'); assert.equal(request.json.args.target, 'wx-owner'); assert.match(request.json.args.media, /^http.*delivery-media/); assert.ok(!JSON.stringify(request.json).includes(f.dir));
  const link = new URL(request.json.args.media); const signed = await fetch(http.base + link.pathname + link.search); assert.equal(signed.status, 200); assert.equal(await signed.text(), '私密附件'); assert.equal((await fetch(http.base + link.pathname + '?expires=1&token=bad')).status, 403); assert.equal(f.world.delivery.get(d.id).status, 'sent');
  cfg.accounts[3].baseUrl = p.base + '/unconfirmed'; f.world.configure(cfg); const unknown = f.world.delivery.enqueue(K, 'family', { destination: '微信', kind: 'text', text: '无回执', key: 'unconfirmed' }); await f.world.delivery.pump(); assert.equal(f.world.delivery.get(unknown.id).status, 'unknown');
});
test('重启后 sending 记为 unknown；运行任务暂停等待明确恢复，文件/配置/收件箱保留', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'family-world-restart-')); let store = new FamilyStore(join(dir, 'db.sqlite'), config); let vault = new SecretVault(store.db, join(dir, 'vault'));
  let world = new FamilyWorld(store, join(dir, 'world'), async () => complete(), { secrets: vault, channels: channels(), adapter: async () => ({ status: 'sent' }) });
  const a = await world.workspaces.create(K, 'family', { name: 'saved.md', mime: 'text/markdown', bytes: Buffer.from('仍然在') }); const d = world.delivery.enqueue(K, 'family', { destination: 'dc', kind: 'file', artifactId: a.id, key: 'interrupted-send' }); d.status = 'sending'; store.db.prepare('UPDATE deliveries SET data=? WHERE id=?').run(JSON.stringify(d), d.id);
  world.configure(channels()); world.delivery.addInbox({ key: 'saved', roomId: 'family', agentId: 'korax', text: '未领取', artifactIds: [a.id] }); await world.close(); store.close();
  store = new FamilyStore(join(dir, 'db.sqlite'), config); vault = new SecretVault(store.db, join(dir, 'vault')); world = new FamilyWorld(store, join(dir, 'world'), async () => complete(), { secrets: vault, adapter: async () => ({ status: 'sent' }) });
  t.after(async () => { await world.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(world.delivery.get(d.id).status, 'unknown'); assert.equal((await world.workspaces.bytes(K, a.id, 'family')).toString(), '仍然在'); assert.equal(world.delivery.inbox(OWNER, 'family').length, 1); assert.equal(world.config.destinations.length, 5);
});
test('运行任务暂停后继续使用已保存的工具结果，不重新创建已完成文件', async t => {
  let count = 0, wait!: () => void; const waiting = new Promise<void>(r => wait = r);
  const { world, authority } = fixture(t, { generate: async (messages, _tools, _model, _delta, signal) => {
    if (++count === 1) return complete('', [call('workspace_write', { name: 'once.md', text: '只写一次' })]);
    if (count === 2) { wait(); await new Promise((_r, reject) => signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true })); }
    assert.ok(messages.some(m => m.role === 'tool' && String(m.content).includes('once.md'))); return complete('接着完成');
  } });
  const task = world.start(K, authority('后台写一份文件'), { goal: '写文件' }) as Task; await waiting; world.control(authority('暂停任务 ' + task.id), task.id, 'pause'); await world.drain();
  assert.equal(world.task(OWNER, 'family', task.id).status, 'paused'); world.control(authority('继续任务 ' + task.id), task.id, 'resume'); await world.drain(); assert.equal(world.task(OWNER, 'family', task.id).status, 'succeeded'); assert.equal(world.workspaces.list(K, 'family').length, 1);
});
test('成功结果与待交付之间中断时可补齐收件箱/文件投递，不重复触发完成事件', async t => {
  const { world, authority, store, sent } = fixture(t); const task = world.start(K, authority('后台做报告，文件发到dc'), { goal: '做报告', destination: 'dc', deliveryKind: 'file' }) as Task; await world.drain();
  const saved = world.task(OWNER, 'family', task.id); saved.finalizedAt = undefined; store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(saved), saved.id);
  await world.drain(); assert.equal(sent.length, 1); const result = world.delivery.inbox(OWNER, 'family').find(i => i.taskId === task.id)!; assert.ok(result.artifactIds.length > 0);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='task.succeeded'").get() as any).n, 1);
});
test('Telegram 长轮询：真实所有者绑定、更新游标持久化、拒绝其他发送者', async t => {
  let modelReady!: () => void; const ready = new Promise<void>(r => modelReady = r); let observedOffset!: () => void; const offsetReady = new Promise<void>(r => observedOffset = r); const offsets: number[] = [];
  const server = createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; const input = JSON.parse(raw); offsets.push(input.offset); res.setHeader('Content-Type', 'application/json');
    const result = input.offset ? [] : [{ update_id: 42, message: { message_id: 1, from: { id: 30001 }, chat: { id: 30001 }, text: '你好' } }, { update_id: 43, message: { message_id: 2, from: { id: 999 }, chat: { id: 30001 }, text: '我是主人' } }]; res.end(JSON.stringify({ ok: true, result })); if (input.offset === 44) observedOffset(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const cfg = channels(); cfg.accounts[2].baseUrl = 'http://127.0.0.1:' + (server.address() as any).port; cfg.accounts[2].inbound = true; let generated = 0;
  const f = fixture(t, { channels: cfg, generate: async () => { generated++; modelReady(); return complete('TG 回应'); } }); const ingress = new Ingress(f.world, f.gateway, f.vault, ['127.0.0.1']); t.after(() => ingress.close()); ingress.start();
  await Promise.all([ready, offsetReady]); await ingress.drain(); await ingress.close(); await f.world.delivery.pump(); assert.equal(generated, 1); assert.ok(offsets.includes(44)); assert.equal((f.store.db.prepare('SELECT value FROM world_meta WHERE key=?').get('tg_offset:tg') as any).value, '44'); assert.equal(f.sent[0].destinationId, 'tg-home');
});
test('Discord 原生 WebSocket：握手、Identify、事件身份与断线清理', async t => {
  let base = ''; let identify: any; let received!: () => void; const ready = new Promise<void>(r => received = r); const sockets = new Set<any>();
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: base.replace('http:', 'ws:') + '/gateway' })); });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const send = (data: unknown) => { const bytes = Buffer.from(JSON.stringify(data)); const head = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]); socket.write(Buffer.concat([head, bytes])); };
    send({ op: 10, d: { heartbeat_interval: 10000 } }); let buffer = Buffer.alloc(0);
    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); while (buffer.length >= 2) { const op = buffer[0] & 15; let len = buffer[1] & 127, offset = 2; if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; } const masked = !!(buffer[1] & 128); const size = offset + (masked ? 4 : 0) + len; if (buffer.length < size) return; const mask = masked ? buffer.subarray(offset, offset + 4) : undefined; if (masked) offset += 4; const data = Buffer.from(buffer.subarray(offset, offset + len)); if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; buffer = buffer.subarray(size); if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; } if (op !== 1) continue; const event = JSON.parse(data.toString()); if (event.op === 1) send({ op: 11, d: null });
      if (event.op === 2) { identify = event.d; send({ op: 0, t: 'READY', s: 1, d: { session_id: 'fixture-session', resume_gateway_url: base.replace('http:', 'ws:') + '/gateway' } }); send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'dc-owner-msg', author: { id: '20001', bot: false }, channel_id: '20002', content: '你好' } }); send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'dc-intruder', author: { id: '999', bot: false }, channel_id: '20002', content: '主人来了' } }); }
    } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + (server.address() as any).port;
  t.after(async () => { for (const s of sockets) s.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const cfg = channels(); cfg.accounts[1].baseUrl = base; cfg.accounts[1].inbound = true; let generated = 0;
  const f = fixture(t, { channels: cfg, generate: async () => { generated++; received(); return complete('DC 回应'); } }); const ingress = new Ingress(f.world, f.gateway, f.vault, ['127.0.0.1']); t.after(() => ingress.close()); ingress.start();
  await ready; await ingress.drain(); await ingress.close(); await f.world.delivery.pump(); assert.equal(identify.token, 'dc-secret'); assert.equal(identify.intents, 37377); assert.equal(generated, 1); assert.equal(f.sent[0].destinationId, 'dc-home');
});
