import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import { createFamilyServer } from '../src/server.ts';
import { McpManager } from '../src/mcp/manager.ts';
import { PackageRunner, runProcess, cleanEnvironment } from '../src/mcp/runner.ts';
import { validateManifest } from '../src/mcp/manifest.ts';
import { safeRequest } from '../src/mcp/http.ts';
import { lineLogger } from '../src/mcp/log.ts';
import { OWNER } from '../src/types.ts';
import type { Config, Actor, ToolCall } from '../src/types.ts';
import type { Manifest, DeploymentRunner } from '../src/mcp/types.ts';
import type { Generate } from '../src/provider.ts';

const config: Config = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const K: Actor = { kind: 'agent', id: 'korax' }, W: Actor = { kind: 'agent', id: 'kirishima' };
const manifest = (patch: Partial<Manifest> = {}): Manifest => ({ id: 'fixture', kind: 'npm', package: 'family-mcp-fixture', version: '1.0.0', allowedAgents: ['kirishima'], allowedRooms: ['family'], ...patch });
const completion = (content = '收到。', toolCalls: ToolCall[] = []) => ({ content, toolCalls, usage: {}, finishReason: toolCalls.length ? 'tool_calls' : 'stop' });
const call = (name: string, args: unknown, id = 'call-one'): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const body = (content: string) => ({ messages: [{ role: 'user' as const, content }] });
let packages: string; const tarballs = new Map<string, string>();
const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
let changed=false;
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
if(process.env.FIXTURE_TOKEN){const s=process.env.FIXTURE_TOKEN;process.stderr.write(s.slice(0,8));setTimeout(()=>process.stderr.write(s.slice(8)+'\\n'),10)}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='initialize')return reply(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}});
if(m.method==='tools/list'){if(process.argv.includes('--fail'))return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'deliberate'}})+'\\n');return reply(m.id,{tools:[{name:'echo',description:changed?'changed schema':'fixture echo',inputSchema:{type:'object',properties:changed?{after:{type:'string'}}:{text:{type:'string'}}}},{name:'change',inputSchema:{type:'object'}}]})}
if(m.method==='tools/call'){if(m.params.arguments.hang)return;if(m.params.arguments.crash)process.exit(1);if(m.params.name==='change'){changed=true;reply(m.id,{content:[{type:'text',text:'changed'}]});process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})+'\\n');return}
return reply(m.id,{content:[{type:'text',text:m.params.arguments.text||'echo'},{type:'image',mimeType:'image/png',data:'aGVsbG8='}],structuredContent:{secret:process.env.FIXTURE_TOKEN||'',text:m.params.arguments.text||''}})}
reply(m.id,{});
});`;
before(() => {
  packages = mkdtempSync(join(tmpdir(), 'family-mcp-packages-'));
  for (const version of ['1.0.0', '2.0.0']) {
    const dir = join(packages, version); mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'family-mcp-fixture', version, type: 'module', bin: { 'family-mcp-fixture': 'server.js' }, scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'UNSAFE_POSTINSTALL\',\'bad\')"' } }));
    writeFileSync(join(dir, 'server.js'), script);
    execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: dir, env: { ...process.env, npm_config_update_notifier: 'false' }, stdio: 'pipe' });
    tarballs.set(version, join(dir, readdirSync(dir).find(f => f.endsWith('.tgz'))!));
  }
});
after(() => rmSync(packages, { recursive: true, force: true }));
const runner = () => new PackageRunner(m => tarballs.get(m.version!)!);
function fixture(t: any, options: { runner?: DeploymentRunner; file?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'family-mcp-test-'));
  const store = new FamilyStore(options.file ? join(dir, 'db.sqlite') : ':memory:', structuredClone(config));
  const mcp = new McpManager(store, join(dir, 'mcp'), { runner: options.runner ?? runner(), network: { allowPrivateHosts: ['127.0.0.1', 'localhost'] } });
  t.after(async () => { await mcp.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, mcp };
}
async function installed(mcp: McpManager, input = manifest()): Promise<any> { const job: any = mcp.install(input, { roomId: 'family', agentId: 'korax' }); await mcp.drain(); const result: any = mcp.job(job.jobId); assert.equal(result.status, 'succeeded', JSON.stringify(result)); return result; }

test('真实 npm 固定版本安装 → stdio 初始化 → 工具调用；脚本禁用，成员/房间权限生效', async t => {
  const { mcp, dir } = fixture(t); await installed(mcp);
  const tools = mcp.toolsFor(W, 'family'); assert.equal(tools.length, 2); assert.equal(mcp.toolsFor(K, 'family').length, 0);
  assert.equal(mcp.toolsFor(W, 'private-kirishima').length, 0);
  const result: any = await mcp.call(tools.find(t => t.originalName === 'echo')!.function.name, { text: '手机上的原文' }, W, 'family');
  assert.match(JSON.stringify(result.value), /手机上的原文/); assert.equal(result.attachments.length, 1);
  await assert.rejects(mcp.call(tools[0].function.name, {}, K, 'family'), /未注册/);
  const versions = readdirSync(join(dir, 'mcp', 'services', 'fixture'));
  assert.ok(!existsSync(join(dir, 'mcp', 'services', 'fixture', versions[0], 'node_modules', 'family-mcp-fixture', 'UNSAFE_POSTINSTALL')));
});
test('后台安装立即返回 jobId；安装未完成时聊天可用，未检查通过的工具不可见', async t => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); const delegate = runner();
  const { store, mcp } = fixture(t, { runner: { deploy: async (...args) => { await gate; return delegate.deploy(...args); } } }); t.after(() => release());
  let calls = 0;
  const gateway = new FamilyGateway(store, config, async () => ++calls === 1 ? completion('', [call('mcp_install', { manifest: manifest() })]) : completion('还能聊天'), mcp);
  await gateway.chat(body('安装这个 MCP，只给雾岛纪用'), 'family', 'tg');
  const response: any = store.history(K, 'family').find(e => (e.data as any).message?.role === 'tool');
  const job = JSON.parse(response.data.message.content); await new Promise(r => setImmediate(r));
  assert.equal((mcp.job(job.jobId) as any).status, 'running'); assert.equal(mcp.toolsFor(W, 'family').length, 0);
  assert.equal((await gateway.chat(body('聊天'), 'family', 'tg')).choices[0].message.content, '还能聊天');
  release(); await mcp.drain(); assert.equal((mcp.job(job.jobId) as any).status, 'succeeded');
});
test('MCP 调用取消不会自动重试；进程退出使工具下线，重启后恢复', async t => {
  const { mcp } = fixture(t); await installed(mcp); const name = mcp.toolsFor(W, 'family').find(t => t.originalName === 'echo')!.function.name;
  await assert.rejects(mcp.call(name, { hang: true }, W, 'family', AbortSignal.timeout(30)), /取消或超时/);
  await assert.rejects(mcp.call(name, { crash: true }, W, 'family'), /退出/);
  assert.equal(mcp.toolsFor(W, 'family').length, 0); assert.equal((mcp.list()[0] as any).status, 'error');
  const job: any = mcp.manage('fixture', 'restart', { roomId: 'family' }); await mcp.drain(); assert.equal((mcp.job(job.jobId) as any).status, 'succeeded'); assert.equal(mcp.toolsFor(W, 'family').length, 2);
});
test('失败更新保留旧版本与连接；成功后切换版本，重复提交不重复安装', async t => {
  const { mcp } = fixture(t); await installed(mcp);
  const next = manifest({ version: '2.0.0', args: ['--fail'] }); const job: any = mcp.manage('fixture', 'update', { roomId: 'family' }, next);
  const duplicate: any = mcp.manage('fixture', 'update', { roomId: 'family' }, next); assert.equal(duplicate.jobId, job.jobId);
  await mcp.drain(); assert.equal((mcp.job(job.jobId) as any).status, 'failed'); assert.equal((mcp.list()[0] as any).manifest.version, '1.0.0');
  assert.equal((mcp.list()[0] as any).status, 'ready'); await mcp.call(mcp.toolsFor(W, 'family')[0].function.name, {}, W, 'family');
  await installed(mcp, manifest({ version: '2.0.0' })); assert.equal((mcp.list()[0] as any).manifest.version, '2.0.0');
  assert.equal((mcp.install(manifest({ version: '2.0.0' }), { roomId: 'family' }) as any).reused, true);
});
test('停止/启动/重启/卸载有任务记录；卸载不删除凭据', async t => {
  const { mcp, dir } = fixture(t); await installed(mcp); mcp.vault.put('retained', 'keep-this-secret');
  for (const action of ['stop', 'start', 'restart', 'uninstall']) {
    const j: any = mcp.manage('fixture', action, { roomId: 'family' }); await mcp.drain(); assert.equal((mcp.job(j.jobId) as any).status, 'succeeded');
    if (action === 'stop') { assert.equal(mcp.toolsFor(W, 'family').length, 0); assert.equal((mcp.list()[0] as any).enabled, false); }
  }
  assert.equal(mcp.list().length, 0); assert.ok(!existsSync(join(dir, 'mcp', 'services', 'fixture'))); assert.equal(mcp.vault.value('retained'), 'keep-this-secret');
});
test('缺少凭据进入 awaiting_input；补充后重试，密钥不进入明文数据库、日志和模型工具结果', async t => {
  const { mcp, store } = fixture(t); const input = manifest({ secretEnv: { FIXTURE_TOKEN: 'fixture-token' } });
  const missing: any = mcp.install(input, { roomId: 'family', agentId: 'korax' }); await mcp.drain();
  assert.equal((mcp.job(missing.jobId) as any).status, 'awaiting_input'); assert.match((mcp.job(missing.jobId) as any).settingsUrl, /job=/);
  const secret = 'secret-sentinel-split-729582'; mcp.vault.put('fixture-token', secret); await installed(mcp, input);
  const result = await mcp.call(mcp.toolsFor(W, 'family').find(t => t.originalName === 'echo')!.function.name, {}, W, 'family');
  assert.ok(!JSON.stringify(result).includes(secret)); assert.match(JSON.stringify(result), /REDACTED/);
  await new Promise(r => setTimeout(r, 30));
  for (const table of ['mcp_services', 'mcp_jobs', 'mcp_logs', 'mcp_secrets', 'events']) assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM ' + table).all()).includes(secret), table);
  assert.ok(!JSON.stringify(mcp.logs('fixture')).includes(secret)); assert.match(JSON.stringify(mcp.logs('fixture')), /REDACTED/);
});
test('MCP 返回图片走响应附件，工具结果留在当前成员；服务工具由服务器执行', async t => {
  const { mcp, store } = fixture(t); await installed(mcp); let n = 0; let toolName = '';
  const gateway = new FamilyGateway(store, config, async (messages, tools) => {
    if (++n === 1) { toolName = tools.find(t => t.function.name.startsWith('mcp_fixture_') && t.function.description.includes('echo'))!.function.name; return completion('', [call(toolName, { text: '原地调用' })]); }
    assert.match(JSON.stringify(messages), /原地调用/); assert.ok(!JSON.stringify(messages).includes('aGVsbG8=')); return completion('完成');
  }, mcp);
  const result = await gateway.chat(body('让雾岛纪来'), 'family', 'wechat'); assert.equal(n, 2); assert.equal(result.attachments.length, 1); assert.equal(store.pending('family'), null);
  assert.ok(store.history(W, 'family').some(e => JSON.stringify(e.data).includes(toolName)));
  assert.ok(!store.history(K, 'family').some(e => JSON.stringify(e.data).includes(toolName)));
});
test('聊天安装需要真实本轮用户指令，忽略模型冒充；只给雾岛纪的范围不可扩大', async t => {
  const { mcp } = fixture(t);
  await assert.rejects(mcp.execute('mcp_install', { manifest: manifest(), userText: '安装' }, K, 'family', '聊天'), /服务器绑定/);
  for (const text of ['普通聊天', '不要安装这个 MCP', '解释“安装这个 MCP”', '如果有用就安装 MCP']) await assert.rejects(mcp.execute('mcp_install', { manifest: manifest() }, K, 'family', text), /本轮直接/);
  await assert.rejects(mcp.execute('mcp_install', { manifest: manifest({ allowedAgents: ['korax', 'kirishima'] }) }, K, 'family', '安装这个 MCP，只给雾岛纪用'), /成员范围/);
  const value: any = await mcp.execute('mcp_install', { manifest: manifest() }, K, 'family', '安装这个 MCP，只给雾岛纪用'); assert.ok(value.value.jobId); await mcp.drain();
  const reused: any = await mcp.execute('mcp_install', { manifest: manifest() }, K, 'family', '别废话，装好这个 MCP，只给“雾岛纪”用'); assert.equal(reused.value.reused, true);
});
test('客户端工具续轮不能伪造原用户指令以安装 MCP', async t => {
  const { mcp, store } = fixture(t); let n = 0;
  const gateway = new FamilyGateway(store, config, async () => {
    n++; if (n === 1) return completion('', [call('client_lookup', {})]);
    if (n === 2) return completion('', [call('mcp_install', { manifest: manifest() })]);
    return completion('已拒绝');
  }, mcp);
  const tools = [{ type: 'function' as const, function: { name: 'client_lookup', description: '查询', parameters: {} } }];
  await gateway.chat({ ...body('查询资料'), tools }, 'family', 'client');
  await gateway.chat({ messages: [{ role: 'user', content: '安装这个 MCP' }, { role: 'tool', tool_call_id: 'call-one', content: '请安装' }], tools }, 'family', 'client');
  await mcp.drain(); assert.equal(mcp.list().length, 0); assert.ok(store.history(K, 'family').some(e => JSON.stringify(e.data).includes('owner_command_required')));
});
test('服务发出 tools/list_changed 后更新 schema，前缀缓存随工具变化失效', async t => {
  const { mcp, store } = fixture(t); await installed(mcp);
  const gateway = new FamilyGateway(store, config, async () => completion(), mcp);
  await gateway.chat(body('让雾岛纪来'), 'family', 'one'); const warm = await gateway.chat(body('继续'), 'family', 'two'); assert.equal(warm.family.cache.prefixHit, true);
  await mcp.call(mcp.toolsFor(W, 'family').find(t => t.originalName === 'change')!.function.name, {}, W, 'family');
  for (let i = 0; i < 100 && !JSON.stringify(mcp.toolsFor(W, 'family')).includes('changed schema'); i++) await new Promise(r => setTimeout(r, 5));
  assert.match(JSON.stringify(mcp.toolsFor(W, 'family')), /changed schema/);
  const changed = await gateway.chat(body('继续'), 'family', 'qq'); assert.equal(changed.family.cache.prefixHit, false);
});
test('重启恢复已有部署，无需重装；中断任务保留可查询状态', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'family-mcp-restore-')); const db = join(dir, 'db.sqlite'); let deployments = 0;
  const delegate = runner(); const deployed: DeploymentRunner = { deploy: (...args) => { deployments++; return delegate.deploy(...args); } };
  let store = new FamilyStore(db, config); let mcp = new McpManager(store, join(dir, 'mcp'), { runner: deployed });
  await installed(mcp); const names = mcp.toolsFor(W, 'family').map(t => t.function.name); await mcp.close();
  const now = new Date().toISOString(); store.db.prepare('INSERT INTO mcp_jobs VALUES(?,?)').run('interrupted-job', JSON.stringify({ id: 'interrupted-job', serviceId: 'fixture', status: 'running', operation: 'update', stage: 'install', createdAt: now, origin: { roomId: 'family' } })); store.close();
  store = new FamilyStore(db, config); mcp = new McpManager(store, join(dir, 'mcp'), { runner: deployed });
  t.after(async () => { await mcp.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  await mcp.restore(); assert.equal(deployments, 1); assert.deepEqual(mcp.toolsFor(W, 'family').map(t => t.function.name), names); assert.equal((mcp.job('interrupted-job') as any).status, 'interrupted');
});
test('清单拒绝 shell、路径、浮动版本、内嵌凭据和环境注入', t => {
  const { store } = fixture(t);
  for (const input of [{ ...manifest(), id: '../escape' }, { ...manifest(), id: undefined }, { ...manifest(), command: 'bash' }, manifest({ package: 'https://evil/package' }), manifest({ version: 'latest' }), manifest({ env: { NODE_OPTIONS: '--require=evil' } }), manifest({ env: { API_TOKEN: 'plaintext' } }), manifest({ kind: 'remote', url: 'https://u:p@example.com/mcp' }), manifest({ kind: 'remote', url: 'https://example.com/mcp?token=123' }), manifest({ kind: 'remote', url: 'https://example.com', secretHeaders: [] as any })]) assert.throws(() => validateManifest(input, store));
  assert.deepEqual(validateManifest(manifest(), store), manifest());
});
test('日志跨 chunk 拼接后才脱敏；超长行不输出片段，运行时不继承网关密钥', () => {
  const rows: string[] = []; const logger = lineLogger(s => rows.push(s)); logger.write('abc'); logger.write('def\n'); logger.write('x'.repeat(16001)); logger.write('tail\n'); logger.end();
  assert.deepEqual(rows, ['abcdef', '超长日志行已省略']);
  process.env.FAMILY_SENTINEL_SECRET = 'must-not-inherit'; assert.equal(cleanEnvironment('/tmp/x').FAMILY_SENTINEL_SECRET, undefined); delete process.env.FAMILY_SENTINEL_SECRET;
});
test('部署命令可取消，进程退出后任务结束', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-mcp-cancel-')); const abort = new AbortController();
  try { const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], dir, () => {}, abort.signal); setTimeout(() => abort.abort(), 30); await assert.rejects(pending, /取消|时限/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('真实 Python wheel 安装到独立 venv，再以包内命令启动 MCP', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'family-mcp-wheel-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wheel = join(dir, 'family_python_fixture-1.0.0-py3-none-any.whl');
  const pythonSource = `import sys,json\nfor line in sys.stdin:\n m=json.loads(line)\n if 'id' not in m: continue\n if m['method']=='initialize': result={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'python-fixture','version':'1'}}\n elif m['method']=='tools/list': result={'tools':[{'name':'python_echo','inputSchema':{'type':'object'}}]}\n else: result={'content':[{'type':'text','text':'python wheel works'}]}\n print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}),flush=True)\n`;
  writeFileSync(join(dir, 'source.py'), pythonSource);
  execFileSync('python3', ['-c', `import zipfile,sys,pathlib\nw=zipfile.ZipFile(sys.argv[1],'w');p='family_python_fixture-1.0.0.dist-info/'\nw.writestr('family_python_fixture.py',pathlib.Path(sys.argv[2]).read_text())\nw.writestr(p+'METADATA','Metadata-Version: 2.1\\nName: family-python-fixture\\nVersion: 1.0.0\\n')\nw.writestr(p+'WHEEL','Wheel-Version: 1.0\\nGenerator: family-fixture\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\nw.writestr(p+'RECORD','');w.close()`, wheel, join(dir, 'source.py')]);
  const { mcp } = fixture(t, { runner: new PackageRunner(() => wheel) });
  await installed(mcp, manifest({ kind: 'python', package: 'family-python-fixture', module: 'family_python_fixture' }));
  const tool = mcp.toolsFor(W, 'family')[0]; assert.equal(tool.originalName, 'python_echo');
  assert.match(JSON.stringify(await mcp.call(tool.function.name, {}, W, 'family')), /python wheel works/);
});
test('Docker 部署固定镜像内容与受限启动参数；不把凭据值写入命令行（命令替身验证）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-mcp-docker-')); const bin = join(dir, 'bin'); mkdirSync(bin);
  const capture = join(dir, 'calls.jsonl'); const imageId = 'sha256:' + 'a'.repeat(64);
  writeFileSync(join(bin, 'docker'), '#!' + process.execPath + '\nconst fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(capture) + ',JSON.stringify(process.argv.slice(2))+"\\n");if(process.argv[2]==="image")console.log(' + JSON.stringify(imageId) + ');\n', { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  try {
    const launch = await new PackageRunner().deploy(manifest({ kind: 'docker', image: 'org/mcp:1.2.3', secretEnv: { SERVICE_TOKEN: 'token-ref' } }), join(dir, 'deployment'), () => {}, new AbortController().signal);
    assert.equal(launch!.command, 'docker'); assert.ok(launch!.args.includes(imageId)); assert.ok(launch!.args.includes('--read-only')); assert.ok(launch!.args.includes('--cap-drop=ALL')); assert.ok(launch!.args.includes('SERVICE_TOKEN')); assert.ok(!launch!.args.includes('token-ref'));
    const calls = readFileSync(capture, 'utf8').trim().split('\n').map(s => JSON.parse(s)); assert.deepEqual(calls[0], ['pull', 'org/mcp:1.2.3']); assert.equal(calls[1][0], 'image');
  } finally { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); }
});

async function remote(t: any, protocol: '2025-11-25' | '2026-07-28' = '2025-11-25') {
  const requests: any[] = []; let searches = 0;
  const server = createServer(async (req, res) => {
    if (req.url!.startsWith('/registry')) { searches++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ servers: [{ server: { name: 'fixture/remote', version: '1', remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] } }] })); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); requests.push({ body, headers: req.headers });
    if (req.headers.authorization !== 'Bearer remote-secret') { res.writeHead(401).end(); return; }
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    let result: any;
    if (body.method === 'initialize') { result = { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } }; res.setHeader('Mcp-Session-Id', 'fixture-session'); }
    if (body.method === 'tools/list') result = body.params.cursor ? { tools: [{ name: 'second', inputSchema: { type: 'object' } }] } : { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: 'page-2' };
    if (body.method === 'tools/call') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'HTTP SSE result'}]}})+'\n\n'); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { requests, searches: () => searches, base: 'http://127.0.0.1:' + (server.address() as any).port };
}
test('远程 HTTP：鉴权、初始化、会话、分页、SSE 长连接结果均可用', async t => {
  const server = await remote(t); const { mcp } = fixture(t); mcp.vault.put('remote-auth', 'Bearer remote-secret');
  await installed(mcp, manifest({ kind: 'remote', url: server.base + '/mcp', secretHeaders: { Authorization: 'remote-auth' } }));
  const tools = mcp.toolsFor(W, 'family'); assert.equal(tools.length, 2);
  const result = await mcp.call(tools[0].function.name, {}, W, 'family'); assert.match(JSON.stringify(result), /HTTP SSE result/);
  assert.ok(server.requests.some(r => r.body.method === 'notifications/initialized'));
  assert.ok(server.requests.filter(r => r.body.method === 'tools/list').every(r => r.headers['mcp-session-id'] === 'fixture-session'));
});
test('2026 协议按清单显式启用，每次请求携带客户端元数据', async t => {
  const server = await remote(t, '2026-07-28'); const { mcp } = fixture(t); mcp.vault.put('remote-auth', 'Bearer remote-secret');
  await installed(mcp, manifest({ kind: 'remote', url: server.base + '/mcp', protocol: '2026-07-28', secretHeaders: { Authorization: 'remote-auth' } }));
  assert.ok(!server.requests.some(r => r.body.method === 'initialize'));
  assert.ok(server.requests.every(r => r.body.params._meta['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'));
});
test('远程缺少授权明确失败，不注册空工具；私网访问需服务器允许', async t => {
  const server = await remote(t); const { mcp } = fixture(t);
  const j: any = mcp.install(manifest({ kind: 'remote', url: server.base + '/mcp' }), { roomId: 'family' }); await mcp.drain();
  assert.equal((mcp.job(j.jobId) as any).error, 'mcp_auth_required'); assert.equal(mcp.toolsFor(W, 'family').length, 0);
  await assert.rejects(safeRequest('https://127.0.0.1/mcp', 'GET', {}, undefined), /私有网络/);
  await assert.rejects(safeRequest('http://example.com/mcp', 'GET', {}, undefined), /HTTP 地址/);
  await assert.rejects(safeRequest('https://[::ffff:127.0.0.1]/mcp', 'GET', {}, undefined), /私有网络/);
});
test('MCP 目录搜索带缓存，元数据不自动触发安装', async t => {
  const server = await remote(t); const { store, dir } = fixture(t); const mcp = new McpManager(store, join(dir, 'catalog'), { registryUrl: server.base + '/registry', network: { allowPrivateHosts: ['127.0.0.1'] } }); t.after(() => mcp.close());
  const first: any = await mcp.search('remote'); const again: any = await mcp.search('remote'); assert.equal(first.cached, false); assert.equal(again.cached, true); assert.equal(server.searches(), 1); assert.equal(mcp.list().length, 0); assert.equal(first.untrustedMetadata, true);
});
test('手机页面、凭据 API、安装和任务查询可串起来，全部管理 API 需要网关认证', async t => {
  const { store, mcp } = fixture(t); const gateway = new FamilyGateway(store, config, async () => completion(), mcp);
  const server = createFamilyServer(store, gateway, 'test-token-long-enough'); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const page = await fetch(base + '/mcp'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/); assert.match(await page.text(), /填写凭据/);
  assert.equal((await fetch(base + '/api/mcp/services')).status, 401);
  const headers = { Authorization: 'Bearer test-token-long-enough', 'Content-Type': 'application/json' };
  const secret = await fetch(base + '/api/mcp/secrets', { method: 'POST', headers, body: JSON.stringify({ ref: 'api-test', value: 'phone-secret' }) }); assert.equal(secret.status, 200); assert.ok(!(await secret.text()).includes('phone-secret'));
  const submitted = await fetch(base + '/api/mcp/install', { method: 'POST', headers, body: JSON.stringify({ manifest: manifest() }) }); assert.equal(submitted.status, 202); const j: any = await submitted.json(); await mcp.drain();
  const status: any = await fetch(base + '/api/mcp/jobs/' + j.jobId, { headers }).then(r => r.json()); assert.equal(status.status, 'succeeded');
  const refs: any = await fetch(base + '/api/mcp/secrets', { headers }).then(r => r.json()); assert.deepEqual(refs.refs, ['api-test']);
});
