import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FamilyStore } from './store.ts';
import { FamilyStore as Store } from './store.ts';
import { FamilyGateway } from './gateway.ts';
import { openAIProvider } from './provider.ts';
import { loadConfig } from './config.ts';
import { AppError, OWNER, ensure } from './types.ts';
import { McpManager } from './mcp/manager.ts';
import { mcpPage } from './mcp/page.ts';
import { FamilyWorld } from './world/world.ts';
import { Ingress } from './world/ingress.ts';
import { homePage } from './world/page.ts';
import { loadChannels, resolveDestination } from './world/channels.ts';
import { MAX_ARTIFACT_BYTES } from './world/artifacts.ts';
import {loadModelRouting} from './models.ts';
import {modelPage} from './model-page.ts';
import {deskPage} from './world/desk-page.ts';
import {localDate} from './world/schedule.ts';

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0; const parts: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; ensure(size <= 2_000_000, 413, 'body_too_large', '请求超过 2 MB'); parts.push(chunk); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new AppError(400, 'invalid_json', '请求体需要有效 JSON'); }
}
async function readBytes(req: IncomingMessage, maximum: number): Promise<Buffer> {
  let size = 0; const parts: Buffer[] = [];
  for await (const part of req) { size += part.length; ensure(size <= maximum, 413, 'body_too_large', '上传超过大小限制'); parts.push(part); } return Buffer.concat(parts);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
}
export function createFamilyServer(store: FamilyStore, gateway: FamilyGateway, token: string, ingress?: Ingress, options: { ideOrigins?: string[] } = {}) {
  ensure(token.length >= 16, 500, 'token_required', 'GATEWAY_TOKEN 至少需要 16 字符');
  const ideOrigins = new Set(options.ideOrigins ?? []);
  for (const origin of ideOrigins) { let parsed: URL; try { parsed = new URL(origin); } catch { throw new AppError(500, 'bad_ide_origin', 'IDE_ORIGINS 需要完整 HTTP(S) origin'); } ensure(['https:', 'http:'].includes(parsed.protocol) && parsed.origin === origin, 500, 'bad_ide_origin', 'IDE_ORIGINS 只允许精确 HTTP(S) origin，不含路径或通配符'); }
  return createServer(async (req, res) => {
    let opened = false;
    const streamId = `chatcmpl-${randomUUID()}`;
    const streamBase = { id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'family' };
    const send = (data: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = String(req.headers.origin ?? '');
      if (ideOrigins.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        ensure(ideOrigins.has(origin), 403, 'ide_origin_denied', '该 IDE 来源未获跨域许可');
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Room-Id, X-Client-Id, Idempotency-Key', 'Access-Control-Max-Age': '600' }); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/ide-toolbox.js') { const code = await readFile(new URL('../integrations/ide-toolbox.js', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(code); return; }
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, version: '0.1.0', providerConfigured: !!gateway.router.config || !!process.env.MODEL_BASE_URL && !!process.env.MODEL_NAME });
      if (req.method === 'GET' && ['/mcp', '/', '/home','/models','/desk','/toolbox'].includes(url.pathname)) {
        const nonce = randomUUID().replaceAll('-', '');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` }); res.end(url.pathname === '/mcp' ? mcpPage(nonce) : url.pathname==='/models' ? modelPage(nonce) : ['/desk','/toolbox'].includes(url.pathname)?deskPage(nonce):homePage(nonce)); return;
      }
      const hook = /^\/ingress\/([a-z][a-z0-9_-]*)$/.exec(url.pathname);
      if (req.method === 'POST' && hook) {
        ensure(ingress && gateway.world, 503, 'ingress_disabled', '平台接入器未启用'); const account = gateway.world.config.accounts.find(a => a.id === hook[1]); ensure(account, 404, 'account_not_found', '账号未绑定');
        const raw = await readBytes(req, 2_000_000); ingress.verify(account, req.headers, raw); let body; try { body = JSON.parse(raw.toString()); } catch { throw new AppError(400, 'invalid_json', '回调需要有效 JSON'); } return json(res, 202, ingress.accept(account, body));
      }
      const media = /^\/delivery-media\/([a-f0-9-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && media) {
        const world = gateway.world; ensure(world, 404, 'not_found', '媒体不可用'); const outgoing = world.delivery.media(media[1], Number(url.searchParams.get('expires')), url.searchParams.get('token') ?? '');
        const a = world.workspaces.get(outgoing.actor, outgoing.artifactId!, outgoing.roomId); const bytes = await world.workspaces.bytes(outgoing.actor, a.id, outgoing.roomId);
        res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name.split('/').at(-1)!)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return;
      }
      const supplied = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const a = Buffer.from(supplied), b = Buffer.from(token);
      ensure(a.length === b.length && timingSafeEqual(a, b), 401, 'invalid_key', '需要有效网关 API Key');
      const roomId = String(req.headers['x-room-id'] ?? url.searchParams.get('room') ?? 'family');
      const clientId = String(req.headers['x-client-id'] ?? 'default');
      ensure(/^[a-zA-Z0-9_-]{1,64}$/.test(clientId), 400, 'bad_client_id', '客户端 ID 格式无效');
      store.room(OWNER, roomId);
      if(req.method==='GET' && url.pathname==='/api/model-routing')return json(res,200,gateway.router.view(url.searchParams.get('agent')??store.room(OWNER,roomId).activeAgentId));
      if(req.method==='POST' && url.pathname==='/api/model-routing/config')return json(res,200,gateway.router.configure(await readBody(req)));
      if(req.method==='POST' && url.pathname==='/api/model-routing/select'){const body=await readBody(req);return json(res,200,gateway.router.select(body.agentId??store.room(OWNER,roomId).activeAgentId,body.routeId,roomId));}
      const world = gateway.world;
      if (world) {
        const ownerAuthority = (command: string) => { const source = store.event(OWNER, roomId, 'message', { message: { role: 'user', content: command }, clientId: 'management' }); return world.authority({ kind: 'agent', id: store.room(OWNER, roomId).activeAgentId }, roomId, source.id); };
        const actor = { kind: 'agent' as const, id: store.room(OWNER, roomId).activeAgentId };
        if(req.method==='GET'&&url.pathname==='/api/plans')return json(res,200,{plans:world.planner.list(OWNER,roomId)});
        if(req.method==='GET'&&url.pathname==='/api/plans/runs')return json(res,200,{runs:world.planner.runs(OWNER,roomId,url.searchParams.get('planId')??undefined)});
        if(req.method==='POST'&&url.pathname==='/api/plans'){
          const body=await readBody(req),target=body.destination?resolveDestination(world.config,body.destination).id:undefined;
          const command=`${body.kind==='crawl'?'定时抓取并总结':body.kind==='diary'?'写每日日记':'设置闹钟提醒'}：${body.title} ${(body.urls??[]).join(' ')}${body.schedule?.type!=='once'?' 每天或按指定周期执行':''}${target?'，发到'+target:''}`;
          return json(res,201,world.planner.create(actor,ownerAuthority(command),body));
        }
        const planPath=/^\/api\/plans\/([a-f0-9-]+)(?:\/(control))?$/.exec(url.pathname);
        if(planPath&&req.method==='POST'){
          const body=await readBody(req),plan=world.planner.get(OWNER,roomId,planPath[1]),ownerActor={kind:'agent' as const,id:plan.agentId};
          if(planPath[2]){const verbs:Record<string,string>={pause:'暂停',resume:'恢复',cancel:'取消',snooze:'稍后提醒',run_now:'立即执行'};return json(res,200,world.planner.control(ownerActor,ownerAuthority(`${verbs[body.action]??''}计划 ${plan.id}`),plan.id,body.action,body.snoozeMs));}
          return json(res,200,world.planner.update(ownerActor,ownerAuthority(`修改计划 ${plan.id} ${(body.urls??[]).join(' ')}${body.destination?'，发到'+resolveDestination(world.config,body.destination).id:''}${body.schedule?.type!=='once'?' 按指定周期重复':''}`),plan.id,body));
        }
        if(req.method==='GET'&&url.pathname==='/api/todos')return json(res,200,{todos:world.planner.todos(OWNER,roomId,url.searchParams.get('status')??'open')});
        if(req.method==='POST'&&url.pathname==='/api/todos'){
          const body=await readBody(req);return json(res,201,world.planner.addTodo(actor,ownerAuthority(`添加待办 ${body.title}${body.remindAt?' 并提醒我':''}${body.destination?'，发到'+resolveDestination(world.config,body.destination).id:''}`),body));
        }
        const todoPath=/^\/api\/todos\/([a-f0-9-]+)$/.exec(url.pathname);
        if(todoPath&&req.method==='POST'){
          const body=await readBody(req),todo=world.planner.todo(OWNER,roomId,todoPath[1]);return json(res,200,world.planner.updateTodo({kind:'agent',id:todo.agentId},ownerAuthority(`修改待办 ${todo.id}${body.remindAt?' 并提醒我':''}${body.destination?'，发到'+resolveDestination(world.config,body.destination).id:''}`),todo.id,body));
        }
        if(req.method==='POST'&&url.pathname==='/api/diary/write'){
          const body=await readBody(req),zone=body.timeZone??'Asia/Shanghai';return json(res,201,world.planner.create(actor,ownerAuthority(`现在写 ${body.date??'今天'} 的日记${body.destination?'，发到'+resolveDestination(world.config,body.destination).id:''}`),{...body,kind:'diary',title:'每日日记',timeZone:zone,diaryDate:body.date??localDate(world.clock(),zone),schedule:{type:'once',at:new Date(world.clock()+1000).toISOString()}}));
        }
        if(req.method==='GET'&&url.pathname==='/api/toolbox/config')return json(res,200,world.toolbox.config);
        if(req.method==='POST'&&url.pathname==='/api/toolbox/config')return json(res,200,world.toolbox.configure(await readBody(req)));
        if(req.method==='GET'&&url.pathname==='/api/toolbox')return json(res,200,{items:world.toolbox.search(OWNER,roomId,url.searchParams.get('query')??'',url.searchParams.get('category')??undefined)});
        if(req.method==='POST'&&url.pathname==='/api/toolbox/capture'){
          const body=await readBody(req),auth=ownerAuthority(`保存到工具箱 ${(body.urls??[]).join(' ')} ${(body.artifactIds??[]).join(' ')} ${body.note??''}`);return json(res,201,{items:await world.toolbox.capture(actor,auth,body)});
        }
        if(req.method==='POST'&&url.pathname==='/api/toolbox/organize'){world.toolbox.organize(actor,roomId);return json(res,200,{organized:true});}
        const boxPath=/^\/api\/toolbox\/([a-f0-9-]+)(?:\/(send))?$/.exec(url.pathname);
        if(boxPath&&req.method==='GET')return json(res,200,world.toolbox.get(OWNER,roomId,boxPath[1]));
        if(boxPath&&req.method==='POST'){
          const body=await readBody(req);if(!boxPath[2])return json(res,200,world.toolbox.update(actor,ownerAuthority('修改工具箱条目 '+boxPath[1]),boxPath[1],body));
          const item=world.toolbox.get(OWNER,roomId,boxPath[1]),destination=resolveDestination(world.config,body.destination).id;
          const value=world.delivery.enqueue(OWNER,roomId,{destination,kind:item.kind==='url'?'text':'file',text:item.kind==='url'?item.url:undefined,artifactId:item.kind==='file'?item.artifactIds[0]:undefined,key:'toolbox-send:'+String(req.headers['idempotency-key']??randomUUID())});void world.delivery.pump();return json(res,202,value);
        }
        if(req.method==='GET'&&url.pathname==='/api/features')return json(res,200,{features:world.features.list(OWNER,roomId,url.searchParams.get('status')??undefined)});
        if(req.method==='POST'&&url.pathname==='/api/features/handoff')return json(res,200,await world.features.handoff(actor,roomId));
        if (req.method === 'GET' && url.pathname === '/api/channels') return json(res, 200, world.config);
        if (req.method === 'POST' && url.pathname === '/api/channels') { const config = world.configure(await readBody(req)); await ingress?.restart(); return json(res, 200, config); }
        if (req.method === 'GET' && url.pathname === '/api/ingress/status') return json(res, 200, ingress?.states() ?? {});
        if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, { tasks: world.tasks(OWNER, roomId) });
        if (req.method === 'POST' && url.pathname === '/api/tasks') {
          const body = await readBody(req); const target = body.destination ? resolveDestination(world.config, body.destination).id : undefined;
          const command = `后台执行任务：${body.goal}${target ? `，${body.deliveryKind === 'voice' ? '语音' : body.deliveryKind === 'file' ? '文件' : body.deliveryKind === 'image' ? '图片' : '结果'}发到${target}` : ''}`;
          return json(res, 202, world.start(actor, ownerAuthority(command), body));
        }
        const task = /^\/api\/tasks\/([a-f0-9-]+)(?:\/(control))?$/.exec(url.pathname);
        if (task && req.method === 'GET' && !task[2]) return json(res, 200, world.publicTask(world.task(OWNER, roomId, task[1])));
        if (task && req.method === 'POST' && task[2]) {
          const body = await readBody(req); const verb: Record<string, string> = { pause: '暂停', resume: '继续', cancel: '取消', handoff: '交给' };
          const command = `${verb[body.action] ?? ''}任务 ${task[1]} ${body.agentId ?? ''}`;
          return json(res, 200, world.control(ownerAuthority(command), task[1], body.action, body.agentId, body.reason));
        }
        if (req.method === 'GET' && url.pathname === '/api/inbox') return json(res, 200, { items: world.delivery.inbox(OWNER, roomId) });
        const read = /^\/api\/inbox\/([a-f0-9-]+)\/read$/.exec(url.pathname);
        if (read && req.method === 'POST') { world.delivery.markRead(read[1]); return json(res, 200, { read: true }); }
        if (req.method === 'GET' && url.pathname === '/api/deliveries') return json(res, 200, { deliveries: world.delivery.list().filter(d => d.roomId === roomId) });
        if (req.method === 'POST' && url.pathname === '/api/deliveries') {
          const body = await readBody(req); let artifactId = body.artifactId;
          if (body.kind === 'voice' && artifactId) artifactId = (await world.voice.prepare(OWNER, roomId, artifactId, abort.signal)).id;
          const result = world.delivery.enqueue(OWNER, roomId, { ...body, artifactId, key: 'api:' + String(req.headers['idempotency-key'] ?? randomUUID()) }); void world.delivery.pump(); return json(res, 202, result);
        }
        const retry = /^\/api\/deliveries\/([a-f0-9-]+)\/retry$/.exec(url.pathname);
        if (retry && req.method === 'POST') { const body = await readBody(req); ensure(world.delivery.get(retry[1]).roomId === roomId, 403, 'wrong_room', '投递不在当前房间'); const value = world.delivery.retry(retry[1], body.confirmUnknown === true); void world.delivery.pump(); return json(res, 202, value); }
        if (req.method === 'GET' && url.pathname === '/api/notifications') return json(res, 200, { rules: world.rules().filter(r => r.roomId === roomId) });
        if (req.method === 'POST' && url.pathname === '/api/notifications') { const body = await readBody(req); const destination = body.destination ? resolveDestination(world.config, body.destination).id : undefined; return json(res, 201, (await world.execute('notify_when', body, actor, ownerAuthority(`提醒我：${body.text}${destination ? '，发到' + destination : ''}${body.everyMs ? '，每隔指定周期重复' : ''}`))).value); }
        const rule = /^\/api\/notifications\/([a-f0-9-]+)\/disable$/.exec(url.pathname);
        if (rule && req.method === 'POST') { ensure(world.rules().some(r => r.id === rule[1] && r.roomId === roomId), 404, 'rule_not_found', '规则不在当前房间'); world.disableRule(rule[1]); return json(res, 200, { disabled: true }); }
        if (req.method === 'POST' && url.pathname === '/api/signals') { const body = await readBody(req); world.signal(roomId, body.name, body.data); await world.tick(); return json(res, 202, { accepted: true }); }
        const workspace = /^\/api\/workspaces\/([a-z][a-z0-9_-]*)(?:\/(files))?$/.exec(url.pathname);
        if (workspace && req.method === 'GET' && !workspace[2]) return json(res, 200, { files: world.workspaces.list(OWNER, roomId, workspace[1]) });
        if (workspace && req.method === 'PUT' && workspace[2]) { const bytes = await readBytes(req, MAX_ARTIFACT_BYTES); const artifact = await world.workspaces.create(OWNER, roomId, { ownerId: workspace[1], name: url.searchParams.get('name') ?? 'upload.bin', mime: String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0], bytes }); return json(res, 201, artifact); }
        const file = /^\/api\/files\/([a-f0-9-]+)$/.exec(url.pathname);
        if (file && req.method === 'GET') { const a = world.workspaces.get(OWNER, file[1], roomId); const bytes = await world.workspaces.bytes(OWNER, a.id, roomId); res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.name.split('/').at(-1)!)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return; }
        const share = /^\/api\/artifacts\/([a-f0-9-]+)\/share$/.exec(url.pathname);
        if (share && req.method === 'POST') return json(res, 200, world.workspaces.share(OWNER, share[1], roomId, await readBody(req)));
      }
      if (url.pathname.startsWith('/api/mcp/')) {
        const mcp = gateway.mcp; ensure(mcp, 503, 'mcp_disabled', 'MCP 管理器未启用');
        if (req.method === 'GET' && url.pathname === '/api/mcp/services') return json(res, 200, { services: mcp.list(OWNER, roomId) });
        if (req.method === 'GET' && url.pathname === '/api/mcp/secrets') return json(res, 200, { refs: mcp.vault.list() });
        if (req.method === 'POST' && url.pathname === '/api/mcp/secrets') { const body = await readBody(req); mcp.vault.put(body.ref, body.value); return json(res, 200, { ref: body.ref, saved: true }); }
        if (req.method === 'GET' && url.pathname === '/api/mcp/search') return json(res, 200, await mcp.search(url.searchParams.get('query') ?? ''));
        if (req.method === 'POST' && url.pathname === '/api/mcp/install') { const body = await readBody(req); return json(res, 202, mcp.install(body.manifest, { roomId })); }
        if (req.method === 'POST' && url.pathname === '/api/mcp/manage') { const body = await readBody(req); return json(res, 202, mcp.manage(body.id, body.action, { roomId }, body.manifest)); }
        const job = /^\/api\/mcp\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
        if (req.method === 'GET' && job) return json(res, 200, mcp.job(job[1], OWNER, roomId));
        const logs = /^\/api\/mcp\/services\/([a-z][a-z0-9-]*)\/logs$/.exec(url.pathname);
        if (req.method === 'GET' && logs) return json(res, 200, { logs: mcp.logs(logs[1], OWNER, roomId, Number(url.searchParams.get('limit') ?? 50)) });
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'family', object: 'model', created: 0, owned_by: 'household' }] });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { room: store.room(OWNER, roomId), agents: store.config.agents.map(a => ({ id: a.id, name: a.name, aliases: a.aliases })), rooms: store.rooms(OWNER) });
      if (req.method === 'GET' && url.pathname === '/api/cache') return json(res, 200, gateway.cache.stats());
      if (req.method === 'GET' && url.pathname === '/api/memory-index') return json(res,200,store.search.status());
      if (req.method === 'POST' && url.pathname === '/api/memory-index/rebuild') return json(res,202,store.search.rebuild());
      if (req.method === 'POST' && url.pathname === '/api/recall') { const body = await readBody(req); return json(res,200,store.search.search(OWNER,roomId,body.query,body,gateway.cache)); }
      if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { events: store.history(OWNER, roomId, Number(url.searchParams.get('limit') || 100)) });
      if (req.method === 'GET' && url.pathname === '/api/memories') return json(res, 200, { memories: store.memories(OWNER, roomId, url.searchParams.get('query') ?? '') });
      if (req.method === 'POST' && url.pathname === '/api/rooms') {
        const body = await readBody(req); return json(res, 201, store.createRoom(OWNER, body.id, body.name, body.members, body.activeAgentId));
      }
      if (req.method === 'POST' && url.pathname === '/api/memories') {
        const body = await readBody(req);
        ensure(body && typeof body === 'object' && !('actorId' in body), 400, 'invalid_body', '作者由服务端决定');
        ensure(['private', 'shared'].includes(body.visibility), 400, 'bad_visibility', 'visibility 需要 private 或 shared');
        if (body.visibility === 'private') { store.agent(body.ownerId); ensure(store.room(OWNER, roomId).members.includes(body.ownerId), 400, 'owner_not_in_room', '私密记忆归属成员必须在房间内'); }
        let sources = body.sources;
        if (!sources) {
          ensure(typeof body.text === 'string' && body.text.length > 0 && body.text.length <= 4000, 400, 'bad_text', '记忆正文需要 1–4000 字符');
          sources = [store.event(OWNER, roomId, 'user.note', { text: body.text, clientId, ...(body.visibility === 'private' ? { privateTo: body.ownerId } : {}) }).id];
        }
        return json(res, 201, store.append(OWNER, { roomId, text: body.text, visibility: body.visibility, sources, kind: body.kind, ownerId: body.ownerId,validity:body.validity }));
      }
      if (req.method === 'POST' && url.pathname === '/api/memory-relations') {
        const body = await readBody(req);
        for (const id of [body.fromId,body.toId]) ensure(store.memory(OWNER,id).roomId===roomId,403,'wrong_room','关系不属于当前房间');
        return json(res,201,store.relate(OWNER,body.fromId,body.toId,body.type,body.sources));
      }
      const operation = /^\/api\/memories\/([a-f0-9-]+)\/(supplement|challenge|confirm)$/.exec(url.pathname);
      if (req.method === 'POST' && operation) {
        const body = await readBody(req); const memory = store.memory(OWNER, operation[1]);
        ensure(memory.roomId === roomId, 403, 'wrong_room', '记忆不属于当前房间');
        const sources = body.sources ?? [store.event(OWNER, roomId, 'user.note', { text: body.text, clientId, ...(memory.visibility === 'private' ? { privateTo: memory.ownerId } : {}) }).id];
        return json(res, 200, store.operate(OWNER, memory.id, operation[2] as 'supplement' | 'challenge' | 'confirm', body.text, sources));
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req);
        ensure(body && typeof body === 'object' && (body.stream === undefined || typeof body.stream === 'boolean'), 400, 'bad_body', '无效请求体');
        if (req.headers['x-destination-id']) { ensure(typeof req.headers['x-destination-id'] === 'string', 400, 'bad_destination_id', 'X-Destination-Id 需要字符串'); body.sourceDestinationId = req.headers['x-destination-id']; }
        const requestKey = req.headers['idempotency-key'];
        ensure(requestKey === undefined || (typeof requestKey === 'string' && requestKey.length > 0 && requestKey.length <= 200), 400, 'bad_idempotency_key', 'Idempotency-Key 需要 1–200 字符');
        const result = await gateway.chat(body, roomId, clientId, body.stream ? text => {
          if (res.destroyed) return;
          if (!opened) {
            opened = true; res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
            send({ ...streamBase, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          }
          send({ ...streamBase, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        } : undefined, abort.signal, requestKey as string | undefined);
        if (!body.stream) return json(res, 200, result);
        if (!opened) { opened = true; res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); send({ ...streamBase, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }); }
        const message = result.choices[0].message;
        if (message.tool_calls) send({ ...streamBase, choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((c: any, index: number) => ({ ...c, index })) }, finish_reason: null }] });
        send({ ...streamBase, choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }] });
        send({ ...streamBase, choices: [], usage: result.usage, family: result.family, ...(result.attachments ? { attachments: result.attachments } : {}) });
        res.end('data: [DONE]\n\n'); return;
      }
      throw new AppError(404, 'not_found', '接口不存在');
    } catch (e) {
      const error = e instanceof AppError ? e : new AppError(500, 'internal_error', '请求处理失败');
      const payload = { error: { type: error.code, message: error.message } };
      if (opened) { send(payload); if (!res.destroyed) res.end('data: [DONE]\n\n'); }
      else json(res, error.status, payload);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(process.env.CONFIG_PATH ?? './config.example.json');
  if(process.env.MODEL_ROUTES_PATH)config.modelRouting=loadModelRouting(process.env.MODEL_ROUTES_PATH);
  const token = process.env.GATEWAY_TOKEN ?? '';
  ensure(token.length >= 16, 500, 'token_required', '先配置至少 16 字符的 GATEWAY_TOKEN');
  const databasePath = process.env.DATABASE_PATH ?? './data/family.sqlite';
  const store = new Store(databasePath, config);
  const mcp = new McpManager(store, process.env.MCP_DATA_DIR ?? join(dirname(databasePath), 'mcp'), { secretKey: process.env.MCP_SECRET_KEY, network: { allowPrivateHosts: (process.env.MCP_PRIVATE_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean) } });
  void mcp.restore().catch(() => console.error('MCP 恢复失败，请查看管理页'));
  const generate = openAIProvider(process.env.MODEL_BASE_URL ?? '', process.env.MODEL_API_KEY ?? '', process.env.MODEL_NAME ?? '');
  const gateway = new FamilyGateway(store, config, generate, mcp);
  const allowHttpHosts = (process.env.CHANNEL_HTTP_HOSTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const world = new FamilyWorld(store, process.env.WORLD_DATA_DIR ?? join(dirname(databasePath), 'world'), generate, { secrets: mcp.vault, mcp,router:gateway.router,crawlPrivateHosts:(process.env.CRAWL_PRIVATE_HOSTS??'').split(',').map(s=>s.trim()).filter(Boolean), ...(process.env.CHANNELS_PATH ? { channels: loadChannels(process.env.CHANNELS_PATH, store) } : {}), allowHttpHosts, publicBaseUrl: process.env.PUBLIC_BASE_URL,
    ...(process.env.VOICE_SERVICE_URL ? { speech: { url: process.env.VOICE_SERVICE_URL, key: process.env.VOICE_API_KEY ?? '', model: process.env.VOICE_MODEL ?? '', voices: JSON.parse(process.env.VOICE_VOICES ?? '{}'), allowHttpHosts } } : {}) });
  gateway.world = world; world.startScheduler(); const ingress = new Ingress(world, gateway, mcp.vault, allowHttpHosts); ingress.start();
  const server = createFamilyServer(store, gateway, token, ingress, { ideOrigins: (process.env.IDE_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean) });
  server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? '127.0.0.1', () => console.log('λάβρυς 已启动，端口', process.env.PORT ?? '8787'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => { void (async () => { await ingress.close(); await world.close(); await mcp.close(); })().finally(() => { store.close(); process.exit(0); }); }); });
}
