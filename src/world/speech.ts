import { ensure } from '../types.ts';
import type { Actor } from '../types.ts';
import type { Workspaces } from './artifacts.ts';
export type SpeechOptions = { url: string; key: string; model: string; voices: Record<string, string>; allowHttpHosts?: string[] };
export class Speech {
  workspaces: Workspaces; options?: SpeechOptions;
  constructor(workspaces: Workspaces, options?: SpeechOptions) { this.workspaces = workspaces; this.options = options; }
  async generate(actor: Actor, roomId: string, text: string, signal?: AbortSignal) {
    const o = this.options; ensure(o && o.url && o.model && o.voices[actor.id], 409, 'speech_not_configured', '请先配置语音服务和这个成员的音色，也可以转发已有音频');
    ensure(typeof text === 'string' && text.length > 0 && text.length <= 4000, 400, 'bad_speech_text', '单次朗读需要 1–4000 字符');
    const url = new URL(o.url); ensure(url.protocol === 'https:' || url.protocol === 'http:' && o.allowHttpHosts?.includes(url.hostname), 400, 'speech_https_required', '语音服务 HTTP 主机需要明确允许');
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}) }, body: JSON.stringify({ model: o.model, voice: o.voices[actor.id], input: text, response_format: 'wav' }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]) });
    ensure(response.ok, 502, 'speech_provider_failed', `语音服务返回 HTTP ${response.status}`);
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 25 * 1024 * 1024) { await reader.cancel(); ensure(false, 413, 'speech_too_large', '语音服务返回的音频过大'); } chunks.push(part.value); }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]; ensure(mime.startsWith('audio/'), 502, 'speech_bad_audio', '语音服务没有返回音频');
    return this.workspaces.create(actor, roomId, { name: 'speech.wav', mime, bytes: Buffer.concat(chunks) }, false);
  }
}
