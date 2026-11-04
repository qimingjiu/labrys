import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, ensure } from '../types.ts';

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    const c = Number(ip.split('.')[2]);
    return a === 0 || a === 10 || a === 127 || a === 169 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const words = normalized.slice(7).split(':');
    if (words.length === 2) { const hi = parseInt(words[0], 16), lo = parseInt(words[1], 16); return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return true;
  }
  // Public IPv6 global-unicast space only. This also excludes loopback, link-local and NAT64.
  return !/^[23][a-f0-9]{0,3}:/.test(normalized) || normalized.startsWith('2001:db8:');
}
export type NetworkOptions = { allowPrivateHosts?: string[]; timeoutMs?: number; maxBytes?: number; responseId?: number; binary?: boolean };
export async function safeRequest(input: string, method: string, headers: Record<string, string>, body: unknown, options: NetworkOptions = {}, signal?: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; bytes?: Buffer }> {
  const url = new URL(input); const host = url.hostname.replace(/^\[|\]$/g, '');
  ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 400, 'bad_mcp_url', 'MCP 地址需要无内嵌凭据的 HTTP(S) URL');
  const allow = (options.allowPrivateHosts ?? []).includes(host);
  ensure(url.protocol === 'https:' || allow, 400, 'https_required', 'HTTP 地址需要在服务器明确配置的私有主机名单内');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15000)]) : AbortSignal.timeout(options.timeoutMs ?? 15000);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const cancel = () => reject(new AppError(504, 'mcp_dns_timeout', 'MCP 地址解析取消或超时'));
    if (combined.aborted) { cancel(); return; }
    combined.addEventListener('abort', cancel, { once: true });
    lookup(host, { all: true }).then(resolve, () => reject(new AppError(502, 'mcp_dns_failed', 'MCP 地址解析失败'))).finally(() => combined.removeEventListener('abort', cancel));
  });
  ensure(addresses.length > 0 && (allow || addresses.every(a => !privateAddress(a.address))), 403, 'private_network', '目标地址未获得私有网络访问许可');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method, headers, signal: combined,
      lookup: (_hostname: string, opts: any, cb: any) => opts?.all ? cb(null, [{ address: address.address, family: address.family }]) : cb(null, address.address, address.family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > (options.maxBytes ?? 2_000_000)) { response.destroy(); request.destroy(new Error('MCP response too large')); return; }
        chunks.push(Buffer.from(chunk));
        if (options.responseId !== undefined && String(response.headers['content-type']).includes('text/event-stream')) {
          const text = Buffer.concat(chunks).toString('utf8');
          const frames = text.split(/\r?\n\r?\n/).slice(0, -1);
          for (const frame of frames) {
            try {
              const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
              if (JSON.parse(data).id === options.responseId) { resolve({ status: response.statusCode ?? 500, headers: response.headers, text }); response.destroy(); return; }
            } catch {}
          }
        }
      });
      response.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode ?? 500, headers: response.headers, text: options.binary ? '' : bytes.toString('utf8'), ...(options.binary ? { bytes } : {}) }); });
      response.on('error', reject);
    });
    request.on('error', e => reject(new AppError(502, 'mcp_network', e.name === 'AbortError' ? 'MCP 请求取消或超时' : 'MCP 网络请求失败')));
    if (body !== undefined) request.write(JSON.stringify(body)); request.end();
  });
}
