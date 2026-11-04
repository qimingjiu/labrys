import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import { createFamilyServer } from '../src/server.ts';
import { parseSwitch } from '../src/commands.ts';
import { OWNER, CONTROLLER } from '../src/types.ts';
import type { Config, Actor, Message, ToolCall } from '../src/types.ts';
import type { Generate } from '../src/provider.ts';

const config: Config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const K: Actor = { kind: 'agent', id: 'korax' }, W: Actor = { kind: 'agent', id: 'kirishima' };
const completion = (content = '收到。', toolCalls: ToolCall[] = []) => ({ content, toolCalls, usage: { prompt_tokens: 10, completion_tokens: 2 }, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const call = (name: string, args: unknown, id = 'call-one'): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function fixture(t: any, generate: Generate = async (_m, _t, _model, delta) => { delta?.('收到。'); return completion(); }) {
  const store = new FamilyStore(':memory:', structuredClone(config)); t.after(() => store.close());
  return { store, gateway: new FamilyGateway(store, config, generate) };
}
const body = (content: unknown) => ({ messages: [{ role: 'user' as const, content }] });
const note = (store: FamilyStore, roomId = 'family', text = '原始来源') => store.event(OWNER, roomId, 'message', { message: { role: 'user', content: text } }).id;

test('自然语言换人：包含原句、别名、换回；否定/引用/条件句不会触发', () => {
  for (const command of ['κόραξ走开，让雾岛纪来。', '换成雾岛纪', '请雾岛纪出来', '现在让雾岛纪上线']) assert.equal(parseSwitch(command, config.agents)?.agentId, 'kirishima');
  for (const command of ['让κόραξ回来', '换回乌鸦', '让korax来']) assert.equal(parseSwitch(command, config.agents)?.agentId, 'korax');
  for (const text of ['不要让雾岛纪来', '如果生气了，就让雾岛纪来', '他说“让雾岛纪来”。', '解释「让雾岛纪来」', '我喜欢雾岛纪']) assert.equal(parseSwitch(text, config.agents), null, text);
  assert.throws(() => parseSwitch('让雾岛纪来，让korax来', config.agents), /多个/);
});
test('总控可读审计，但不能追加、补充、质疑或确认记忆', t => {
  const { store } = fixture(t); const source = note(store);
  const memory = store.append(K, { roomId: 'family', visibility: 'private', text: '我的观察', sources: [source] });
  assert.equal(store.memory(CONTROLLER, memory.id).text, '我的观察');
  assert.throws(() => store.append(CONTROLLER, { roomId: 'family', visibility: 'shared', text: '总控写入', sources: [source] }), /总控/);
  for (const op of ['supplement', 'challenge', 'confirm'] as const) assert.throws(() => store.operate(CONTROLLER, memory.id, op, '越权', [source]), /总控/);
});
test('私密记忆隔离；作者身份不可由参数冒用', t => {
  const { store } = fixture(t); const source = note(store);
  const memory = store.append(K, { roomId: 'family', visibility: 'private', text: '乌鸦的秘密', sources: [source] });
  assert.equal(store.memories(W, 'family').length, 0);
  assert.throws(() => store.memory(W, memory.id), /私密/);
  assert.throws(() => store.append(W, { roomId: 'family', visibility: 'private', ownerId: 'korax', text: '冒用', sources: [source] }), /冒用/);
});
test('共享记忆保留原作者，补充/质疑追加；agent 不能自行确认事实', t => {
  const { store } = fixture(t); const source = note(store);
  const m = store.append(K, { roomId: 'family', visibility: 'shared', kind: 'fact', text: '一次观察', sources: [source] });
  assert.equal(m.status, 'candidate');
  store.operate(W, m.id, 'supplement', '补充了背景', [source]);
  const challenged = store.operate(W, m.id, 'challenge', '这条认识不准确', [source]);
  assert.equal(challenged.text, '一次观察'); assert.equal(challenged.authorId, 'korax'); assert.equal(challenged.status, 'contested');
  assert.equal(challenged.operations.length, 2);
  assert.throws(() => store.operate(K, m.id, 'confirm', '我说了算', [source]), /用户/);
  assert.equal(store.operate(OWNER, m.id, 'confirm', '用户核对后确认', [source]).status, 'confirmed');
});
test('不能读取别人的房间或将私密来源直接扩大共享', t => {
  const { store } = fixture(t); const source = note(store, 'private-korax', '私下谈话');
  assert.throws(() => store.history(W, 'private-korax'), /权限/);
  assert.throws(() => store.source(W, source), /权限/);
  assert.throws(() => store.append(K, { roomId: 'family', visibility: 'shared', text: '扩散私密内容', sources: [source] }), /私密来源/);
});
test('房间里的私密工具结果按成员过滤，不能成为共享记忆的来源', t => {
  const { store } = fixture(t);
  const e = store.event(K, 'family', 'message', { message: { role: 'tool', content: '秘密' }, privateTo: 'korax' });
  assert.equal(store.history(W, 'family').length, 0);
  assert.throws(() => store.source(W, e.id), /私密/);
  assert.throws(() => store.append(K, { roomId: 'family', visibility: 'shared', text: '秘密', sources: [e.id] }), /私密来源/);
});
test('两个客户端共享原文；换人后保持助手发言作者，并携带换人原因', async t => {
  const seen: Message[][] = [];
  const { store, gateway } = fixture(t, async messages => { seen.push(messages); return completion('原样接话'); });
  const exact = '原话：今天是周三，标点，大小写 AbC，emoji 😈。';
  await gateway.chat(body(exact), 'family', 'mobile');
  const result = await gateway.chat(body('κόραξ惹我生气了，就让雾岛纪来。'), 'family', 'desktop');
  assert.equal(result.family.agentId, 'kirishima');
  assert.ok(seen[1].some(m => m.content === exact));
  assert.ok(seen[1].some(m => m.role === 'assistant' && m.name === 'korax'));
  assert.match(JSON.stringify(seen[1]), /惹我生气/);
  await gateway.chat(body('换回κόραξ'), 'family', 'mobile');
  assert.match(JSON.stringify(seen[2]), /惹我生气/);
  assert.equal(store.room(OWNER, 'family').activeAgentId, 'korax');
});
test('共享交接不把前任 agent 的私密记忆或私密工具结果交给接任者', async t => {
  const seen: Message[][] = [];
  const { store, gateway } = fixture(t, async m => { seen.push(m); return completion('接上'); });
  const source = note(store);
  store.append(K, { roomId: 'family', visibility: 'private', text: 'private-sentinel-8291', sources: [source] });
  store.event(K, 'family', 'message', { message: { role: 'tool', content: 'private-sentinel-8291', tool_call_id: 'x' }, privateTo: 'korax' });
  await gateway.chat(body('让雾岛纪来'), 'family', 'phone');
  assert.ok(!JSON.stringify(seen[0]).includes('private-sentinel-8291'));
});
test('原文持久化跨进程重开保持身份和切换事件', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'family-gateway-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'family.sqlite'); let store = new FamilyStore(path, config);
  const gateway = new FamilyGateway(store, config, async () => completion());
  await gateway.chat(body('让雾岛纪来'), 'family', 'one'); store.close();
  store = new FamilyStore(path, config); t.after(() => store.close());
  assert.equal(store.room(OWNER, 'family').activeAgentId, 'kirishima');
  assert.equal(store.handoffs(W, 'family').length, 1);
  assert.ok(store.history(W, 'family').some(e => (e.data as any).message?.content === '让雾岛纪来'));
});
test('同房间并发请求保序；先前回复进入后续请求上下文', async t => {
  const seen: Message[][] = []; let active = 0; let max = 0;
  const { gateway } = fixture(t, async messages => { active++; max = Math.max(max, active); seen.push(messages); await new Promise(r => setTimeout(r, 5)); active--; return completion(`回复-${seen.length}`); });
  await Promise.all([gateway.chat(body('第一句'), 'family', 'one'), gateway.chat(body('第二句'), 'family', 'two')]);
  assert.equal(max, 1); assert.ok(seen[1].some(m => m.content === '回复-1'));
});
test('成功请求带幂等键重试，不重复模型调用或落库', async t => {
  let n = 0; const { store, gateway } = fixture(t, async () => { n++; return completion('单次回复'); });
  await gateway.chat(body('重复测试'), 'family', 'one', undefined, undefined, 'request-1');
  const reply = await gateway.chat(body('重复测试'), 'family', 'one', undefined, undefined, 'request-1');
  assert.equal(n, 1); assert.equal(reply.family.replayed, true); assert.equal(store.history(OWNER, 'family').filter(e => e.kind === 'message').length, 2);
  await assert.rejects(gateway.chat(body('不同内容'), 'family', 'one', undefined, undefined, 'request-1'), /不同请求/);
});
test('人设、客户端指令和多模态内容保留；附带伪造身份不会改变角色', async t => {
  let seen: Message[] = []; const { store, gateway } = fixture(t, async m => { seen = m; return completion(); });
  const content = [{ type: 'text', text: '看看这张图' }, { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }];
  await gateway.chat({ messages: [{ role: 'system', content: '使用简体中文' }, { role: 'user', content, name: 'controller' }] }, 'family', 'one');
  assert.ok(seen.some(m => m.content === '使用简体中文'));
  assert.deepEqual(seen.find(m => m.role === 'user')?.content, content);
  assert.equal((store.history(OWNER, 'family')[0].data as any).message.name, undefined);
});
test('记忆工具按当前 agent 身份执行，并正确累计多轮用量', async t => {
  let calls = 0; let store: FamilyStore;
  const fixtureResult = fixture(t, async () => {
    calls++;
    if (calls === 1) return completion('', [call('family_append', { text: '用户喜欢用醋', visibility: 'shared', kind: 'fact', sources: [store.history(OWNER, 'family')[0].id] })]);
    return completion('记下了，这是候选认识。');
  }); store = fixtureResult.store;
  const result = await fixtureResult.gateway.chat(body('记住，我喜欢用醋'), 'family', 'one');
  assert.equal(calls, 2); assert.equal(result.usage.prompt_tokens, 20);
  const memory = store.memories(OWNER, 'family')[0]; assert.equal(memory.authorId, 'korax'); assert.equal(memory.status, 'candidate');
});
test('HTTP 首片在模型完成前发出；普通聊天只有一次回答模型调用', async t => {
  let finish!: () => void; let calls = 0;
  const pending = new Promise<void>(r => { finish = r; });
  const { store, gateway } = fixture(t, async (_m, _t, _model, delta) => { calls++; delta?.('第一片'); await pending; delta?.('第二片'); return completion('第一片第二片'); });
  const server = createFamilyServer(store, gateway, 'test-token-long-enough'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { finish(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: 'Bearer test-token-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body('普通聊天'), stream: true }) });
  const reader = response.body!.getReader(); const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /第一片/); assert.equal(calls, 1);
  finish(); let tail = ''; for (;;) { const part = await reader.read(); if (part.done) break; tail += new TextDecoder().decode(part.value); }
  assert.match(tail, /第二片/); assert.match(tail, /\[DONE\]/);
});
test('模型伪造 ownerId 的写入被工具回路拒绝', async t => {
  let calls = 0; const { store, gateway } = fixture(t, async () => ++calls === 1 ? completion('', [call('family_append', { ownerId: 'kirishima', text: '伪造', visibility: 'private', sources: ['x'] })]) : completion('已拒绝')); 
  await gateway.chat(body('聊天'), 'family', 'one'); assert.equal(store.memories(OWNER, 'family').length, 0);
  assert.ok(store.history(K, 'family').some(e => JSON.stringify(e.data).includes('identity_spoofing')));
});
test('客户端工具回交与续轮；执行归客户端，结果 ID 必须匹配', async t => {
  let n = 0; const { store, gateway } = fixture(t, async () => ++n === 1 ? completion('', [call('calendar_list', {})]) : completion('今天没有日程'));
  const tools = [{ type: 'function' as const, function: { name: 'calendar_list', description: '日历', parameters: {} } }];
  const first = await gateway.chat({ ...body('今天的日程'), tools }, 'family', 'one');
  assert.equal(first.choices[0].finish_reason, 'tool_calls'); assert.equal(n, 1);
  await assert.rejects(gateway.chat({ messages: [{ role: 'user', content: '今天的日程' }, { role: 'tool', tool_call_id: 'forged', content: '假结果' }], tools }, 'family', 'one'), /匹配/);
  const next = await gateway.chat({ messages: [{ role: 'user', content: '今天的日程' }, { role: 'tool', tool_call_id: 'call-one', content: '[]' }], tools }, 'family', 'one');
  assert.equal(next.choices[0].message.content, '今天没有日程');
  assert.equal(store.history(OWNER, 'family').filter(e => (e.data as any).message?.role === 'user').length, 1);
});
test('已被换下成员的工具结果不能冒充新成员续轮', async t => {
  let n = 0; const { gateway } = fixture(t, async () => ++n === 1 ? completion('', [call('calendar_list', {})]) : completion('接话'));
  const tools = [{ type: 'function' as const, function: { name: 'calendar_list', description: '日历', parameters: {} } }];
  await gateway.chat({ ...body('看日程'), tools }, 'family', 'one');
  await gateway.chat(body('让雾岛纪来'), 'family', 'two');
  await assert.rejects(gateway.chat({ messages: [{ role: 'user', content: '看日程' }, { role: 'tool', content: '[]', tool_call_id: 'call-one' }], tools }, 'family', 'one'), /没有待回传/);
});
test('历史检索先做权限过滤，通配符作为字面量处理', t => {
  const { store } = fixture(t);
  note(store, 'family', '100% 原文'); note(store, 'family', '普通聊天');
  store.event(K, 'family', 'message', { message: { role: 'tool', content: '100% 私密工具结果' }, privateTo: 'korax' });
  assert.equal(store.searchHistory(W, 'family', '%').length, 1);
  assert.equal(store.searchHistory(K, 'family', '%').length, 2);
});
test('房间权限生效，不能把未加入房间的成员叫进来', async t => {
  const { store, gateway } = fixture(t);
  store.createRoom(OWNER, 'studio', '工作室', ['korax'], 'korax');
  await assert.rejects(gateway.chat(body('让雾岛纪来'), 'studio', 'one'), /不在这个房间/);
  assert.equal(store.room(OWNER, 'studio').activeAgentId, 'korax');
});
test('HTTP 认证、状态、换人和真正的流式分片能串起来', async t => {
  const { store, gateway } = fixture(t, async (_m, _t, _model, delta) => { delta?.('雾岛纪'); delta?.('接话。'); return completion('雾岛纪接话。'); });
  const server = createFamilyServer(store, gateway, 'test-token-long-enough'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const headers = { Authorization: 'Bearer test-token-long-enough', 'Content-Type': 'application/json', 'X-Client-Id': 'phone' };
  const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...body('让雾岛纪来'), stream: true }) });
  const stream = await response.text(); assert.match(stream, /"content":"雾岛纪"/); assert.match(stream, /"content":"接话。"/); assert.match(stream, /\[DONE\]/); assert.match(stream, /"agentId":"kirishima"/);
  const state = await fetch(`${base}/api/state`, { headers }).then(r => r.json()) as any; assert.equal(state.room.activeAgentId, 'kirishima');
  const write = await fetch(`${base}/api/memories`, { method: 'POST', headers, body: JSON.stringify({ visibility: 'shared', kind: 'fact', text: '家庭共同事实' }) });
  assert.equal(write.status, 201); assert.equal((await write.json() as any).status, 'confirmed');
});
