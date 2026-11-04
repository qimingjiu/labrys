import { readFileSync } from 'node:fs';
import type { Channels, Destination, MediaKind } from './types.ts';
import type { FamilyStore } from '../store.ts';
import { OWNER, ensure } from '../types.ts';

export const EMPTY_CHANNELS: Channels = { accounts: [], destinations: [] };
export function validateChannels(value: any, store: FamilyStore): Channels {
  ensure(value && Array.isArray(value.accounts) && value.accounts.length <= 50 && Array.isArray(value.destinations) && value.destinations.length <= 200, 400, 'bad_channels', '需要 accounts 和 destinations 列表');
  const ids = new Set<string>();
  for (const a of value.accounts) {
    ensure(a && typeof a.id === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(a.id) && !ids.has(a.id) && ['discord', 'telegram', 'onebot', 'openclaw', 'client'].includes(a.platform), 400, 'bad_account', '平台账号 ID 或类型无效'); ids.add(a.id);
    ensure(Array.isArray(a.ownerIds) && a.ownerIds.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length < 150), 400, 'bad_owner_binding', '需要真实平台所有者 ID 列表');
    for (const field of ['tokenRef', 'webhookSecretRef']) ensure(a[field] === undefined || typeof a[field] === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(a[field]), 400, 'bad_channel_secret', '平台凭据需要引用名');
    ensure(!('token' in a) && !('password' in a), 400, 'plaintext_channel_secret', '平台配置不能包含明文令牌');
    ensure(Object.keys(a).every(k => ['id', 'platform', 'tokenRef', 'baseUrl', 'ownerIds', 'inbound', 'webhookSecretRef', 'providerFileRoot', 'channel', 'channelAccountId'].includes(k)), 400, 'bad_account_field', '平台账号包含不支持的字段，密钥只用 tokenRef 引用');
    ensure(a.inbound === undefined || typeof a.inbound === 'boolean', 400, 'bad_account_field', 'inbound 需要布尔值');
    if (a.baseUrl) { const url = new URL(a.baseUrl); ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 400, 'bad_channel_url', '平台地址需要无凭据的 HTTP(S) 地址'); }
    ensure(a.platform !== 'onebot' && a.platform !== 'openclaw' || typeof a.baseUrl === 'string', 400, 'channel_url_required', '协议桥需要配置 baseUrl');
  }
  const aliases = new Map<string, string>(); const destinations = new Set<string>();
  for (const d of value.destinations) {
    ensure(d && typeof d.id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(d.id) && !destinations.has(d.id) && ids.has(d.accountId), 400, 'bad_destination', '目的地 ID 重复或账号不存在'); destinations.add(d.id); store.room(OWNER, d.roomId);
    ensure(Array.isArray(d.aliases) && d.aliases.every((s: unknown) => typeof s === 'string' && s.trim().length > 0 && s.length <= 50), 400, 'bad_destination_alias', '目的地需要有效别名');
    for (const name of [d.id, ...d.aliases]) { const alias = name.normalize('NFKC').toLowerCase(); ensure(!aliases.has(alias) || aliases.get(alias) === d.id, 400, 'ambiguous_destination_alias', '目的地别名重复，请给不同会话起不同名字'); aliases.set(alias, d.id); }
    ensure(Array.isArray(d.capabilities) && d.capabilities.every((c: string) => ['text', 'file', 'voice', 'image'].includes(c)), 400, 'bad_channel_capability', '目的地能力无效');
    ensure(d.target && typeof d.target === 'object' && Object.values(d.target).every(v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\r\n]/.test(v)), 400, 'bad_channel_target', '目的地需要固定平台会话标识');
    const a = value.accounts.find((a: any) => a.id === d.accountId);
    ensure(a.platform !== 'discord' || /^\d+$/.test(d.target.channelId ?? ''), 400, 'bad_channel_target', 'Discord 需要频道/私信频道 ID');
    ensure(a.platform !== 'telegram' || typeof d.target.chatId === 'string' && /^-?\d+$|^@[A-Za-z0-9_]+$/.test(d.target.chatId), 400, 'bad_channel_target', 'TG 需要 chatId');
    ensure(a.platform !== 'onebot' || /^\d+$/.test(d.target.userId ?? d.target.groupId ?? ''), 400, 'bad_channel_target', 'QQ 需要 userId 或 groupId');
    ensure(a.platform !== 'openclaw' || typeof d.target.userId === 'string', 400, 'bad_channel_target', 'OpenClaw 需要固定接收者');
    ensure(d.maxBytes === undefined || Number.isInteger(d.maxBytes) && d.maxBytes > 0 && d.maxBytes <= 25 * 1024 * 1024, 400, 'bad_channel_limit', '目的地文件上限需要在 1 字节到 25 MiB');
  }
  if (value.quietHours) { const q = value.quietHours; ensure(Number.isInteger(q.start) && q.start >= 0 && q.start <= 23 && Number.isInteger(q.end) && q.end >= 0 && q.end <= 23 && typeof q.timeZone === 'string', 400, 'bad_quiet_hours', '勿扰时间需要 0–23 小时和时区'); new Intl.DateTimeFormat('en', { timeZone: q.timeZone }); }
  return JSON.parse(JSON.stringify(value));
}
export function loadChannels(path: string | undefined, store: FamilyStore): Channels { return path ? validateChannels(JSON.parse(readFileSync(path, 'utf8')), store) : structuredClone(EMPTY_CHANNELS); }
export function resolveDestination(config: Channels, input: string): Destination {
  ensure(typeof input === 'string', 400, 'destination_required', '需要明确的发送目的地');
  const key = input.normalize('NFKC').toLowerCase().trim(); const matches = config.destinations.filter(d => [d.id, ...d.aliases].some(n => n.normalize('NFKC').toLowerCase() === key));
  ensure(matches.length === 1, 404, 'destination_not_bound', '没有绑定这个目的地，请先配置账号与会话；不会猜测收件人'); return matches[0];
}
export function mentionedDestinations(config: Channels, text: string): string[] {
  const aliases = config.destinations.flatMap(d => [d.id, ...d.aliases]).map(n => n.normalize('NFKC').toLowerCase());
  const direct = text.replace(/```[\s\S]*?```|`[^`]*`/g, '').normalize('NFKC').toLowerCase().replace(/“[^”]*”|「[^」]*」|"[^"]*"/g, q => aliases.includes(q.slice(1, -1)) ? q.slice(1, -1) : '');
  return config.destinations.filter(d => [d.id, ...d.aliases].some(alias => {
    const name = alias.normalize('NFKC').toLowerCase(); const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return direct.split(/[，,。；;\n]/).some(clause => !negativeClause(clause) && new RegExp(`(?:发(?:送)?(?:到|给|去|在)?|传(?:到|给)|投递(?:到)?|送到|send\\s+(?:it\\s+)?to\\s+)\\s*[“「"']?${escaped}(?![a-z0-9_-])`, 'i').test(clause));
  })).map(d => d.id);
}
export function requestedKind(text: string): MediaKind | undefined { return /语音|voice/i.test(text) ? 'voice' : /文件|附件|file|document/i.test(text) ? 'file' : /图片|照片|image|photo/i.test(text) ? 'image' : undefined; }
export function deliveryKinds(config: Channels, text: string, destinationId?: string): MediaKind[] {
  const kinds = (s: string): MediaKind[] => [ ...(/语音|voice/i.test(s) ? ['voice' as const] : []), ...(/文件|附件|file|document/i.test(s) ? ['file' as const] : []), ...(/图片|照片|image|photo/i.test(s) ? ['image' as const] : []) ];
  const local = destinationId ? text.split(/[，,。；;\n]/).filter(c => mentionedDestinations(config, c).includes(destinationId)).flatMap(kinds) : [];
  const all = kinds(text); return [...new Set(local.length ? local : all.length === 1 ? all : [])];
}
function negativeClause(text: string): boolean { return /不要|不许|禁止|(?:^|你|先|请|千万|还是)别|不(?:再|想|用|要)?(?:发|传|送|做|执行|生成)|怎么|如何|是否|don't|do not|how to/i.test(text); }
export function explicitAction(text: string, verbs: RegExp): boolean {
  const direct = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"/g, '');
  return !/如果|假如|\bif\b|\bunless\b/i.test(direct) && direct.split(/[，,。；;\n]/).some(clause => verbs.test(clause) && !negativeClause(clause));
}
