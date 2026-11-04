import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Workspaces } from './artifacts.ts';
import type { Account, Destination, Outgoing, SendResult } from './types.ts';
import type { SecretResolver } from '../mcp/types.ts';
import { AppError, ensure } from '../types.ts';

export type AdapterContext = { workspaces: Workspaces; secrets: SecretResolver; sharedDirectory: string; mediaUrl?: (outgoing: Outgoing) => string; allowHttpHosts?: string[] };
export type Adapter = (account: Account, destination: Destination, outgoing: Outgoing, signal?: AbortSignal) => Promise<SendResult>;
async function request(url: string, init: RequestInit, allowed: string[] = []): Promise<{ response: Response; data: any }> {
  const parsed = new URL(url); ensure(parsed.protocol === 'https:' || parsed.protocol === 'http:' && allowed.includes(parsed.hostname), 400, 'channel_https_required', '平台 HTTP 主机需要在 CHANNEL_HTTP_HOSTS 中明确允许');
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30000)]) });
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  if (reader) for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2_000_000) { await reader.cancel(); throw new AppError(502, 'channel_response_too_large', '平台响应过大，投递结果需要核对'); } chunks.push(part.value); }
  let data: any; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { data = null; } return { response, data };
}
export function platformAdapter(ctx: AdapterContext): Adapter {
  return async (account, destination, outgoing, signal) => {
    let token: string | undefined; let data: Buffer | undefined;
    try {
      ensure(account.platform !== 'client', 409, 'client_pull_only', '这个客户端使用收件箱领取，不主动推送媒体');
      token = account.tokenRef ? ctx.secrets.value(account.tokenRef) : undefined;
      if (outgoing.artifactId) data = await ctx.workspaces.bytes(outgoing.actor, outgoing.artifactId, outgoing.roomId);
      ensure(outgoing.kind === 'text' || data, 400, 'artifact_required', '媒体发送需要文件');
    } catch (e) { return { status: 'failed', error: e instanceof AppError ? e.code : 'channel_prepare_failed' }; }
    try {
      let url = '', init: RequestInit; const headers: Record<string, string> = {}; if (token) headers.Authorization = `Bearer ${token}`;
      const artifact = outgoing.artifactId ? ctx.workspaces.get(outgoing.actor, outgoing.artifactId, outgoing.roomId) : undefined;
      if (account.platform === 'telegram') {
        ensure(token, 409, 'channel_token_required', '需要 TG Bot Token');
        const method = outgoing.kind === 'text' ? 'sendMessage' : outgoing.kind === 'voice' ? 'sendVoice' : outgoing.kind === 'image' ? 'sendPhoto' : 'sendDocument';
        url = `${(account.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${token}/${method}`;
        const form = new FormData(); form.set('chat_id', destination.target.chatId!); if (destination.target.threadId) form.set('message_thread_id', destination.target.threadId);
        if (outgoing.kind === 'text') form.set('text', outgoing.text!);
        else { const key = outgoing.kind === 'voice' ? 'voice' : outgoing.kind === 'image' ? 'photo' : 'document'; form.set(key, new Blob([new Uint8Array(data!)], { type: artifact!.mime }), artifact!.name.split('/').at(-1)!); if (outgoing.text) form.set('caption', outgoing.text); }
        init = { method: 'POST', body: form, signal };
      } else if (account.platform === 'discord') {
        ensure(token, 409, 'channel_token_required', '需要 Discord Bot Token');
        url = `${(account.baseUrl ?? 'https://discord.com/api/v10').replace(/\/$/, '')}/channels/${destination.target.channelId}/messages`;
        const payload: any = { allowed_mentions: { parse: [], replied_user: false }, nonce: outgoing.id.replaceAll('-', '').slice(0, 25), enforce_nonce: true };
        headers.Authorization = `Bot ${token}`;
        if (outgoing.kind === 'text') { payload.content = outgoing.text; init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal }; }
        else {
          if (outgoing.kind === 'voice') { ensure(artifact?.voice && artifact.mime === 'audio/ogg', 400, 'voice_not_prepared', 'Discord 语音需要已转换的 Opus 音频与波形'); payload.flags = 8192; }
          else if (outgoing.text) payload.content = outgoing.text;
          payload.attachments = [{ id: 0, filename: artifact!.name.split('/').at(-1), ...(outgoing.kind === 'voice' ? { duration_secs: artifact!.voice!.duration, waveform: artifact!.voice!.waveform } : {}) }];
          const form = new FormData(); form.set('payload_json', JSON.stringify(payload)); form.set('files[0]', new Blob([new Uint8Array(data!)], { type: artifact!.mime }), artifact!.name.split('/').at(-1)!);
          init = { method: 'POST', headers, body: form, signal };
        }
      } else if (account.platform === 'onebot') {
        const group = !!destination.target.groupId; const target = group ? { group_id: destination.target.groupId } : { user_id: destination.target.userId };
        let params: any;
        if (outgoing.kind === 'file') {
          ensure(account.providerFileRoot, 409, 'onebot_shared_directory_required', 'QQ 文件发送需要配置协议端可见的共享目录');
          await mkdir(ctx.sharedDirectory, { recursive: true, mode: 0o700 }); const name = `${outgoing.id}-${artifact!.name.split('/').at(-1)}`;
          await writeFile(join(ctx.sharedDirectory, name), data!, { mode: 0o600 }); params = { ...target, file: posix.join(account.providerFileRoot, name), name: artifact!.name.split('/').at(-1) };
          url = account.baseUrl!.replace(/\/$/, '') + (group ? '/upload_group_file' : '/upload_private_file');
        } else {
          const message: any[] = outgoing.kind === 'text' ? [{ type: 'text', data: { text: outgoing.text } }] : [{ type: outgoing.kind === 'voice' ? 'record' : 'image', data: { file: 'base64://' + data!.toString('base64') } }];
          if (outgoing.kind !== 'text' && outgoing.text) message.unshift({ type: 'text', data: { text: outgoing.text } }); params = { ...target, message }; url = account.baseUrl!.replace(/\/$/, '') + (group ? '/send_group_msg' : '/send_private_msg');
        }
        init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal };
      } else {
        const channel = account.channel ?? 'openclaw-weixin';
        const args: any = { action: 'send', channel, accountId: account.channelAccountId, target: destination.target.userId, ...(outgoing.text ? { message: outgoing.text } : {}) };
        if (outgoing.kind !== 'text') { ensure(ctx.mediaUrl, 409, 'media_public_url_required', 'OpenClaw 媒体交付需要配置网关 PUBLIC_BASE_URL'); args.media = ctx.mediaUrl(outgoing); if (outgoing.kind === 'voice') args.asVoice = true; }
        url = account.baseUrl!.replace(/\/$/, '') + '/tools/invoke'; init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-openclaw-message-channel': channel, 'x-openclaw-message-to': destination.target.userId! }, body: JSON.stringify({ tool: 'message', action: 'send', args }), signal };
      }
      const { response, data: result } = await request(url, init!, ctx.allowHttpHosts);
      if (response.status === 429 || result?.error_code === 429) { const delay = Number(result?.parameters?.retry_after ?? result?.retry_after ?? response.headers.get('retry-after') ?? 5); return { status: 'rate_limited', retryAfterMs: Number.isFinite(delay) ? Math.min(300000, Math.max(1000, delay * 1000)) : 5000, error: 'channel_rate_limited' }; }
      if (!response.ok) return { status: response.status >= 500 ? 'unknown' : 'failed', error: `channel_http_${response.status}` };
      if (account.platform === 'telegram') return result?.ok && result.result?.message_id !== undefined ? { status: 'sent', messageId: String(result.result.message_id) } : { status: result?.ok === false ? 'failed' : 'unknown', error: result?.ok === false ? 'telegram_rejected' : 'telegram_missing_receipt' };
      if (account.platform === 'discord') return typeof result?.id === 'string' ? { status: 'sent', messageId: result.id } : { status: 'unknown', error: 'discord_missing_receipt' };
      if (account.platform === 'onebot') return result?.status === 'ok' && result.retcode === 0 ? { status: 'sent', ...(result.data?.message_id !== undefined ? { messageId: String(result.data.message_id) } : {}) } : { status: result?.status === 'failed' ? 'failed' : 'unknown', error: 'onebot_delivery_unconfirmed' };
      const candidates: any[] = []; let rejected = false;
      const inspect = (v: any, depth = 0) => { if (!v || typeof v !== 'object' || depth > 12) return; if (v.isError || ['failed', 'partial', 'suppressed', 'blocked'].includes(v.deliveryStatus)) rejected = true; if (typeof v.messageId === 'string' || typeof v.message_id === 'string' || ['sent', 'confirmed', 'delivered'].includes(v.deliveryStatus)) candidates.push(v); for (const [key, x] of Object.entries(v)) { if (key === 'text' && typeof x === 'string') { try { inspect(JSON.parse(x), depth + 1); } catch {} } else if (typeof x === 'object') inspect(x, depth + 1); } };
      inspect(result?.result); const receipt = candidates[0];
      return result?.ok && receipt && !rejected ? { status: 'sent', messageId: receipt.messageId ?? receipt.message_id } : { status: 'unknown', error: 'openclaw_delivery_unconfirmed' };
    } catch (e) { return { status: e instanceof AppError ? 'failed' : 'unknown', error: e instanceof AppError ? e.code : 'channel_result_unknown' }; }
  };
}
