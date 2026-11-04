import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {once} from 'node:events';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {FamilyStore} from '../src/store.ts';
import {FamilyGateway} from '../src/gateway.ts';
import {ModelRouter,validateModelRouting} from '../src/models.ts';
import type {ModelRoutingConfig} from '../src/models.ts';
import {SecretVault} from '../src/mcp/vault.ts';
import {createFamilyServer} from '../src/server.ts';
import {OWNER,AppError} from '../src/types.ts';
import type {Config,Message,ToolCall} from '../src/types.ts';
import {openAIProvider} from '../src/provider.ts';
import {modelPage} from '../src/model-page.ts';
import {FamilyWorld} from '../src/world/world.ts';

const template:Config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const body=(content:string)=>({messages:[{role:'user' as const,content}]});
const completed=(content='正常回答。',toolCalls:ToolCall[]=[])=>({content,toolCalls,usage:{},finishReason:toolCalls.length?'tool_calls':'stop'});
const frame=(data:any)=>'data: '+JSON.stringify(data)+'\n\n';
type Request={provider:string;body:any;headers:IncomingMessage['headers']};
function answer(res:ServerResponse,data:any,stream=false){if(stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({choices:[{delta:{content:data},finish_reason:'stop'}]})+'data: [DONE]\n\n');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:typeof data==='string'?{content:data}:data,finish_reason:typeof data==='string'?'stop':'tool_calls'}],usage:{prompt_tokens:10}}));}}
async function fixture(t:any,handler?:(request:Request,res:ServerResponse)=>void|Promise<void>,path=':memory:'){
  const requests:Request[]=[];const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const request={provider:req.url!.split('/')[1],body:JSON.parse(raw),headers:req.headers};requests.push(request);if(handler)await handler(request,res);else answer(res,'正常回答。',request.body.stream);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const routing:ModelRoutingConfig={providers:[{id:'first',name:'第一服务商',aliases:['甲'],baseURL:url+'/first/v1'},{id:'second',name:'第二服务商',aliases:['乙'],baseURL:url+'/second/v1'}],routes:[{id:'main',providerId:'first',model:'actual/full/main-model',name:'主模型',aliases:['Kimi','主模型']},{id:'backup',providerId:'second',model:'actual/full/backup-model',name:'备用模型',aliases:['备用','B']}],defaultRouteId:'main',fallbackRouteIds:['backup','main'],firstTokenTimeoutMs:1000,attemptTimeoutMs:5000,totalTimeoutMs:10000,cooldownSeconds:60};
  const config={...structuredClone(template),modelRouting:routing};const store=new FamilyStore(path,config);t.after(()=>{try{store.close();}catch{}});
  let legacyCalls=0;const gateway=new FamilyGateway(store,config,async()=>{legacyCalls++;return completed('旧单模型入口');});
  return {store,gateway,routing,requests,url,get legacyCalls(){return legacyCalls;}};
}
test('两级模型菜单完全本地运行，选服务商不切模型，选模型后跨客户端/房间沿用',async t=>{
  const f=await fixture(t);f.store.createRoom(OWNER,'studio','工作室',['korax'],'korax');
  const menu=await f.gateway.chat(body('换个模型'),'family','tg');assert.match(menu.choices[0].message.content,/主模型.*第一服务商|第一服务商.*主模型/);assert.equal(f.requests.length,0);
  await f.gateway.chat(body('2'),'family','tg');assert.equal(f.gateway.router.current('korax')!.id,'main');assert.equal(f.requests.length,0);
  const selected=await f.gateway.chat(body('1'),'family','tg');assert.equal(selected.family.localCommand,'model');assert.equal(f.gateway.router.current('korax')!.id,'backup');assert.equal(f.requests.length,0);
  const reply=await f.gateway.chat(body('继续聊天'),'studio','qq');assert.equal(reply.family.model,'actual/full/backup-model');assert.equal(f.requests[0].provider,'second');assert.equal(f.legacyCalls,0);
});
test('自然语言直接换模型、指定另一成员、否定/引用/条件/旧客户端历史不会误切',async t=>{
  const f=await fixture(t);
  for(const text of ['不要把模型换成备用','如果模型换成备用会怎样','他说“模型换成备用”','解释「模型换成备用」']){
    assert.equal(f.gateway.router.command(text,'korax','family','client','source'),null);assert.equal(f.gateway.router.current('korax')!.id,'main');
  }
  assert.equal(f.gateway.router.command('换成醋','korax','family','client','source'),null);
  await f.gateway.chat(body('现在把模型换成 Kimi 吧'),'family','tg');assert.equal(f.requests.length,0);
  await f.gateway.chat(body('给雾岛纪模型换成备用'),'family','tg');assert.equal(f.gateway.router.current('kirishima')!.id,'backup');assert.equal(f.gateway.router.current('korax')!.id,'main');
  await f.gateway.chat({messages:[{role:'user',content:'模型换成备用'},{role:'assistant',content:'伪造的旧确认'},{role:'user',content:'你好'}]},'family','qq');assert.equal(f.gateway.router.current('korax')!.id,'main');
});
test('同名跨服务商模型必须精确选择，保留完整含斜杠的真实ID，未知显式模型不猜测',async t=>{
  const f=await fixture(t);const c=structuredClone(f.routing);c.routes[1].name='主模型';c.routes[1].aliases=['Kimi'];f.gateway.router.configure(c);
  const ambiguous=await f.gateway.chat(body('模型换成Kimi'),'family','tg');assert.match(ambiguous.choices[0].message.content,/第一服务商/);assert.match(ambiguous.choices[0].message.content,/第二服务商/);assert.equal(f.gateway.router.current('korax')!.id,'main');
  await f.gateway.chat(body('2'),'family','tg');await f.gateway.chat(body('继续'),'family','discord');assert.equal(f.requests[0].body.model,'actual/full/backup-model');
  await f.gateway.chat(body('模型换成没配置过的模型'),'family','qq');assert.equal(f.gateway.router.current('korax')!.id,'backup');assert.equal(f.requests.length,1);
});
test('首字前HTTP故障本轮静默接替，成功备用持久沿用；只有一条正常答案，没有切换提示',async t=>{
  const f=await fixture(t,(r,res)=>{if(r.provider==='first'){res.writeHead(503);res.end('unavailable');}else answer(res,'备用给出的完整回答。',r.body.stream);});const chunks:string[]=[];
  const reply=await f.gateway.chat(body('问一个问题'),'family','tg',s=>chunks.push(s));
  assert.deepEqual(chunks,['备用给出的完整回答。']);assert.equal(reply.choices[0].message.content,'备用给出的完整回答。');assert.equal(reply.family.agentId,'korax');assert.equal(reply.family.model,'actual/full/backup-model');assert.equal(f.requests.length,2);
  assert.equal(f.gateway.router.current('korax')!.id,'backup');assert.equal(f.store.memories(OWNER,'family').length,0);
  const replies=f.store.history(OWNER,'family').filter(e=>e.kind==='message' && (e.data as any).message.role==='assistant');assert.equal(replies.length,1);
  await f.gateway.chat(body('下一个问题'),'family','qq');assert.deepEqual(f.requests.map(r=>r.provider),['first','second','second']);
  const menu=await f.gateway.chat(body('换个模型'),'family','discord');assert.match(menu.choices[0].message.content,/当前选择：第二服务商/);assert.equal(f.requests.length,3);
});
test('首字超时直接接替，不等待全请求超时；失败请求取消，缓存键按真实服务商和模型分开',async t=>{
  const f=await fixture(t,(r,res)=>{if(r.provider==='first'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();}else answer(res,'及时接替。',true);});
  // Allow loopback connection setup under parallel test load, while retaining
  // a first-progress deadline well below the 5 s whole-attempt deadline.
  f.gateway.router.configure({...f.routing,firstTokenTimeoutMs:1000});f.gateway.cache.config.providerMode='openai';const start=performance.now();
  const reply=await f.gateway.chat(body('请回答'),'family','tg',()=>{});assert.equal(reply.choices[0].message.content,'及时接替。');assert.ok(performance.now()-start<4500);
  const first=f.requests.find(r=>r.provider==='first'),backup=f.requests.find(r=>r.provider==='second');assert.ok(first,'primary request reached loopback server');assert.ok(backup,'backup request reached loopback server');
  assert.notEqual(first.body.prompt_cache_key,backup.body.prompt_cache_key);assert.equal(backup.body.model,'actual/full/backup-model');
});
test('已发出文字后中断不混接输出，备用从下一轮接手，原话与失败记录保留',async t=>{
  const f=await fixture(t,(r,res)=>{if(r.provider==='first'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({choices:[{delta:{content:'已经发出的半句'}}]}));}else answer(res,'下一轮备用回答。',r.body.stream);});const chunks:string[]=[];
  await assert.rejects(f.gateway.chat(body('第一轮'),'family','tg',s=>chunks.push(s)),/完成帧/);assert.deepEqual(chunks,['已经发出的半句']);assert.equal(f.requests.length,1);assert.equal(f.gateway.router.current('korax')!.id,'backup');
  const next=await f.gateway.chat(body('接着说'),'family','qq');assert.equal(next.choices[0].message.content,'下一轮备用回答。');assert.equal(f.requests.length,2);
  assert.ok(f.store.history(OWNER,'family').some(e=>e.kind==='request.failed' && (e.data as any).partialText==='已经发出的半句'));
});
test('客户端取消不触发备用调用，也不把模型记成故障',async t=>{
  let arrived!:()=>void;const waiting=new Promise<void>(r=>arrived=r);
  const f=await fixture(t,(_r,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();arrived();});const abort=new AbortController();
  const pending=f.gateway.chat(body('等待中的问题'),'family','tg',()=>{},abort.signal);await waiting;abort.abort();await assert.rejects(pending,(e:any)=>e.code==='client_disconnected');assert.equal(f.requests.length,1);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM model_health').get() as any).n,0);
});
test('已完成记忆工具后失败，只重试当前模型生成，不重新执行原工具',async t=>{
  let firstCalls=0;let store:FamilyStore;
  const f=await fixture(t,(r,res)=>{if(r.provider==='first' && ++firstCalls===1){const source=store.history(OWNER,'family').find(e=>e.kind==='message' && (e.data as any).message.role==='user')!;answer(res,{content:'',reasoning_content:'replay-for-first-provider',tool_calls:[{id:'append-once',type:'function',function:{name:'family_append',arguments:JSON.stringify({text:'只记一次的认识',visibility:'shared',sources:[source.id]})}}]});}else if(r.provider==='first'){assert.equal(r.body.messages.find((m:any)=>m.tool_calls?.length).reasoning_content,'replay-for-first-provider');res.writeHead(502);res.end();}else{assert.ok(r.body.messages.some((m:any)=>m.role==='tool' && String(m.content).includes('只记一次的认识')));assert.ok(r.body.messages.every((m:any)=>!m.reasoning_content && !m.reasoning_scope));answer(res,'记好了。');}});store=f.store;
  const reply=await f.gateway.chat(body('记住这条认识'),'family','qq');assert.equal(reply.choices[0].message.content,'记好了。');assert.equal(f.store.memories(OWNER,'family').length,1);assert.equal(f.requests.length,3);
});
test('未完成的流式工具调用不会执行；首字前换备用也不会写出旧模型的候选副作用',async t=>{
  const f=await fixture(t,(r,res)=>{if(r.provider==='first'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({choices:[{delta:{tool_calls:[{index:0,id:'never-execute',function:{name:'family_append',arguments:'{"text":"不应落地","visibility":"shared","sources":["missing"]}'}}]}}]}));}else answer(res,'正常备用回答。',true);});
  await f.gateway.chat(body('聊天'),'family','qq',()=>{});assert.equal(f.store.memories(OWNER,'family').length,0);assert.equal(f.requests.length,2);
});
test('能力不符先跳过；不会把图片静默剥掉交给不支持图片的备用模型',async t=>{
  const f=await fixture(t);const config=structuredClone(f.routing);config.routes[0].capabilities={tools:false,vision:false};f.gateway.router.configure(config);
  const content=[{type:'text',text:'看这张图'},{type:'image_url',image_url:{url:'https://example.com/image.png'}}];
  await f.gateway.chat({messages:[{role:'user',content}]},'family','tg');assert.equal(f.requests.length,1);assert.equal(f.requests[0].provider,'second');assert.deepEqual(f.requests[0].body.messages.find((m:any)=>m.role==='user').content,content);
});
test('全部失败有尝试上限和冷却；手动选择只强制试一次，菜单仍无需模型可用',async t=>{
  const f=await fixture(t,(_r,res)=>{res.writeHead(429,{'Retry-After':'120'});res.end();});
  await assert.rejects(f.gateway.chat(body('第一轮'),'family','tg'),/HTTP 429/);assert.equal(f.requests.length,2);
  await assert.rejects(f.gateway.chat(body('冷却中'),'family','qq'),(e:any)=>e.code==='no_available_model');assert.equal(f.requests.length,2);
  await f.gateway.chat(body('模型换成主模型'),'family','tg');assert.equal(f.requests.length,2);
  await assert.rejects(f.gateway.chat(body('明确重新试一次'),'family','tg'),/HTTP 429/);assert.equal(f.requests.length,3);
  await assert.rejects(f.gateway.chat(body('仍在冷却'),'family','qq'),(e:any)=>e.code==='no_available_model');assert.equal(f.requests.length,3);
  assert.match((await f.gateway.chat(body('换个模型'),'family','tg')).choices[0].message.content,/可选服务商/);
});
test('并发旧回复不会覆盖用户后来手动选择的模型',async t=>{
  let release!:()=>void,arrived!:()=>void;const wait=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>arrived=r);
  const f=await fixture(t,async(r,res)=>{if(r.provider==='first'){arrived();await wait;}answer(res,'完成。');});f.store.createRoom(OWNER,'studio','工作室',['korax'],'korax');
  const request=f.gateway.chat(body('较慢的旧请求'),'family','tg');await ready;await f.gateway.chat(body('模型换成备用'),'studio','qq');release();await request;
  assert.equal(f.gateway.router.current('korax')!.id,'backup');
});
test('手机保存配置、当前模型与菜单重启保留，密钥只存在加密库，视图/日志/缓存不含明文',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'family-model-state-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'state.sqlite');
  const f=await fixture(t,undefined,path),vault=new SecretVault(f.store.db,join(dir,'vault'));const secret='fake-fixture-key-do-not-persist-in-plain-text-199';vault.put('first-key',secret);
  const cfg=structuredClone(f.routing);cfg.providers[0].keyRef='first-key';f.gateway.router.options.secrets=vault;f.gateway.router.configure(cfg);await f.gateway.chat(body('你好'),'family','tg');assert.equal(f.requests[0].headers.authorization,'Bearer '+secret);
  await f.gateway.chat(body('模型换成备用'),'family','qq');await f.gateway.chat(body('换个模型'),'family','tg');f.store.close();
  const store=new FamilyStore(path,structuredClone(template));t.after(()=>store.close());const router=new ModelRouter(store,undefined,async()=>completed(),{secrets:new SecretVault(store.db,join(dir,'vault'))});
  assert.equal(router.current('korax')!.id,'backup');const reply=router.command('2','korax','family','tg','new-source');assert.match(reply!,/可选模型/);
  for(const table of ['model_config','events','gateway_cache','model_menus']){assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM '+table).all()).includes(secret));}assert.ok(!JSON.stringify(router.view('korax')).includes(secret));
});
test('换模型后只换模型前缀缓存，身份、作者和原文记忆缓存继续沿用',async t=>{
  const f=await fixture(t);const source=f.store.event(OWNER,'family','user.note',{text:'持久认识来源'});f.store.append({kind:'agent',id:'korax'},{roomId:'family',visibility:'private',text:'乌鸦自己的认识',sources:[source.id]});
  await f.gateway.chat(body('普通聊天'),'family','tg');await f.gateway.chat(body('模型换成备用'),'family','qq');const result=await f.gateway.chat(body('普通聊天'),'family','discord');
  assert.equal(result.family.cache.prefixHit,false);assert.equal(result.family.cache.memoryHit,true);assert.equal(result.family.cache.historyHit,true);assert.equal(result.family.agentId,'korax');assert.match(JSON.stringify(f.requests.at(-1)!.body.messages),/乌鸦自己的认识/);
});
test('推理模型的工具重放字段保留，思考分片不作为用户回复输出',async t=>{
  let requests=0;const f=await fixture(t,(r,res)=>{requests++;if(requests===1){answer(res,{content:'',reasoning_content:'private-replay-only',reasoning_details:[{type:'signature',data:'signed'}],tool_calls:[{id:'read-one',type:'function',function:{name:'family_read',arguments:'{}'}}]});}else{const assistant=r.body.messages.find((m:any)=>m.tool_calls?.length);assert.equal(assistant.reasoning_content,'private-replay-only');assert.equal(assistant.reasoning_details[0].data,'signed');answer(res,'实际回答。');}});
  const result=await f.gateway.chat(body('查看记忆'),'family','tg');assert.equal(result.choices[0].message.content,'实际回答。');assert.ok(!JSON.stringify(result).includes('private-replay-only'));
  const stream=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({choices:[{delta:{reasoning_content:'思考片段'}}]})+frame({choices:[{delta:{content:'可见回复'},finish_reason:'stop'}]})+'data: [DONE]\n\n');});stream.listen(0,'127.0.0.1');await once(stream,'listening');t.after(async()=>{stream.closeAllConnections();await new Promise<void>(r=>stream.close(()=>r()));});
  const parts:string[]=[];const result2=await openAIProvider(`http://127.0.0.1:${(stream.address() as any).port}`,'','mock')([{role:'user',content:'hi'}],[],'',s=>parts.push(s));assert.deepEqual(parts,['可见回复']);assert.equal(result2.reasoningContent,'思考片段');
});
test('模型手机页和管理API通过真实HTTP认证与保存；客户端固定family入口，内嵌脚本语法正确',async t=>{
  const f=await fixture(t);const server=createFamilyServer(f.store,f.gateway,'model-management-long-key');server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const url=`http://127.0.0.1:${(server.address() as any).port}`,headers={Authorization:'Bearer model-management-long-key','Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/model-routing')).status,401);assert.equal((await fetch(url+'/api/model-routing/config',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url+'/api/model-routing/config',{method:'POST',headers,body:JSON.stringify(f.routing)})).status,200);
  assert.equal((await fetch(url+'/api/model-routing/select',{method:'POST',headers,body:JSON.stringify({agentId:'korax',routeId:'backup'})})).status,200);
  const view=await fetch(url+'/api/model-routing?agent=korax',{headers}).then(r=>r.json()) as any;assert.equal(view.current.id,'backup');
  const models=await fetch(url+'/v1/models',{headers}).then(r=>r.json()) as any;assert.deepEqual(models.data.map((r:any)=>r.id),['family']);
  const page=modelPage('nonce-test');for(const m of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);assert.ok(!page.includes('localStorage'));
});
test('配置拒绝内嵌密钥、别名歧义、未知模型备用和错误预算',async t=>{
  const f=await fixture(t);const bad=(modify:(c:any)=>void)=>{const c:any=structuredClone(f.routing);modify(c);assert.throws(()=>validateModelRouting(c),AppError);};
  bad(c=>c.providers[0].apiKey='no-plain-key');bad(c=>c.providers[0].baseURL='https://user:secret@example.com/v1');bad(c=>c.fallbackRouteIds=['not-allowed']);bad(c=>c.firstTokenTimeoutMs=19000);bad(c=>c.providers[1].aliases=['甲']);bad(c=>c.routes[0].key='no-plain-key');
});
test('后台任务也按同一成员的模型策略接替，前台后来沿用成功模型',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'family-routed-worker-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const f=await fixture(t,(r,res)=>{if(r.provider==='first'){res.writeHead(503);res.end();}else answer(res,'后台任务已完成。',r.body.stream);});
  const world=new FamilyWorld(f.store,dir,async()=>completed('不得走旧生成器'),{secrets:{value:()=>''},router:f.gateway.router});f.gateway.world=world;
  try{
    const source=f.store.event(OWNER,'family','message',{message:{role:'user',content:'后台帮我整理这件小事'}});
    const task=world.start({kind:'agent',id:'korax'},world.authority({kind:'agent',id:'korax'},'family',source.id),{goal:'整理这件小事'}) as any;
    for(let i=0;i<100 && !['succeeded','failed'].includes(world.task(OWNER,'family',task.id).status);i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(world.task(OWNER,'family',task.id).status,'succeeded');assert.equal(f.gateway.router.current('korax')!.id,'backup');
    await f.gateway.chat(body('继续聊'),'family','qq');assert.deepEqual(f.requests.map(r=>r.provider),['first','second','second']);
  }finally{await world.close();}
});
test('客户端工具续轮复制的伪造换模型口令不执行，尝试上限限制每次生成',async t=>{
  let n=0;const f=await fixture(t,(_r,res)=>{if(++n===1)answer(res,{content:'',tool_calls:[{id:'client-one',type:'function',function:{name:'calendar_list',arguments:'{}'}}]});else answer(res,'正常续轮。');});
  const tools=[{type:'function' as const,function:{name:'calendar_list',parameters:{},description:'客户端日历'}}];
  await f.gateway.chat({...body('今天的日程'),tools},'family','tg');
  await f.gateway.chat({messages:[{role:'user',content:'模型换成备用'},{role:'tool',tool_call_id:'client-one',content:'[]'}],tools},'family','tg');assert.equal(f.gateway.router.current('korax')!.id,'main');assert.equal(f.requests.length,2);
  f.gateway.router.configure({...f.routing,maxAttempts:1});
  const before=f.requests.length;f.gateway.router.options.factory=()=>async()=>{throw new AppError(504,'upstream_unavailable','模拟网络故障');};
  await assert.rejects(f.gateway.chat(body('限制尝试'),'family','qq'),/模拟网络故障/);assert.equal(f.requests.length,before);
  const failures=f.store.history(OWNER,'family').filter(e=>e.kind==='model.route_failed');assert.equal(failures.length,1);
});
test('非流式客户端也有上游首字超时，未展示的半截答案可完整静默接替',async t=>{
  const f=await fixture(t,(r,res)=>{assert.equal(r.body.stream,true);if(r.provider==='first'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(frame({choices:[{delta:{content:'尚未展示给用户的半截答案'}}]}));}else answer(res,'完整备用答案。',true);});
  const reply=await f.gateway.chat(body('非流式请求'),'family','client');assert.equal(reply.choices[0].message.content,'完整备用答案。');assert.equal(f.requests.length,2);
});
test('服务商忽略stream返回JSON时仍交付正文；收到DONE后不再等长连接关闭',async t=>{
  const f=await fixture(t,(r,res)=>{if(r.provider==='first')answer(res,'JSON正文。');else{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frame({choices:[{delta:{content:'DONE已完成。'},finish_reason:'stop'}]})+'data: [DONE]\n\n');}});const parts:string[]=[];
  const first=await f.gateway.chat(body('第一轮'),'family','tg',s=>parts.push(s));assert.deepEqual(parts,['JSON正文。']);assert.equal(first.choices[0].message.content,'JSON正文。');
  f.gateway.router.select('korax','backup','family');const start=performance.now();const second=await f.gateway.chat(body('第二轮'),'family','qq',()=>{});assert.equal(second.choices[0].message.content,'DONE已完成。');assert.ok(performance.now()-start<1800);
});
