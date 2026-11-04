import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, ensure } from '../types.ts';
import type { Actor } from '../types.ts';
import { cleanEnvironment } from '../mcp/runner.ts';
import type { Workspaces } from './artifacts.ts';
import type { Artifact } from './types.ts';

async function ffmpeg(args: string[], cwd: string, signal?: AbortSignal, maxBytes = 12_000_000): Promise<Buffer> {
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', ...args], { cwd, env: cleanEnvironment(cwd), shell: false, stdio: ['ignore', 'pipe', 'ignore'], signal: combined });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on('data', c => { size += c.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(c); });
    child.on('error', e => reject(new AppError(409, 'ffmpeg_unavailable', e.name === 'AbortError' ? '语音转换取消或超时' : '需要安装系统 ffmpeg')));
    child.on('close', code => code === 0 && size <= maxBytes ? resolve(Buffer.concat(chunks)) : reject(new AppError(422, 'invalid_audio', '无法转换音频，或语音超过十分钟限制')));
  });
}
export class VoiceMedia {
  workspaces: Workspaces; private pending = new Map<string, Promise<Artifact>>();
  constructor(workspaces: Workspaces) { this.workspaces = workspaces; }
  async prepare(actor: Actor, roomId: string, id: string, signal?: AbortSignal): Promise<Artifact> {
    const source = this.workspaces.get(actor, id, roomId);
    ensure(source.mime.startsWith('audio/'), 400, 'voice_requires_audio', '语音需要音频文件');
    if (source.voice && source.mime === 'audio/ogg') return source;
    const key = JSON.stringify([actor.id, roomId, id]); const hit = this.pending.get(key); if (hit) return hit;
    const operation = this.convert(actor, roomId, source, signal); this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }
  private async convert(actor: Actor, roomId: string, source: Artifact, signal?: AbortSignal): Promise<Artifact> {
    const tmp = join(this.workspaces.root, 'media-tmp'); await mkdir(tmp, { recursive: true, mode: 0o700 }); const directory = await mkdtemp(join(tmp, 'voice-'));
    try {
      const input = join(directory, 'input'); const output = join(directory, 'voice.ogg'); await writeFile(input, await this.workspaces.bytes(actor, source.id, roomId));
      await ffmpeg(['-y', '-i', input, '-t', '601', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', output], directory, signal);
      const pcm = await ffmpeg(['-i', output, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], directory, signal);
      const samples = Math.floor(pcm.length / 2), duration = samples / 8000; ensure(duration > 0 && duration <= 600, 413, 'voice_too_long', '单条语音需要小于十分钟，请先拆分');
      const peaks = Array.from({ length: 256 }, (_, bin) => { const start = Math.floor(samples * bin / 256), end = Math.floor(samples * (bin + 1) / 256); let total = 0; for (let i = start; i < end; i++) { const sample = pcm.readInt16LE(i * 2); total += sample * sample; } return Math.sqrt(total / Math.max(1, end - start)); });
      const maximum = Math.max(1, ...peaks); const waveform = Buffer.from(peaks.map(p => Math.round(255 * p / maximum))).toString('base64');
      return await this.workspaces.create(actor, roomId, { name: source.name.replace(/\.[^/.]+$/, '') + '.ogg', mime: 'audio/ogg', bytes: await readFile(output), ownerId: source.ownerId, parentId: source.id, voice: { duration: Math.round(duration * 1000) / 1000, waveform } }, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
