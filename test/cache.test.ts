import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import { DurableCache } from '../src/cache.ts';
import { createFamilyServer } from '../src/server.ts';
import { OWNER } from '../src/types.ts';
import type { Config, Message } from '../src/types.ts';
import type { Generate, GenerationOptions } from '../src/provider.ts';

const template: Config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const response = (content = '继续聊。') => ({ content, toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 2, cached_tokens: 64 }, finishReason: 'stop' });
const body = (text: string) => ({ messages: [{ role: 'user' as const, content: text }] });
function fixture(t: any, generate: Generate = async () => response()) {
  const config = structuredClone(template); const store = new FamilyStore(':memory:', config);
  t.after(() => store.close()); return { config, store, gateway: new FamilyGateway(store, config, generate) };
}
function source(store: FamilyStore, room = 'family') { return store.event(OWNER, room, 'message', { message: { role: 'user', content: '有来源的原话' } }).id; }

test('TG → 微信 Clawbot → QQ → 客户端 → Discord 共用缓存，新增上下文仍然更新', async t => {
  const seen: { messages: Message[]; options?: GenerationOptions }[] = [];
  const { store, gateway } = fixture(t, async (messages, _tools, _model, _delta, _signal, options) => { seen.push({ messages, options }); return response(`回复-${seen.length}`); });
  const server = createFamilyServer(store, gateway, 'cache-test-token-long'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const platforms = ['tg', 'wechat-clawbot', 'qq', 'chat-client', 'discord'];
  const replies: any[] = [];
  for (const [i, client] of platforms.entries()) {
    const r = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer cache-test-token-long', 'Content-Type': 'application/json', 'X-Client-Id': client }, body: JSON.stringify(body(`第${i + 1}端原话`)) });
    assert.equal(r.status, 200); replies.push(await r.json());
  }
  assert.equal(replies[0].family.cache.prefixHit, false);
  for (const reply of replies.slice(1)) {
    assert.equal(reply.family.cache.prefixHit, true); assert.equal(reply.family.cache.historyHit, true);
    assert.equal(reply.family.cache.memoryHit, true); assert.equal(reply.family.cache.handoffHit, true);
    assert.equal(reply.family.cache.historyAdded, 2); assert.equal(reply.family.cache.providerCachedTokens, 64);
  }
  assert.equal(new Set(seen.map(s => s.options?.cache?.key)).size, 1);
  assert.ok(seen[4].messages.some(m => m.content === '第1端原话'));
  assert.ok(seen[4].messages.some(m => m.content === '回复-4'));
  assert.ok(seen[4].messages.some(m => m.content === '第5端原话'));
  assert.deepEqual(seen[0].messages[0], seen[4].messages[0]);
  const stats = await fetch(`${url}/api/cache`, { headers: { Authorization: 'Bearer cache-test-token-long' } }).then(r => r.json()) as any;
  assert.equal(stats.counters['prefix.hits'], 4); assert.equal(stats.counters['provider.cached_tokens'], 320);
  assert.ok(!JSON.stringify(stats).includes('第1端原话'));
});
test('重启后缓存与家庭命名空间继续沿用，新客户端补上此前最后回复', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'family-cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'family.sqlite'); let store = new FamilyStore(path, structuredClone(template));
  let key = ''; let gateway = new FamilyGateway(store, template, async (_m, _t, _model, _delta, _signal, options) => { key = options!.cache!.key; return response('重启前的回复'); });
  await gateway.chat(body('重启前的原话'), 'family', 'tg'); const originalId = store.householdId; store.close();
  store = new FamilyStore(path, structuredClone(template)); t.after(() => store.close());
  gateway = new FamilyGateway(store, template, async (m, _t, _model, _delta, _signal, options) => { assert.equal(options!.cache!.key, key); assert.ok(m.some(x => x.content === '重启前的回复')); return response(); });
  const r = await gateway.chat(body('重启后的新话'), 'family', 'discord');
  assert.equal(store.householdId, originalId); assert.equal(r.family.cache.prefixHit, true); assert.equal(r.family.cache.historyHit, true); assert.equal(r.family.cache.memoryHit, true);
});
test('记忆追加、补充、质疑与确认使记忆缓存立即失效，稳定前缀继续命中', async t => {
  const contexts: Message[][] = []; const { store, gateway } = fixture(t, async m => { contexts.push(m); return response(); });
  const origin = source(store);
  const m = store.append({ kind: 'agent', id: 'korax' }, { roomId: 'family', visibility: 'shared', text: '尚未确认的认识', kind: 'fact', sources: [origin] });
  await gateway.chat(body('第一轮'), 'family', 'tg');
  store.operate(OWNER, m.id, 'confirm', '用户确认', [origin]);
  const confirmed = await gateway.chat(body('第二轮'), 'family', 'wechat-clawbot');
  assert.equal(confirmed.family.cache.memoryHit, false); assert.equal(confirmed.family.cache.prefixHit, true);
  assert.match(JSON.stringify(contexts[1]), /confirmed/);
  store.operate({ kind: 'agent', id: 'kirishima' }, m.id, 'challenge', '出现不同观点', [origin]);
  const challenged = await gateway.chat(body('第三轮'), 'family', 'qq'); assert.equal(challenged.family.cache.memoryHit, false); assert.match(JSON.stringify(contexts[2]), /contested/);
  store.operate(OWNER, m.id, 'supplement', '补上新的说明', [origin]);
  const supplemented = await gateway.chat(body('第四轮'), 'family', 'discord'); assert.equal(supplemented.family.cache.memoryHit, false); assert.match(JSON.stringify(contexts[3]), /补上新的说明/);
});
test('成员自己的私人房间记忆更新也使当前客厅缓存失效', async t => {
  const seen: Message[][] = []; const { store, gateway } = fixture(t, async m => { seen.push(m); return response(); });
  await gateway.chat(body('客厅'), 'family', 'tg'); const origin = source(store, 'private-korax');
  store.append({ kind: 'agent', id: 'korax' }, { roomId: 'private-korax', visibility: 'private', text: '私人房间的新记忆', sources: [origin] });
  const r = await gateway.chat(body('回客厅'), 'family', 'qq'); assert.equal(r.family.cache.memoryHit, false); assert.match(JSON.stringify(seen[1]), /私人房间的新记忆/);
});
test('缓存保温后换人格，私密数据仍隔离；换回本人可以重新命中自己的缓存', async t => {
  const seen: Message[][] = []; const keys: string[] = [];
  const { store, gateway } = fixture(t, async (m, _t, _model, _delta, _signal, options) => { seen.push(m); keys.push(options!.cache!.key); return response(); });
  const origin = source(store);
  store.append({ kind: 'agent', id: 'korax' }, { roomId: 'family', visibility: 'private', text: 'cached-private-sentinel', sources: [origin] });
  await gateway.chat(body('第一轮'), 'family', 'tg');
  const switched = await gateway.chat(body('让雾岛纪来'), 'family', 'qq');
  assert.equal(switched.family.cache.prefixHit, false); assert.notEqual(keys[0], keys[1]); assert.ok(!JSON.stringify(seen[1]).includes('cached-private-sentinel'));
  const returned = await gateway.chat(body('换回κόραξ'), 'family', 'discord');
  assert.equal(returned.family.cache.prefixHit, true); assert.equal(returned.family.cache.handoffHit, false); assert.equal(keys[0], keys[2]);
  assert.match(JSON.stringify(seen[2]), /cached-private-sentinel/);
});
test('先核验实时房间权限，再使用缓存；房间不同也不混用', async t => {
  const { store, gateway } = fixture(t);
  store.createRoom(OWNER, 'studio', '工作室', ['korax'], 'korax');
  await gateway.chat(body('工作室里保温'), 'studio', 'tg');
  const room = await gateway.chat(body('回到客厅'), 'family', 'qq'); assert.equal(room.family.cache.historyHit, false);
  store.db.prepare('UPDATE rooms SET members=? WHERE id=?').run(JSON.stringify(['kirishima']), 'studio');
  await assert.rejects(gateway.chat(body('不能借缓存越权'), 'studio', 'discord'), /权限/);
});
test('人设、模型或工具变更不会错误沿用旧前缀，工具顺序差异被规范化', async t => {
  const keys: string[] = []; const schemas: unknown[] = []; const seen: Message[][] = [];
  const { config, gateway } = fixture(t, async (m, tools, _model, _delta, _signal, options) => { seen.push(m); schemas.push(tools); keys.push(options!.cache!.key); return response(); });
  const a = { type: 'function' as const, function: { name: 'aa', description: 'a', parameters: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } } } } };
  const z = { type: 'function' as const, function: { name: 'zz', description: 'z', parameters: {} } };
  await gateway.chat({ ...body('一'), tools: [z, a] }, 'family', 'tg');
  const reordered = await gateway.chat({ ...body('二'), tools: [a, z] }, 'family', 'qq'); assert.equal(reordered.family.cache.prefixHit, true); assert.equal(keys[0], keys[1]); assert.deepEqual(schemas[0], schemas[1]);
  config.agents[0].persona = '更新过的人设';
  const persona = await gateway.chat({ ...body('三'), tools: [a, z] }, 'family', 'discord'); assert.equal(persona.family.cache.prefixHit, false); assert.notEqual(keys[1], keys[2]); assert.match(String(seen[2][0].content), /更新过的人设/);
  config.agents[0].model = 'another-model';
  const model = await gateway.chat({ ...body('四'), tools: [a, z] }, 'family', 'tg'); assert.equal(model.family.cache.prefixHit, false); assert.notEqual(keys[2], keys[3]);
  const changed = await gateway.chat({ ...body('五'), tools: [a] }, 'family', 'qq'); assert.equal(changed.family.cache.prefixHit, false); assert.notEqual(keys[3], keys[4]);
});
test('缓存损坏时从权威原文重建，每轮仍只调用一次模型', async t => {
  let n = 0; const seen: Message[][] = []; const { store, gateway } = fixture(t, async m => { n++; seen.push(m); return response(); });
  await gateway.chat(body('权威原话'), 'family', 'tg');
  store.db.prepare('UPDATE gateway_cache SET value=?').run('{"damaged":true}');
  const r = await gateway.chat(body('继续'), 'family', 'discord');
  assert.equal(n, 2); assert.equal(r.family.cache.historyHit, false); assert.match(JSON.stringify(seen[1]), /权威原话/); assert.ok(gateway.cache.stats().counters.errors >= 4);
});
test('缓存有 TTL/LRU 容量限制，过期只影响派生数据，不删原文', t => {
  const { store } = fixture(t); let now = 1000;
  const cache = new DurableCache(store.db, { maxEntries: 4, maxBytes: 4096, ttlSeconds: 1 }, () => now);
  for (let i = 0; i < 8; i++) cache.put('prefix', { i }, 'v1', { text: `value-${i}` });
  assert.equal(cache.stats().entries, 4); assert.equal(cache.stats().counters.evictions, 4);
  assert.equal(cache.get('prefix', { i: 0 }, 'v1').hit, false); assert.equal(cache.get('prefix', { i: 7 }, 'v1').hit, true);
  source(store); now += 1001;
  assert.equal(cache.get('prefix', { i: 7 }, 'v1').hit, false); assert.equal(cache.stats().entries, 0); assert.equal(store.history(OWNER, 'family').length, 1);
});
test('缓存表故障不会重跑回答模型，也不会阻断权威原文读取', async t => {
  let calls = 0; const seen: Message[][] = []; const { store, gateway } = fixture(t, async m => { calls++; seen.push(m); return response(); });
  await gateway.chat(body('第一句原文'), 'family', 'tg');
  store.db.exec('DROP TABLE gateway_cache');
  const r = await gateway.chat(body('第二句原文'), 'family', 'discord');
  assert.equal(calls, 2); assert.equal(r.choices[0].message.content, '继续聊。'); assert.match(JSON.stringify(seen[1]), /第一句原文/); assert.equal(gateway.cache.stats().unavailable, true);
});
