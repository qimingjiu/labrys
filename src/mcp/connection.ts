import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Connection, Launch, Manifest, Log, McpTool } from './types.ts';
import { safeRequest } from './http.ts';
import type { NetworkOptions } from './http.ts';
import { AppError, ensure } from '../types.ts';
import { lineLogger } from './log.ts';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export class StdioConnection implements Connection {
  child: ChildProcessWithoutNullStreams; next = 1; private buffer = ''; private closed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; cleanup: () => void }>();
  private finish: () => void = () => {};
  constructor(launch: Launch, log: Log, onChanged: () => void = () => {}, onExit: () => void = () => {}) {
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = () => {
      if (this.closed) return; this.closed = true;
      // A dead protocol parent must not leave unmanaged browser/helper descendants behind.
      if (process.platform !== 'win32' && this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
      for (const waiter of this.pending.values()) { waiter.cleanup(); waiter.reject(new AppError(502, 'mcp_exited', 'MCP 子进程已退出')); }
      this.pending.clear(); onExit();
    };
    this.finish = fail;
    this.child.on('error', e => { log(`启动失败：${e.name}`); fail(); }); this.child.on('exit', fail);
    this.child.stdin.on('error', fail);
    const stderr = lineLogger(log);
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', data => stderr.write(String(data))); this.child.stderr.on('end', () => stderr.end());
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', data => {
      this.buffer += data;
      if (this.buffer.length > 2_000_000) { log('MCP 标准输出超过限制'); void this.close(); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary + 1);
        if (!line) continue;
        let message: any; try { message = JSON.parse(line); } catch { log('MCP 标准输出包含非协议文本'); continue; }
        if (message.method) {
          if (message.method === 'notifications/tools/list_changed') onChanged();
          if (message.id !== undefined) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client capability not supported' } }) }) + '\n');
          continue;
        }
        const waiter = this.pending.get(message.id); if (!waiter) continue;
        this.pending.delete(message.id); waiter.cleanup();
        if (message.error) waiter.reject(new AppError(502, 'mcp_rpc_error', `MCP 协议错误 ${Number(message.error.code) || 0}`));
        else waiter.resolve(message.result);
      }
    });
  }
  async request(method: string, params: unknown = {}, signal?: AbortSignal): Promise<any> {
    ensure(!this.closed, 502, 'mcp_closed', 'MCP 连接已关闭');
    const id = this.next++; const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id); deadline.removeEventListener('abort', cancel);
        void this.notify('notifications/cancelled', { requestId: id, reason: 'request cancelled or timed out' }).catch(() => {});
        reject(new AppError(504, 'mcp_timeout', 'MCP 调用取消或超时；未自动重试'));
      };
      if (deadline.aborted) { cancel(); return; }
      this.pending.set(id, { resolve, reject, cleanup: () => deadline.removeEventListener('abort', cancel) }); deadline.addEventListener('abort', cancel, { once: true });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    try { child.stdin.end(); } catch {}
    const kill = (signal: NodeJS.Signals) => { try { process.platform !== 'win32' && child.pid ? process.kill(-child.pid, signal) : child.kill(signal); } catch {} };
    kill('SIGTERM');
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { kill('SIGKILL'); resolve(); }, 1000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.finish();
  }
}

export class HttpConnection implements Connection {
  url: string; headers: Record<string, string>; options: NetworkOptions; next = 1; session = ''; protocol = '2025-11-25'; changed: () => void;
  constructor(url: string, headers: Record<string, string>, options: NetworkOptions, changed: () => void = () => {}) { this.url = url; this.headers = headers; this.options = options; this.changed = changed; }
  async request(method: string, params: any = {}, signal?: AbortSignal): Promise<any> {
    const id = this.next++;
    const response = await safeRequest(this.url, 'POST', this.requestHeaders(), { jsonrpc: '2.0', id, method, params }, { ...this.options, responseId: id }, signal);
    if (response.status === 401 || response.status === 403) throw new AppError(409, 'mcp_auth_required', `MCP 需要授权或凭据权限不足（HTTP ${response.status}）`);
    ensure(response.status === 200, 502, 'mcp_http_error', `MCP 返回 HTTP ${response.status}；未自动重试`);
    const session = response.headers['mcp-session-id'];
    if (typeof session === 'string') { ensure(session.length <= 256 && /^[\x21-\x7e]+$/.test(session), 502, 'bad_mcp_session', 'MCP 会话标识无效'); this.session = session; }
    let messages: any[];
    if (String(response.headers['content-type']).includes('text/event-stream')) {
      messages = response.text.split(/\r?\n\r?\n/).filter(Boolean).flatMap(frame => {
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        try { return [JSON.parse(data)]; } catch { return []; }
      });
    } else { try { messages = [JSON.parse(response.text)]; } catch { throw new AppError(502, 'bad_mcp_json', 'MCP 返回的内容不是 JSON'); } }
    for (const m of messages) if (m.method === 'notifications/tools/list_changed') this.changed();
    const message = messages.find(m => m.id === id);
    ensure(message, 502, 'missing_mcp_response', 'MCP 没有返回匹配的请求结果');
    ensure(!message.error, 502, 'mcp_rpc_error', `MCP 协议错误 ${Number(message.error?.code) || 0}`);
    return message.result;
  }
  private requestHeaders(): Record<string, string> {
    return { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocol, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) };
  }
  async notify(method: string, params?: unknown): Promise<void> {
    const response = await safeRequest(this.url, 'POST', this.requestHeaders(), { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, this.options);
    ensure(response.status === 202 || response.status === 204 || response.status === 200, 502, 'mcp_notification_failed', 'MCP 初始化通知失败');
  }
  async close(): Promise<void> { if (this.session) { try { await safeRequest(this.url, 'DELETE', this.requestHeaders(), undefined, { ...this.options, timeoutMs: 2000 }); } catch {} this.session = ''; } }
}

export async function initialize(connection: Connection, manifest: Manifest): Promise<void> {
  if (manifest.protocol === '2026-07-28') { if (connection instanceof HttpConnection) connection.protocol = '2026-07-28'; return; }
  const result = await connection.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'labrys', version: '0.1.0' } });
  ensure(VERSIONS.includes(result?.protocolVersion), 502, 'unsupported_mcp_protocol', '服务返回了不支持的 MCP 协议版本');
  if (connection instanceof HttpConnection) connection.protocol = result.protocolVersion;
  await connection.notify('notifications/initialized');
}
export function rpcParams(manifest: Manifest, params: Record<string, unknown>): Record<string, unknown> {
  return manifest.protocol !== '2026-07-28' ? params : { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'labrys', version: '0.1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } };
}
export async function listTools(connection: Connection, manifest: Manifest): Promise<McpTool[]> {
  const tools: McpTool[] = []; let cursor: string | undefined; const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const result = await connection.request('tools/list', rpcParams(manifest, cursor ? { cursor } : {}));
    ensure(Array.isArray(result?.tools), 502, 'bad_mcp_tools', 'MCP 没有返回工具列表');
    for (const tool of result.tools) {
      ensure(typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 200 && !seen.has(tool.name), 502, 'bad_mcp_tool', 'MCP 工具名无效或重复');
      ensure(tool.inputSchema === undefined || tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema), 502, 'bad_mcp_schema', 'MCP 工具 schema 无效');
      seen.add(tool.name); tools.push({ name: tool.name, description: String(tool.description ?? '').slice(0, 1000), inputSchema: tool.inputSchema ?? { type: 'object', properties: {} } });
    }
    ensure(tools.length <= 200, 502, 'too_many_mcp_tools', '单个 MCP 超过 200 个工具，请配置更小的工具集');
    if (!result.nextCursor) return tools;
    ensure(typeof result.nextCursor === 'string' && result.nextCursor !== cursor && result.nextCursor.length <= 2000, 502, 'bad_mcp_cursor', 'MCP 工具分页游标无效'); cursor = result.nextCursor;
  }
  throw new AppError(502, 'mcp_page_limit', 'MCP 工具分页超过限制');
}
