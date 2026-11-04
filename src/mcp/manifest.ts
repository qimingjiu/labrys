import type { Manifest } from './types.ts';
import { ensure } from '../types.ts';
import type { FamilyStore } from '../store.ts';
import { OWNER } from '../types.ts';

export function validateManifest(input: any, store: FamilyStore): Manifest {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 400, 'bad_manifest', '需要 MCP 安装清单');
  const accepted = new Set(['id', 'kind', 'package', 'version', 'executable', 'module', 'image', 'url', 'args', 'protocol', 'env', 'secretEnv', 'secretHeaders', 'allowedAgents', 'allowedRooms', 'allowedTools']);
  ensure(Object.keys(input).every(k => accepted.has(k)), 400, 'unknown_manifest_field', '清单包含不支持的字段；不能传 shell/command/path');
  ensure(typeof input.id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(input.id), 400, 'bad_mcp_id', 'MCP ID 需要字母开头，最多 32 字符');
  ensure(['npm', 'python', 'docker', 'remote'].includes(input.kind), 400, 'bad_mcp_kind', '支持 npm/python/docker/remote');
  ensure(Array.isArray(input.allowedAgents) && input.allowedAgents.length > 0 && input.allowedAgents.length <= 50, 400, 'agents_required', '需要指定可用成员'); input.allowedAgents.forEach((id: string) => store.agent(id));
  ensure(Array.isArray(input.allowedRooms) && input.allowedRooms.length > 0 && input.allowedRooms.length <= 50, 400, 'rooms_required', '需要指定可用房间'); input.allowedRooms.forEach((id: string) => store.room(OWNER, id));
  for (const roomId of input.allowedRooms) ensure(input.allowedAgents.some((id: string) => store.room(OWNER, roomId).members.includes(id)), 400, 'bad_mcp_scope', '目标房间中没有指定成员');
  ensure(!input.args || Array.isArray(input.args) && input.args.length <= 32 && input.args.every((v: unknown) => typeof v === 'string' && v.length <= 1000 && !/[\r\n\0]/.test(v)), 400, 'bad_mcp_args', '启动参数无效');
  ensure(!input.protocol || ['2025-11-25', '2026-07-28'].includes(input.protocol), 400, 'bad_mcp_protocol', 'MCP 协议版本无效');
  if (input.kind === 'npm' || input.kind === 'python') {
    ensure(typeof input.package === 'string' && (input.kind === 'npm' ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(input.package) : /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(input.package)), 400, 'bad_mcp_package', '需要明确的包名，不能使用 URL、路径或安装命令');
    ensure(typeof input.version === 'string' && /^\d+\.\d+(?:\.\d+)?(?:[-+a-zA-Z0-9.]+)?$/.test(input.version) && input.version.length <= 64, 400, 'version_required', '需要固定版本号');
  }
  if (input.executable) ensure(/^[a-zA-Z0-9_-]{1,100}$/.test(input.executable), 400, 'bad_executable', '启动入口需要包内可执行名称');
  if (input.module) ensure(input.kind === 'python' && /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/.test(input.module), 400, 'bad_module', 'Python 模块名无效');
  if (input.kind === 'docker') ensure(typeof input.image === 'string' && input.image.length <= 250 && /^[a-z0-9][a-z0-9./:_@-]+$/.test(input.image) && (/@sha256:[a-f0-9]{64}$/.test(input.image) || /:[a-zA-Z0-9_.-]+$/.test(input.image) && !/:latest$/.test(input.image)), 400, 'image_version_required', 'Docker 镜像需要明确标签或 digest');
  if (input.kind === 'remote') {
    let url: URL | undefined; try { url = new URL(input.url); } catch {}
    ensure(url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(k => /token|key|secret|password/i.test(k)), 400, 'bad_mcp_url', '远程 URL 无效；凭据通过引用注入请求头');
  }
  const forbidden = /^(?:PATH|HOME|SHELL|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|NPM_CONFIG_.*)$/i;
  for (const section of ['env', 'secretEnv'] as const) {
    ensure(!input[section] || input[section] && typeof input[section] === 'object' && !Array.isArray(input[section]) && Object.keys(input[section]).length <= 40, 400, 'bad_mcp_environment', '环境配置无效');
    for (const [key, value] of Object.entries(input[section] ?? {})) {
      ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !forbidden.test(key) && typeof value === 'string' && value.length <= 4000 && !/[\r\n\0]/.test(value), 400, 'bad_mcp_environment', '环境名称或值无效');
      if (section === 'env') ensure(!/TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|AUTH/i.test(key), 400, 'secret_reference_required', '凭据需要放在 secretEnv 中引用');
      else ensure(/^[a-z][a-z0-9_-]{0,63}$/.test(value), 400, 'bad_secret_ref', '凭据引用无效');
    }
  }
  ensure(!input.secretHeaders || input.kind === 'remote' && typeof input.secretHeaders === 'object' && !Array.isArray(input.secretHeaders) && Object.keys(input.secretHeaders).length <= 40, 400, 'bad_mcp_headers', '请求头只适用于远程 MCP，且必须是引用对象');
  for (const [key, ref] of Object.entries(input.secretHeaders ?? {})) ensure(/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(key) && !/^(host|content-length|content-type|connection|accept|mcp-.*)$/i.test(key) && typeof ref === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(ref), 400, 'bad_mcp_headers', '请求头或凭据引用无效');
  ensure(!input.allowedTools || Array.isArray(input.allowedTools) && input.allowedTools.every((v: unknown) => typeof v === 'string' && v.length <= 200), 400, 'bad_tool_allowlist', '工具白名单无效');
  return JSON.parse(JSON.stringify(input));
}
