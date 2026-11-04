import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import type { Config } from '../src/types.ts';
import { OWNER } from '../src/types.ts';

const template: Config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const clients = ['tg', 'wechat-clawbot', 'qq', 'chat-client', 'discord'];
const quantile = (values: number[], p: number) => +values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(3);
const dir = mkdtempSync(join(tmpdir(), 'family-cache-bench-'));
const result: any[] = [];
try {
  for (const enabled of [false, true]) {
    const config = structuredClone(template); config.cache = { ...config.cache, enabled };
    const store = new FamilyStore(join(dir, `${enabled}.sqlite`), config);
    try {
      for (let i = 0; i < 150; i++) {
        store.event(OWNER, 'family', 'message', { message: { role: 'user', content: `过去第${i}轮的用户原文。${'保留原始表达和标点。'.repeat(30)}` } });
        store.event({ kind: 'agent', id: 'korax' }, 'family', 'message', { message: { role: 'assistant', content: `过去第${i}轮的回复。${'这是历史中的原始回复。'.repeat(30)}` }, agentId: 'korax' });
      }
      let calls = 0;
      const gateway = new FamilyGateway(store, config, async (_m, _t, _model, delta) => { calls++; delta?.('本地模拟回复'); return { content: '本地模拟回复', toolCalls: [], usage: {}, finishReason: 'stop' }; });
      const first: number[] = [], total: number[] = [];
      for (let i = 0; i < 110; i++) {
        const r = await gateway.chat({ messages: [{ role: 'user', content: `跨端第${i}次继续说话。` }] }, 'family', clients[i % clients.length], () => {});
        if (i >= 10) { first.push(r.family.firstTokenMs); total.push(r.family.totalMs); }
      }
      result.push({ cacheEnabled: enabled, measuredRequests: 100, warmupRequests: 10, firstTextMs: { p50: quantile(first, .5), p95: quantile(first, .95) }, totalMs: { p50: quantile(total, .5), p95: quantile(total, .95) }, modelCalls: calls, cache: gateway.cache.stats() });
    } finally { store.close(); }
  }
  console.log(JSON.stringify({ node: process.version, kind: 'Local disk-backed gateway overhead; simulated immediate model; not vendor/network latency', result }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
