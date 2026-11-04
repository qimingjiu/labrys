import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openAIProvider, normalizeUsage } from '../src/provider.ts';

async function mock(t: any, frames: string[]) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(frames.join(''));
    // Split in the middle of UTF-8 bytes and SSE delimiters, including the last unterminated frame.
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7)); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { generate: openAIProvider(`http://127.0.0.1:${(server.address() as any).port}/v1`, '', 'test-model'), requests };
}
const frame = (data: any, end = '\r\n\r\n') => `data: ${JSON.stringify(data)}${end}`;
test('上游 SSE 解析保留中文 UTF-8、usage 和无空行尾帧；按分片直接外发', async t => {
  const { generate, requests } = await mock(t, [frame({ choices: [{ delta: { content: '你好😈' } }] }), frame({ choices: [{ delta: { content: '，妁妁。' }, finish_reason: 'stop' }] }), frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } }), 'data: [DONE]']);
  const parts: string[] = []; const result = await generate([{ role: 'user', content: 'hello' }], [], '', text => parts.push(text));
  assert.deepEqual(parts, ['你好😈', '，妁妁。']); assert.equal(result.content, parts.join('')); assert.equal(result.usage.prompt_tokens, 4);
  assert.equal(requests[0].stream, true); assert.equal(requests[0].model, 'test-model');
});
test('工具调用参数跨 SSE 帧重组，工具调用不伪装成文本输出', async t => {
  const { generate } = await mock(t, [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'family_', arguments: '{"query":' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '"醋"}' } }] }, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n',
  ]);
  const result = await generate([{ role: 'user', content: '回忆' }], [], '', () => {});
  assert.equal(result.toolCalls[0].function.name, 'family_read'); assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { query: '醋' });
});
test('流中断缺少完成帧，会作为失败处理', async t => {
  const { generate } = await mock(t, [frame({ choices: [{ delta: { content: '一半的回复' } }] })]);
  await assert.rejects(generate([{ role: 'user', content: 'hi' }], [], '', () => {}), /完成帧/);
});
test('显式 OpenAI 缓存键按模型隔离，自动模式不发送未知缓存参数', async t => {
  const { generate, requests } = await mock(t, [frame({ choices: [{ delta: { content: '接话' }, finish_reason: 'stop' }] }), frame({ choices: [], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 768 } } }), 'data: [DONE]\n\n']);
  const messages = [{ role: 'user' as const, content: '接话' }];
  const options = { cache: { mode: 'openai' as const, key: 'same-household-scope' } };
  for (let i = 0; i < 2; i++) { const r = await generate(messages, [], 'model-one', () => {}, undefined, options); assert.equal(r.usage.cached_tokens, 768); }
  await generate(messages, [], 'model-two', () => {}, undefined, options);
  await generate(messages, [], 'model-one', () => {}, undefined, { cache: { mode: 'automatic', key: 'same-household-scope' } });
  assert.equal(requests[0].prompt_cache_key, requests[1].prompt_cache_key); assert.notEqual(requests[0].prompt_cache_key, requests[2].prompt_cache_key);
  assert.equal(requests[3].prompt_cache_key, undefined); assert.equal(requests[3].cache, undefined);
});
test('不同供应商缓存用量归一化，缺失用量保持未知', () => {
  assert.equal(normalizeUsage({ prompt_tokens_details: { cached_tokens: 123 } }).cached_tokens, 123);
  assert.equal(normalizeUsage({ prompt_cache_hit_tokens: 456 }).cached_tokens, 456);
  assert.equal(normalizeUsage({ cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }).cache_write_tokens, 8);
  assert.equal(normalizeUsage({ prompt_tokens_details: { cache_write_tokens: 123 } }).cache_write_tokens, 123);
  assert.equal(normalizeUsage({ prompt_tokens: 50 }).cached_tokens, undefined);
});
