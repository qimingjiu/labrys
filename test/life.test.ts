import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
import {FamilyStore} from '../src/store.ts';
import {FamilyGateway} from '../src/gateway.ts';
import {FamilyWorld} from '../src/world/world.ts';
import {Ingress} from '../src/world/ingress.ts';
import {SecretVault} from '../src/mcp/vault.ts';
import {createFamilyServer} from '../src/server.ts';
import {OWNER,CONTROLLER} from '../src/types.ts';
import type {Actor,Config,Message,ToolCall} from '../src/types.ts';
import type {Channels,Outgoing} from '../src/world/types.ts';
import type {Generate} from '../src/provider.ts';
import {validateSchedule,nextOccurrence,dayBounds} from '../src/world/schedule.ts';
import {canonicalURL} from '../src/world/toolbox.ts';
import {runWorkflow} from '../src/world/features.ts';
import {deskPage} from '../src/world/desk-page.ts';
const template:Config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const K:Actor={kind:'agent',id:'korax'},W:Actor={kind:'agent',id:'kirishima'};
const reply=(content='完成。',toolCalls:ToolCall[]=[])=>({content,toolCalls,usage:{},finishReason:toolCalls.length?'tool_calls':'stop'});
const call=(name:string,args:any):ToolCall=>({id:'call-life',type:'function',function:{name,arguments:JSON.stringify(args)}});
const configChannels=():Channels=>({accounts:[{id:'tg',platform:'telegram',ownerIds:['1'],tokenRef:'bot'},{id:'dc',platform:'discord',ownerIds:['2']},{id:'qq',platform:'onebot',ownerIds:['3'],baseUrl:'http://127.0.0.1'},{id:'wx',platform:'openclaw',ownerIds:['4'],baseUrl:'http://127.0.0.1'}],destinations:[{id:'tg-home',aliases:['tg'],accountId:'tg',roomId:'family',target:{chatId:'10'},capabilities:['text','file','image']},{id:'dc-home',aliases:['dc'],accountId:'dc',roomId:'family',target:{channelId:'20'},capabilities:['text','file','image']},{id:'qq-home',aliases:['qq'],accountId:'qq',roomId:'family',target:{userId:'3'},capabilities:['text','file','image']},{id:'wx-home',aliases:['微信'],accountId:'wx',roomId:'family',target:{userId:'wx-user'},capabilities:['text','file','image']}]});
function fixture(t:any,options:{generate?:Generate;file?:boolean;dir?:string;clock?:()=>number;channels?:Channels}={}){
  const dir=options.dir??mkdtempSync(join(tmpdir(),'family-life-'));const store=new FamilyStore(options.file?join(dir,'family.sqlite'):':memory:',structuredClone(template));const vault=new SecretVault(store.db,join(dir,'vault'));vault.put('bot','fake-token');const sent:Outgoing[]=[];
  let now=Date.now()+1000,calls=0;const seen:Message[][]=[];const generate:Generate=options.generate??(async messages=>{calls++;seen.push(messages);if(String(messages[0].content).includes('私人工具箱'))return reply(JSON.stringify({title:'Android 开源手机工具',description:'安卓手机上的开源效率工具，支持 Android，项目说明和使用方法。',category:'tools',tags:['Android','安卓','开源']}));return reply('今天我们一起完成了工作，留下了明天的待办。');});
  const world=new FamilyWorld(store,join(dir,'world'),generate,{secrets:vault,channels:options.channels??configChannels(),clock:options.clock??(()=>now),adapter:async(_a,_d,outgoing)=>{sent.push(structuredClone(outgoing));return {status:'sent',messageId:'receipt-'+sent.length};},crawlPrivateHosts:['127.0.0.1']});const gateway=new FamilyGateway(store,store.config,generate);gateway.world=world;
  t.after(async()=>{await world.close();try{store.close();}catch{}if(!options.dir)rmSync(dir,{recursive:true,force:true});});
  const auth=(text:string,room='family',attachments:string[]=[],destinationId?:string)=>{const e=store.event(OWNER,room,'message',{message:{role:'user',content:text},...(attachments.length?{attachments:attachments.map(artifactId=>({artifactId}))}:{}),...(destinationId?{destinationId}:{})});return world.authority(room==='private-kirishima'?W:K,room,e.id);};
  return {dir,store,world,gateway,vault,sent,auth,seen,get calls(){return calls;},get now(){return now;},advance(ms:number){now+=ms;}};
}
async function settle(f:ReturnType<typeof fixture>,predicate:()=>boolean){for(let i=0;i<150&&!predicate();i++){await f.world.tick();await new Promise(r=>setTimeout(r,5));}assert.ok(predicate(),'background operation completed');}
async function pageServer(t:any){let changed=false;const requests:string[]=[];const server=createServer((req,res)=>{requests.push(req.url!);if(req.url==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('User-agent: *\nDisallow: /private\nAllow: /');return;}if(req.url==='/redirect'){res.writeHead(302,{Location:'https://127.0.0.1/secret'});res.end();return;}if(req.headers['if-none-match']===(changed?'v2':'v1')){res.writeHead(304);res.end();return;}res.writeHead(200,{'Content-Type':'text/html',ETag:changed?'v2':'v1'});res.end('<html><title>Android project</title><script>do not run this</script><main><h1>安卓开源项目</h1><p>'+(changed?'新版增加离线功能。':'支持手机上的本地工具。')+'</p></main></html>');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});return {url:`http://127.0.0.1:${(server.address() as any).port}`,requests,change(){changed=true;}};}

test('每天/工作日按时区计算，DST跳过不存在时间、重复时刻只触发一次',()=>{
  const now=Date.parse('2026-11-04T00:00:00Z');const daily=validateSchedule({type:'calendar',time:'08:30',timeZone:'Asia/Shanghai'},now);
  assert.equal(new Date(nextOccurrence(daily,now)!).toISOString(),'2026-11-04T00:30:00.000Z');
  const weekdays=validateSchedule({type:'calendar',time:'08:00',timeZone:'Asia/Shanghai',weekdays:[1,2,3,4,5]},now);assert.equal(new Date(nextOccurrence(weekdays,Date.parse('2026-11-06T01:00:00Z'))!).toISOString(),'2026-11-09T00:00:00.000Z');
  const gap=validateSchedule({type:'calendar',time:'02:30',timeZone:'America/New_York'},now);assert.equal(new Date(nextOccurrence(gap,Date.parse('2026-03-08T00:00:00Z'))!).toISOString(),'2026-03-09T06:30:00.000Z');
  const fold=validateSchedule({type:'calendar',time:'01:30',timeZone:'America/New_York'},now);assert.equal(new Date(nextOccurrence(fold,Date.parse('2026-11-01T05:45:00Z'))!).toISOString(),'2026-11-02T06:30:00.000Z');
  assert.equal(dayBounds('2026-03-08','America/New_York').end-dayBounds('2026-03-08','America/New_York').start,23*3600000);assert.throws(()=>validateSchedule({type:'calendar',time:'25:00'},now),/HH:mm/);
});
test('闹钟精确触发、幂等、稍后提醒，明确闹钟不受普通勿扰影响',async t=>{
  const channels=configChannels();channels.quietHours={start:0,end:23,timeZone:'UTC'};const f=fixture(t,{channels});const args={kind:'alarm',title:'取快递',schedule:{type:'once',at:new Date(f.now+1000).toISOString()},destination:'tg'};
  const a=f.auth('一分钟后提醒我取快递，发到tg');const plan=f.world.planner.create(K,a,args);assert.equal(f.world.planner.create(K,a,args).id,plan.id);
  await f.world.tick();assert.equal(f.sent.length,0);f.advance(1100);await settle(f,()=>f.sent.length===1);await f.world.tick();assert.equal(f.sent.length,1);assert.equal(f.calls,0);
  f.world.planner.control(K,f.auth('稍后五分钟再提醒'),plan.id,'snooze');f.advance(300001);await settle(f,()=>f.sent.length===2);assert.equal(f.calls,0);
});
test('待办截止与提醒独立，完成/删除会停提醒，重开不恢复过去闹钟',async t=>{
  const f=fixture(t),todo=f.world.planner.addTodo(K,f.auth('加个待办交论文，并提醒我，发到tg'),{title:'交论文',dueAt:new Date(f.now+3600000).toISOString(),remindAt:new Date(f.now+1000).toISOString(),destination:'tg',priority:'high'});
  assert.equal(typeof todo.reminderPlanId,'string');assert.equal(f.world.planner.todos(K,'family')[0].id,todo.id);assert.throws(()=>f.world.planner.todo(W,'family',todo.id),/私人/);
  f.world.planner.updateTodo(K,f.auth('完成交论文待办'),todo.id,{status:'done'});f.advance(5000);await f.world.tick();assert.equal(f.sent.length,0);
  f.world.planner.updateTodo(K,f.auth('重新打开这条待办'),todo.id,{status:'open'});assert.equal(f.world.planner.todo(K,'family',todo.id).reminderPlanId,undefined);
  assert.throws(()=>f.world.planner.addTodo(K,f.auth('随便聊天'),{title:'越权'}),/本轮/);
});
test('重复计划需明确授权，私人成员隔离，暂停取消后不重生',async t=>{
  const f=fixture(t);assert.throws(()=>f.world.planner.create(K,f.auth('提醒我喝水'),{kind:'alarm',title:'喝水',schedule:{type:'interval',everyMs:60000}}),/周期/);
  const plan=f.world.planner.create(K,f.auth('每隔一分钟提醒我喝水'),{kind:'alarm',title:'喝水',schedule:{type:'interval',everyMs:60000,startAt:new Date(f.now+1000).toISOString()}});
  assert.throws(()=>f.world.planner.get(W,'family',plan.id),/私人/);assert.throws(()=>f.world.planner.create(CONTROLLER,f.auth('提醒我'),{kind:'alarm',title:'x',schedule:{type:'once',at:new Date(f.now+1000).toISOString()}}),/成员/);
  f.world.planner.control(K,f.auth('取消喝水提醒'),plan.id,'cancel');f.advance(100000);await f.world.tick();assert.equal(f.world.planner.runs(K,'family').length,0);
});
test('公开网页按ETag复用，变化才再总结，快照与完整Markdown保留',async t=>{
  const f=fixture(t),server=await pageServer(t),url=server.url+'/project';const plan=f.world.planner.create(K,f.auth('每隔五分钟抓取并总结 '+url+'，发到dc'),{kind:'crawl',title:'安卓项目',urls:[url],schedule:{type:'interval',everyMs:300000,startAt:new Date(f.now+1000).toISOString()},destination:'dc'});
  f.advance(1100);await settle(f,()=>f.world.planner.runs(K,'family',plan.id).some(r=>r.status==='succeeded'));const first=f.world.planner.runs(K,'family',plan.id)[0];assert.equal(f.calls,1);assert.equal(first.artifactIds.length,3);assert.ok(first.reportId);
  f.advance(300001);await settle(f,()=>f.world.planner.runs(K,'family',plan.id).filter(r=>r.status==='succeeded').length===2);assert.equal(f.calls,1);
  server.change();f.advance(300001);await settle(f,()=>f.world.planner.runs(K,'family',plan.id).filter(r=>r.status==='succeeded').length===3);assert.equal(f.calls,2);assert.match(JSON.stringify(f.seen.at(-1)),/previousText/);
});
test('robots与私网拦截真实执行，模型不能给计划补入用户没提供的网址',async t=>{
  const f=fixture(t),server=await pageServer(t),url=server.url+'/private/data';
  await assert.rejects(f.world.planner.crawler.read({},url,AbortSignal.timeout(1000)),/robots/);assert.ok(!server.requests.includes('/private/data'));
  await assert.rejects(f.world.planner.crawler.read({},'https://127.0.0.2/secret',AbortSignal.timeout(1000)),/私有网络/);
  assert.throws(()=>f.world.planner.create(K,f.auth('定时抓取 '+server.url+'/project'),{kind:'crawl',title:'x',urls:[server.url+'/other'],schedule:{type:'once',at:new Date(f.now+1000).toISOString()}}),/用户本轮/);
});
test('日记读取当天原话、区分作者和私密来源，不读其他成员私密工具数据，不写家庭记忆',async t=>{
  const f=fixture(t);f.auth('今天我把论文交好了。');f.store.event(K,'family','message',{message:{role:'assistant',content:'我们明天继续处理资料。'},agentId:'korax'});f.store.event(W,'family','message',{message:{role:'assistant',content:'private-diary-sentinel'},privateTo:'kirishima'});
  const result=await f.world.execute('diary_write',{},K,f.auth('帮我写今天的日记'));const plan=result.value as any;f.advance(1100);await settle(f,()=>f.world.planner.runs(K,'family',plan.id).some(r=>r.status==='succeeded'));
  assert.ok(f.calls>=2);assert.match(JSON.stringify(f.seen),/论文交好了/);assert.ok(!JSON.stringify(f.seen).includes('private-diary-sentinel'));assert.equal(f.store.memories(OWNER,'family').length,0);const run=f.world.planner.runs(K,'family',plan.id)[0];assert.ok(run.reportId);assert.match((await f.world.workspaces.bytes(K,run.reportId!,'family')).toString(),/日记/);
});
test('工具箱入口接收后立即回复且不调用前台模型，文件按内容去重、来源保留',async t=>{
  const f=fixture(t);f.world.toolbox.configure({destinationIds:['tg-home'],organizeTime:'03:00',timeZone:'Asia/Shanghai'});const file=await f.world.workspaces.create(K,'family',{name:'android-notes.md',mime:'text/markdown',bytes:Buffer.from('安卓开源手机工具。')});
  const r=await f.gateway.chat({messages:[{role:'user',content:'收下这个文件'}],attachments:[{artifactId:file.id}],sourceDestinationId:'tg-home'},'family','tg');assert.equal(r.family.localCommand,'toolbox');assert.equal(f.calls,0);
  const duplicate=await f.world.workspaces.create(K,'family',{name:'renamed.md',mime:'text/markdown',bytes:Buffer.from('安卓开源手机工具。')});await f.gateway.chat({messages:[{role:'user',content:'再收一份'}],attachments:[{artifactId:duplicate.id}],sourceDestinationId:'tg-home'},'family','tg');
  assert.equal(f.world.toolbox.search(K,'family').length,1);await settle(f,()=>f.world.toolbox.search(K,'family')[0].status==='ready');const found=f.world.toolbox.search(W,'family','之前那个安卓手机开源项目');assert.equal(found.length,1);assert.equal(found[0].sourceIds.length,2);assert.match(found[0].description,/安卓/);
});
test('网址去跟踪参数保留原URL，标签/描述本地召回；私人房间收藏不外泄',async t=>{
  const f=fixture(t);assert.equal(canonicalURL('https://example.com/a?utm_source=x&q=android#readme'),'https://example.com/a?q=android');
  const a=f.auth('收藏 https://example.com/android?utm_source=tg');const item=(await f.world.toolbox.capture(K,a,{urls:['https://example.com/android?utm_source=tg']}))[0];
  f.world.toolbox.update(K,f.auth('修改分类和标签'),item.id,{title:'安卓开源手机项目',description:'Android 设备的开源工具',category:'tools',tags:['Android','安卓','开源']});assert.equal(f.world.toolbox.search(K,'family','安卓开源')[0].id,item.id);
  const privateAuth=f.auth('收藏 https://example.com/private','private-korax');const secret=(await f.world.toolbox.capture(K,privateAuth,{urls:['https://example.com/private']}))[0];assert.throws(()=>f.world.toolbox.get(W,'family',secret.id),/空间/);assert.ok(!f.world.toolbox.search(W,'family','private').some(i=>i.id===secret.id));
});
test('图片原字节交给视觉模型；不支持的文件保留为待处理，不伪造已读',async t=>{
  const f=fixture(t);const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5b0AAAAASUVORK5CYII=','base64');const image=await f.world.workspaces.create(K,'family',{name:'image.png',mime:'image/png',bytes});const item=(await f.world.toolbox.capture(K,f.auth('把图片存工具箱','family',[image.id]),{artifactIds:[image.id]}))[0];
  await settle(f,()=>f.world.toolbox.get(K,'family',item.id).status==='ready');assert.ok(f.seen.some(messages=>JSON.stringify(messages).includes('data:image/png;base64,')));
  const binary=await f.world.workspaces.create(K,'family',{name:'unknown.bin',mime:'application/octet-stream',bytes:Buffer.from([0,1,2,3])});const unknown=(await f.world.toolbox.capture(K,f.auth('把文件存工具箱','family',[binary.id]),{artifactIds:[binary.id]}))[0];await settle(f,()=>f.world.toolbox.get(K,'family',unknown.id).status==='needs_review');assert.equal(f.world.toolbox.get(K,'family',unknown.id).artifactIds[0],binary.id);
});
test('动态扩展真实注册并执行，示例失败不启用；未知功能写成可供agent读取的交接',async t=>{
  const f=fixture(t),args={name:'整理清单',description:'提取清单并按名字去重排序',parameters:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{name:{type:'string'}},required:['name']}}},required:['items']},steps:[{op:'pick',path:'items'},{op:'unique',field:'name'},{op:'sort',field:'name'}],examples:[{input:{items:[{name:'b'},{name:'a'},{name:'b'}]},expected:[{name:'a'},{name:'b'}]}]};
  const installed=f.world.features.install(K,f.auth('给我加一个整理清单去重功能'),args);const tool=f.world.tools(false,K,'family').find(t=>t.function.name.startsWith('ext_'))!;assert.ok(tool);assert.equal(installed.testsPassed,1);const result=await f.world.execute(tool.function.name,{items:[{name:'b'},{name:'b'}]},K,f.auth('整理一下清单'));assert.deepEqual(result.value,[{name:'b'}]);
  assert.throws(()=>f.world.features.install(K,f.auth('加个坏功能'),{...args,examples:[{input:{items:[]},expected:['wrong']}]}),/验证失败/);assert.throws(()=>runWorkflow({},[{op:'shell'} as any]),/声明式/);
  const pending=await f.world.features.defer(K,f.auth('加一个能修改我IDE核心代码的新功能'),{name:'IDE适配',reason:'需要指定IDE仓库和接入接口',acceptance:['能从IDE拖入文件并检索']});assert.equal(pending.request.status,'pending');const text=(await f.world.workspaces.bytes(K,pending.handoff.artifactId,'family')).toString();assert.match(text,/用户原话/);assert.match(text,/需要指定IDE/);assert.equal(f.world.features.tools(W,'family').length,0);
});
test('TG/QQ/DC/微信接收文件统一收纳，重复推送不重复入库、回复无需前台模型',async t=>{
  const server=createServer((req,res)=>{if(req.url?.includes('getFile')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result:{file_path:'docs/shared.txt'}}));}else{res.writeHead(200,{'Content-Type':'text/plain'});res.end('同一份安卓手机开源项目说明');}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const channels=configChannels();channels.accounts.forEach(a=>a.baseUrl=base);const f=fixture(t,{channels});f.world.toolbox.configure({destinationIds:channels.destinations.map(d=>d.id),organizeTime:'03:00',timeZone:'Asia/Shanghai'});const ingress=new Ingress(f.world,f.gateway,f.vault,['127.0.0.1']);t.after(()=>ingress.close());
  const events:any[]=[{update_id:1,message:{message_id:1,from:{id:1},chat:{id:10},document:{file_id:'doc',file_name:'tg.txt',mime_type:'text/plain'}}},{id:'dc-1',author:{id:'2'},channel_id:'20',attachments:[{filename:'dc.txt',content_type:'text/plain',url:base+'/file'}]},{post_type:'message',message_type:'private',user_id:3,message_id:3,message:[{type:'file',data:{name:'qq.txt',url:base+'/file'}}]},{id:'wx-1',senderId:'4',destinationId:'wx-home',text:'',files:[{name:'wx.txt',mime:'text/plain',url:base+'/file'}]}];
  for(let i=0;i<events.length;i++){const r=ingress.accept(channels.accounts[i],events[i]);assert.ok(r.accepted);assert.ok(ingress.accept(channels.accounts[i],events[i]).duplicate);}
  for(let i=0;i<150 && Number((f.store.db.prepare("SELECT COUNT(*) AS n FROM ingress_events WHERE status='completed'").get() as any).n)!==4;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(Number((f.store.db.prepare("SELECT COUNT(*) AS n FROM ingress_events WHERE status='completed'").get() as any).n),4);assert.equal(f.world.toolbox.search(K,'family').length,1);assert.equal(f.calls,0);
});
test('手机日记/计划/待办/工具箱HTTP链路与脚本鉴权有效',async t=>{
  const f=fixture(t),server=createFamilyServer(f.store,f.gateway,'life-test-long-token',undefined,{ideOrigins:['https://ide.example']});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});const url=`http://127.0.0.1:${(server.address() as any).port}`,headers={Authorization:'Bearer life-test-long-token','Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/toolbox')).status,401);assert.equal((await fetch(url+'/api/plans')).status,401);
  const todo=await fetch(url+'/api/todos',{method:'POST',headers,body:JSON.stringify({title:'HTTP待办'})});assert.equal(todo.status,201);
  const alarm=await fetch(url+'/api/plans',{method:'POST',headers,body:JSON.stringify({kind:'alarm',title:'HTTP闹钟',schedule:{type:'once',at:new Date(f.now+10000).toISOString()}})});assert.equal(alarm.status,201);
  const diary=await fetch(url+'/api/diary/write',{method:'POST',headers,body:'{}'});assert.equal(diary.status,201);
  const save=await fetch(url+'/api/toolbox/capture',{method:'POST',headers,body:JSON.stringify({urls:['https://example.com/android']})});assert.equal(save.status,201);const search=await fetch(url+'/api/toolbox?query=android',{headers}).then(r=>r.json()) as any;assert.equal(search.items.length,1);assert.equal((await fetch(url+'/api/toolbox?category=',{headers}).then(r=>r.json()) as any).items.length,1);
  const preflight=await fetch(url+'/api/toolbox',{method:'OPTIONS',headers:{Origin:'https://ide.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization,Content-Type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://ide.example');assert.equal((await fetch(url+'/api/toolbox',{method:'OPTIONS',headers:{Origin:'https://other.example'}})).status,403);assert.equal((await fetch(url+'/api/toolbox',{headers:{Origin:'https://ide.example'}})).status,401);const module=await fetch(url+'/ide-toolbox.js',{headers:{Origin:'https://ide.example'}});assert.equal(module.status,200);assert.match(await module.text(),/export function installToolboxDock/);
  const exportFile=await fetch(url+'/api/features/handoff',{method:'POST',headers,body:'{}'});assert.equal(exportFile.status,200);for(const match of deskPage('test').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
test('提醒我不要迟到是合法内容，不要设置/取消则不改变计划',t=>{
  const f=fixture(t),args={kind:'alarm',title:'不要迟到',schedule:{type:'once',at:new Date(f.now+1000).toISOString()}};
  const plan=f.world.planner.create(K,f.auth('提醒我不要迟到'),args);assert.ok(plan.id);
  assert.throws(()=>f.world.planner.create(K,f.auth('不要设置提醒'),args),/本轮/);
  assert.throws(()=>f.world.planner.control(K,f.auth('不要取消这个闹钟'),plan.id,'cancel'),/本轮/);assert.equal(f.world.planner.get(K,'family',plan.id).enabled,true);
});
test('重启补发一次到期闹钟，发布后中断恢复不重复投递',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'life-restart-'));let now=Date.now()+1000;const f=fixture(t,{dir,file:true,clock:()=>now});const plan=f.world.planner.create(K,f.auth('提醒我取件，发到tg'),{kind:'alarm',title:'取件',destination:'tg',schedule:{type:'once',at:new Date(now+1000).toISOString()}});
  await f.world.close();f.store.close();now+=5000;const second=fixture(t,{dir,file:true,clock:()=>now});await settle(second,()=>second.sent.length===1);assert.equal(second.world.planner.runs(K,'family',plan.id).length,1);
  const run=second.world.planner.runs(K,'family',plan.id)[0];run.status='running';second.store.db.prepare("UPDATE planner_runs SET status='running',data=? WHERE id=?").run(JSON.stringify(run),run.id);await second.world.close();second.store.close();
  const third=fixture(t,{dir,file:true,clock:()=>now});await settle(third,()=>third.world.planner.runs(K,'family',plan.id)[0].status==='succeeded');assert.equal(third.sent.length,0);assert.equal(third.world.delivery.inbox(K,'family').filter(i=>i.key.startsWith('planner-urgent:')).length,1);await third.world.close();third.store.close();rmSync(dir,{recursive:true,force:true});
});
test('取消正在总结的计划，迟到模型结果不会写报告或对外发送',async t=>{
  let release!:()=>void,arrive!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>arrive=r);
  const f=fixture(t,{generate:async()=>{arrive();await gate;return reply('迟到的报告');}}),server=await pageServer(t),url=server.url+'/project';
  const plan=f.world.planner.create(K,f.auth('抓取并总结 '+url+'，发到tg'),{kind:'crawl',title:'会取消的报告',urls:[url],destination:'tg',schedule:{type:'once',at:new Date(f.now+1).toISOString()}});f.advance(10);await f.world.tick();await ready;f.world.planner.control(K,f.auth('取消这个计划'),plan.id,'cancel');release();await new Promise(r=>setTimeout(r,20));await f.world.tick();assert.equal(f.sent.length,0);assert.equal(f.world.planner.runs(K,'family',plan.id)[0].status,'cancelled');
});
test('人工修改标签胜过迟到分类结果，网页确切重复保留所有来源',async t=>{
  let release!:()=>void,arrive!:()=>void;const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>arrive=r);
  const f=fixture(t,{generate:async()=>{arrive();await gate;return reply(JSON.stringify({title:'旧AI标题',description:'旧说明',category:'other',tags:['旧标签']}));}});const file=await f.world.workspaces.create(K,'family',{name:'a.txt',mime:'text/plain',bytes:Buffer.from('安卓开源资料')});const item=(await f.world.toolbox.capture(K,f.auth('存工具箱','family',[file.id]),{artifactIds:[file.id]}))[0];
  await f.world.tick();await ready;f.world.toolbox.update(K,f.auth('修改标签'),item.id,{title:'人工标题',tags:['保留标签'],category:'tools'});release();await new Promise(r=>setTimeout(r,10));assert.equal(f.world.toolbox.get(K,'family',item.id).title,'人工标题');
  const g=fixture(t),server=await pageServer(t),urls=[server.url+'/one',server.url+'/two'];await g.world.toolbox.capture(K,g.auth('收藏 '+urls.join(' ')),{urls});await settle(g,()=>g.world.toolbox.search(K,'family').filter(i=>i.status==='ready').length===1 && Number((g.store.db.prepare("SELECT COUNT(*) AS n FROM toolbox_items WHERE status='pending' OR status='processing'").get() as any).n)===0);const merged=g.world.toolbox.search(K,'family')[0];assert.equal(merged.names.length,2);assert.ok(merged.artifactIds.length>=2);
});
test('聊天里安装的声明式扩展下一轮即作为真实工具可用，客户端不能占用ext命名空间',async t=>{
  let n=0;let dynamic='';const f=fixture(t,{generate:async(messages,tools)=>{
    n++;if(n===1)return reply('',[call('feature_install',{name:'数组计数',description:'统计items项数',parameters:{type:'object',properties:{items:{type:'array',items:{type:'number'}}},required:['items']},steps:[{op:'pick',path:'items'},{op:'aggregate',kind:'count'}],examples:[{input:{items:[1,2]},expected:2}]})]);
    if(n===2){dynamic=tools.find(t=>t.function.name.startsWith('ext_'))!.function.name;return reply('',[call(dynamic,{items:[1,2,3]})]);}
    assert.equal(messages.findLast(m=>m.role==='tool')!.content,'3');return reply('结果是3。');
  }});const result=await f.gateway.chat({messages:[{role:'user',content:'加一个数组计数功能，然后用它数三项'}]},'family','tg');assert.equal(result.choices[0].message.content,'结果是3。');assert.ok(dynamic);
  await assert.rejects(f.gateway.chat({messages:[{role:'user',content:'普通聊天'}],tools:[{type:'function',function:{name:dynamic,description:'假工具',parameters:{}}}]},'family','client'),/网关工具名/);
});
