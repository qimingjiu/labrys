import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { FamilyStore } from '../src/store.ts';
import { FamilyGateway } from '../src/gateway.ts';
import { createFamilyServer } from '../src/server.ts';
import { OWNER, CONTROLLER } from '../src/types.ts';
import type { Actor, Config, Message, ToolCall } from '../src/types.ts';

const template: Config = JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const K:Actor={kind:'agent',id:'korax'}, W:Actor={kind:'agent',id:'kirishima'};
const completion = (content='继续。',toolCalls:ToolCall[]=[]) => ({content,toolCalls,usage:{},finishReason:toolCalls.length?'tool_calls':'stop'});
const body = (content:string) => ({messages:[{role:'user' as const,content}]});
const call = (name:string,args:any):ToolCall => ({id:'recall-call',type:'function',function:{name,arguments:JSON.stringify(args)}});
const note = (s:FamilyStore,text:string,room='family') => s.event(OWNER,room,'message',{message:{role:'user',content:text}});
function fixture(t:any) { const store=new FamilyStore(':memory:',structuredClone(template));t.after(()=>store.close());return store; }
const has = (r:any,id:string)=>r.memories.some((m:any)=>m.id===id) || r.episodes.some((e:any)=>e.sources.some((s:any)=>s.id===id));

test('旧记忆按中文问题召回，不再只取最新20条；私人记忆不会被共享记录挤掉',t=>{
  const s=fixture(t),origin=note(s,'原始说明');
  const shared=s.append(K,{roomId:'family',visibility:'shared',text:'我的毕业论文使用 SQLite 保存实验记录。',sources:[origin.id]});
  const privateOrigin=note(s,'夜间直播的收尾暗号叫银色纸鸢。','private-korax');
  const privateMemory=s.append(K,{roomId:'private-korax',visibility:'private',text:'夜间直播的收尾暗号叫银色纸鸢。',sources:[privateOrigin.id]});
  for(let i=0;i<150;i++)s.append(K,{roomId:'family',visibility:'shared',text:`第${i}份课程安排，周一下午有小组讨论。`,sources:[origin.id]});
  const a=s.search.search(K,'family','毕业论文的实验记录放哪个数据库？');
  assert.ok(has(a,shared.id));assert.ok(!s.memories(K,'family').slice(0,20).some(m=>m.id===shared.id));
  const b=s.search.search(K,'family','我夜间直播结束时的暗号是什么？');
  assert.ok(has(b,privateMemory.id));assert.ok(!JSON.stringify(s.search.search(W,'family','银色纸鸢')).includes(privateMemory.id));
});
test('别名检索与追加补充能命中；没有相关证据不会返回任意近期条目',t=>{
  const s=fixture(t),origin=note(s,'κόραξ答应周五核对社团预算。');
  assert.ok(has(s.search.search(K,'family','乌鸦周五要核对什么？'),origin.id));
  const m=s.append(K,{roomId:'family',visibility:'shared',text:'校社联工作安排',sources:[origin.id]});
  s.operate(K,m.id,'supplement','迎新摄影交给采编部',[origin.id]);
  assert.ok(has(s.search.search(K,'family','迎新摄影谁负责？'),m.id));
  const empty=s.search.search(K,'family','火星采矿许可证');assert.equal(empty.memories.length,0);assert.equal(empty.episodes.length,0);
});
test('命中后展开完整轮组，保留转述的实际作者和原文，不把下一轮拼进来',t=>{
  const s=fixture(t),u=note(s,'雾岛纪说「喜欢薄荷」，这是我转述的。');
  const a=s.event(W,'family','message',{message:{role:'assistant',content:'是你刚才转述给我的。'},agentId:'kirishima'});
  note(s,'下一轮无关的话题');
  const r=s.search.search(K,'family','薄荷');
  const episode=r.episodes.find(e=>e.hitIds.includes(u.id))!;
  assert.deepEqual(episode.sources.map(x=>x.id),[u.id,a.id]);
  assert.equal(episode.sources[0].actorId,'owner');assert.equal(episode.sources[1].actorId,'kirishima');
  assert.equal((episode.sources[0].data as any).message.content,'雾岛纪说「喜欢薄荷」，这是我转述的。');
  assert.ok(episode.complete);
});
test('私人房间原话可由本人跨端召回；显式相邻轮展开保留前因后果和权限',t=>{
  const s=fixture(t),privateText=note(s,'湖蓝色约定只是私下告诉乌鸦。','private-korax');
  const own=s.search.search(K,'family','湖蓝色约定',{beforeSeq:0});assert.ok(has(own,privateText.id));
  const other=s.search.search(W,'family','湖蓝色约定');assert.ok(!has(other,privateText.id));
  const before=note(s,'活动改期是因为暴雨。'), middle=note(s,'所以改到了周六。');
  const secret=s.event(W,'family','message',{message:{role:'assistant',content:'不会传给乌鸦的内部推测'},privateTo:'kirishima'});
  const after=note(s,'后来天气好转，仍按新时间执行。');note(s,'无关的新话题');
  const span=s.search.episode(K,'family',middle.id,undefined,1);
  assert.ok(span.sources.some(e=>e.id===before.id));assert.ok(span.sources.some(e=>e.id===after.id));assert.ok(!span.sources.some(e=>e.id===secret.id));
  assert.throws(()=>s.search.episode(K,'family',middle.id,undefined,3),/0–2/);
});
test('关联端点按 memoryId 精确回读，不能借工具跨房间取别人的记忆',async t=>{
  const s=fixture(t),source=note(s,'明确记录');const memory=s.append(K,{roomId:'family',visibility:'shared',text:'精确回读的记忆正文',sources:[source.id]});let n=0;let tool:any;
  const gateway=new FamilyGateway(s,s.config,async messages=>{
    if(++n===1)return completion('',[call('family_read',{memoryId:memory.id})]);
    tool=JSON.parse(String(messages.findLast(m=>m.role==='tool')!.content));return completion();
  });
  await gateway.chat(body('读这条记忆'),'family','tg');assert.equal(tool[0].id,memory.id);assert.equal(tool[0].text,'精确回读的记忆正文');
});
test('权限过滤发生在Top-K前，且缓存命中后仍检查来源的实时房间权限',t=>{
  const s=fixture(t),gateway=new FamilyGateway(s,s.config,async()=>completion());
  const origin=note(s,'预算核对公示');
  const visible=s.append(K,{roomId:'family',visibility:'shared',text:'预算核对公开来源',sources:[origin.id]});
  for(let i=0;i<100;i++) {
    s.append(W,{roomId:'family',visibility:'private',text:`预算核对私密${i}`,sources:[origin.id]});
    s.event(W,'family','message',{message:{role:'assistant',content:'预算核对私密原话'},privateTo:'kirishima'});
  }
  const result=s.search.search(K,'family','预算核对',{limit:1},gateway.cache);
  assert.equal(result.memories[0].id,visible.id);assert.ok(!JSON.stringify(result).includes('私密'));
  s.createRoom(OWNER,'archive','旧房间',['korax','kirishima'],'korax');
  const old=note(s,'限时共同见证','archive');
  const derived=s.append(K,{roomId:'family',visibility:'shared',text:'限时共同见证',sources:[old.id]});
  assert.ok(has(s.search.search(K,'family','限时共同见证',{},gateway.cache),derived.id));
  s.db.prepare('UPDATE rooms SET members=? WHERE id=?').run(JSON.stringify(['kirishima']),'archive');
  const revoked=s.search.search(K,'family','限时共同见证',{},gateway.cache);
  assert.ok(!has(revoked,derived.id));assert.throws(()=>s.memory(K,derived.id),/权限/);
  assert.ok(s.memory(CONTROLLER,derived.id));
});
test('适用时间和记录时间分开；未知时间保留，历史查询不会被较新的限定覆盖',t=>{
  const s=fixture(t),origin=note(s,'明确约定');
  const old=s.append(OWNER,{roomId:'family',visibility:'shared',kind:'fact',text:'直播安排在周五',sources:[origin.id],validity:{validFrom:'2026-01-01T00:00:00+08:00',validUntil:'2026-06-01T00:00:00+08:00'}});
  const now=s.append(K,{roomId:'family',visibility:'shared',text:'直播安排在周六',sources:[origin.id],validity:{validFrom:'2026-06-01T00:00:00+08:00',context:'仅考试期间'}});
  const unknown=s.append(K,{roomId:'family',visibility:'shared',text:'直播安排待商量',sources:[origin.id]});
  s.relate(K,now.id,old.id,'qualifies',[origin.id]);
  const past=s.search.search(K,'family','直播安排',{asOf:'2026-02-01T00:00:00Z'});
  assert.ok(has(past,old.id));assert.ok(!has(past,now.id));assert.ok(has(past,unknown.id));
  const current=s.search.search(K,'family','直播安排',{asOf:'2026-07-01T00:00:00Z'});
  assert.ok(!has(current,old.id));assert.ok(has(current,now.id));
  assert.equal(s.memory(K,old.id).text,'直播安排在周五');assert.ok(s.memory(K,old.id).recordedAt);
  assert.throws(()=>s.append(K,{roomId:'family',visibility:'shared',text:'错误时间',sources:[origin.id],validity:{validFrom:'昨天'}}),/ISO/);
  assert.throws(()=>s.search.search(K,'family','直播',{recordedAfter:'2026-05-01T00:00:00Z',recordedBefore:'2026-01-01T00:00:00Z'}),/颠倒/);
});
test('修订关系有署名和来源、候选状态；一跳回读不覆盖正文，也不能泄露私密端点',t=>{
  const s=fixture(t),origin=note(s,'更正记录');
  const old=s.append(K,{roomId:'family',visibility:'shared',text:'活动预算应交给纪检部',sources:[origin.id]});
  const updated=s.append(W,{roomId:'family',visibility:'shared',text:'更正：应交给财务组',sources:[origin.id]});
  const link=s.relate(W,updated.id,old.id,'corrects',[origin.id]);
  assert.equal(link.actorId,'kirishima');assert.equal(link.status,'candidate');
  const r=s.search.search(K,'family','纪检部');assert.ok(has(r,old.id));assert.ok(has(r,updated.id));
  assert.equal(s.memory(K,old.id).text,'活动预算应交给纪检部');
  assert.throws(()=>s.relate(K,old.id,updated.id,'supersedes',[origin.id]),/循环/);
  assert.throws(()=>s.relate(CONTROLLER,updated.id,old.id,'contradicts',[origin.id]),/总控/);
  const secret=s.append(K,{roomId:'family',visibility:'private',text:'秘密目标',sources:[origin.id]});
  assert.throws(()=>s.relate(K,updated.id,secret.id,'qualifies',[origin.id]),/私人/);
  s.relate(K,secret.id,updated.id,'qualifies',[origin.id]);
  assert.ok(!JSON.stringify(s.memory(W,updated.id)).includes(secret.id));
});
test('查询缓存跨客户端复用，原话新增、记忆修改和权限变更立即使相应层失效',async t=>{
  const s=fixture(t),gateway=new FamilyGateway(s,s.config,async()=>completion()),origin=note(s,'茶歇安排');
  const m=s.append(K,{roomId:'family',visibility:'shared',text:'茶歇安排是下午三点',sources:[origin.id]});
  const first=s.search.search(K,'family','茶歇安排',{},gateway.cache);
  const repeat=s.search.search(K,'family','茶歇安排',{},gateway.cache);
  assert.ok(!first.metrics.memoryHit && !first.metrics.evidenceHit);assert.ok(repeat.metrics.memoryHit && repeat.metrics.evidenceHit);
  const n=note(s,'茶歇安排改为四点');
  const rawChanged=s.search.search(K,'family','茶歇安排',{},gateway.cache);
  assert.ok(rawChanged.metrics.memoryHit && !rawChanged.metrics.evidenceHit);assert.ok(has(rawChanged,n.id));
  s.operate(OWNER,m.id,'challenge','时间需要核对',[n.id]);
  const changed=s.search.search(K,'family','茶歇安排',{},gateway.cache);assert.ok(!changed.metrics.memoryHit);assert.equal(changed.memories[0].status,'contested');
  const replies=[];for(const client of ['tg','wechat-clawbot','qq','client','discord']) replies.push(await gateway.chat(body('茶歇安排'), 'family', client));
  assert.ok(replies.slice(1).every(r=>r.family.cache.recallHit));
  assert.equal(new Set(replies.map(r=>r.family.agentId)).size,1);
});
test('旧原话超出300条近期窗口仍自动召回；当前问题不会作为自己的证据，模型调用一次',async t=>{
  const s=fixture(t);const original=note(s,'当时换人是因为κόραξ连续漏掉了文件附件。标点，AbC😈！');
  const answer=s.event(K,'family','message',{message:{role:'assistant',content:'我记下了附件遗漏这个问题。'},agentId:'korax'});
  for(let i=0;i<180;i++){note(s,`无关的课堂笔记编号${i}`);s.event(K,'family','message',{message:{role:'assistant',content:'收到课程记录。'},agentId:'korax'});}
  let seen:Message[]=[];let calls=0;const gateway=new FamilyGateway(s,s.config,async m=>{seen=m;calls++;return completion();});
  const r=await gateway.chat(body('当时为什么换人？是不是文件附件漏了？'),'family','tg');
  const data=seen.find(m=>String(m.content).startsWith('家庭记录数据'))!;
  assert.match(String(data.content),new RegExp(original.id));assert.match(String(data.content),new RegExp(answer.id));
  assert.match(String(data.content),/标点，AbC😈！/);assert.ok(!String(data.content).includes('当时为什么换人？是不是文件附件漏了？'));
  assert.equal(calls,1);assert.equal(r.family.toolRounds,0);assert.equal(r.family.cache.indexReady,true);
});
test('上下文按完整记录控制预算；超大证据不硬塞、不修改原文，可显式分页核对',async t=>{
  const s=fixture(t);s.config.maxContextCharacters=4000;
  const original=note(s,'巨型原话：'+ '海蓝色纸鸢，'.repeat(4000));
  for(let i=0;i<160;i++){note(s,`普通课程${i}`);s.event(K,'family','message',{message:{role:'assistant',content:'收到。'},agentId:'korax'});}
  let n=0;const results:any[]=[];const gateway=new FamilyGateway(s,s.config,async messages=>{
    n++;assert.ok(JSON.stringify(messages).length<=4000);
    if(n===1) return completion('',[call('family_source',{sourceId:original.id,offset:0,limit:100})]);
    results.push(JSON.parse(String(messages.findLast(m=>m.role==='tool')!.content)));return completion();
  });
  await gateway.chat(body('海蓝色纸鸢的原话呢？'),'family','tg');
  assert.equal(results[0].complete,false);assert.equal(results[0].nextOffset,100);assert.equal(results[0].actorId,'owner');
  assert.equal((s.source(K,original.id).data as any).message.content.length,24005);
});
test('索引故障走有限原文降级；重建不会删原文，后台补建能恢复完整召回',t=>{
  const s=fixture(t),u=note(s,'橄榄枝记录');s.db.exec('DROP TABLE recall_fts');
  const fallback=s.search.search(K,'family','橄榄枝');assert.ok(has(fallback,u.id));assert.equal(fallback.metrics.indexReady,false);
  s.search.rebuild();while(!s.search.backfill(10)){}
  const rebuilt=s.search.search(K,'family','橄榄枝');assert.ok(rebuilt.metrics.indexReady);assert.ok(has(rebuilt,u.id));assert.ok(s.source(K,u.id));
});
test('超大检索工具结果返回回读指针，避免工具结果挤爆当前轮；引号计入实际预算',async t=>{
  const s=fixture(t);s.config.maxContextCharacters=4000;
  const original=note(s,'纸鸢的完整档案 '+ '"长原话\\下一行\n"'.repeat(2000));
  for(let i=0;i<160;i++){note(s,`普通课堂${i}`);s.event(K,'family','message',{message:{role:'assistant',content:'收到。'},agentId:'korax'});}
  let n=0,tool:any;const gateway=new FamilyGateway(s,s.config,async messages=>{
    assert.ok(JSON.stringify(messages).length<=4000);
    if(++n===1)return completion('',[call('family_recall',{query:'纸鸢的完整档案'})]);
    tool=JSON.parse(String(messages.findLast(m=>m.role==='tool')!.content));return completion();
  });
  await gateway.chat(body('纸鸢的完整档案在哪里？'),'family','tg');assert.ok(tool.omitted.some((o:any)=>o.sourceIds?.includes(original.id)));
  assert.equal(tool.episodes.length,0);assert.ok(s.source(K,original.id));
});
test('开发期旧表自动迁移，未知记录时间不伪造；补建可中断后重启接续',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'family-memory-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'old.sqlite');
  let s=new FamilyStore(path,structuredClone(template));const u=note(s,'旧版档案的紫色便签');const m=s.append(K,{roomId:'family',visibility:'shared',text:'旧版档案的紫色便签',sources:[u.id]});s.close();
  const db=new DatabaseSync(path);db.exec(`DROP TRIGGER memories_epoch; DROP TRIGGER memory_ops_epoch; DROP TRIGGER memory_relations_epoch;
    DROP TABLE recall_fts; DROP TABLE recall_docs; DROP TABLE recall_state;
    ALTER TABLE memories DROP COLUMN recorded_at; ALTER TABLE memories DROP COLUMN valid_from; ALTER TABLE memories DROP COLUMN valid_until; ALTER TABLE memories DROP COLUMN context;
    ALTER TABLE memory_ops DROP COLUMN recorded_at;`);db.close();
  s=new FamilyStore(path,structuredClone(template));assert.equal(s.memory(K,m.id).recordedAt,null);assert.equal(s.search.status().ready,false);
  s.search.backfill(1);s.close();s=new FamilyStore(path,structuredClone(template));t.after(()=>s.close());
  for(let i=0;i<20 && !s.search.ready();i++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.ok(s.search.ready());assert.ok(has(s.search.search(K,'family','紫色便签'),m.id));
  assert.equal((s.source(K,u.id).data as any).message.content,'旧版档案的紫色便签');
});
test('回读来源不接受跨成员来源和身份伪造；HTTP新入口需要认证',async t=>{
  const s=fixture(t),secret=note(s,'秘密原话','private-kirishima');let n=0;const seen:Message[][]=[];
  const gateway=new FamilyGateway(s,s.config,async m=>{seen.push(m);return ++n===1?completion('',[call('family_source',{sourceId:secret.id})]):completion();});
  await gateway.chat(body('回读一下'),'family','qq');assert.match(JSON.stringify(seen[1]),/room_forbidden/);assert.ok(!JSON.stringify(seen[1]).includes('秘密原话'));
  const server=createFamilyServer(s,gateway,'test-memory-long-token');server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const url=`http://127.0.0.1:${(server.address() as any).port}`,headers={Authorization:'Bearer test-memory-long-token','Content-Type':'application/json'};
  assert.equal((await fetch(url+'/api/memory-index')).status,401);
  const response=await fetch(url+'/api/recall',{method:'POST',headers,body:JSON.stringify({query:'回读'})});assert.equal(response.status,200);
  const status=await fetch(url+'/api/memory-index',{headers}).then(r=>r.json()) as any;assert.equal(status.mode,'lexical');
});
