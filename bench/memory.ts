import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FamilyStore} from '../src/store.ts';
import {FamilyGateway} from '../src/gateway.ts';
import {OWNER} from '../src/types.ts';
import type {Actor,Config} from '../src/types.ts';
const config:Config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const K:Actor={kind:'agent',id:'korax'};
const quantile=(a:number[],p:number)=>+a.toSorted((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*p))].toFixed(3);
const summary=(a:number[])=>({p50:quantile(a,.5),p95:quantile(a,.95)});
const dir=mkdtempSync(join(tmpdir(),'family-recall-bench-'));
try {
  const s=new FamilyStore(join(dir,'memory.sqlite'),structuredClone(config));
  try {
    const cases:[string,string,string][]=[
      ['毕业论文的实验数据放哪个数据库？','我的毕业论文选择 SQLite 存储实验数据。','shared'],
      ['乌鸦周五答应核对什么？','κόραξ答应周五核对社团预算。','shared'],
      ['夜间直播结束时的暗号是什么？','夜间直播的收尾暗号是银色纸鸢。','private'],
      ['采编部迎新摄影谁来做？','采编部的迎新摄影由我和小林共同负责。','shared'],
      ['论文的原始访谈保存在哪里？','论文原始访谈保存在加密移动硬盘。','shared'],
      ['之前换人为什么和文件附件有关？','那次换人是因为连续漏掉文件附件。','shared'],
      ['那次唱歌练习选了哪首曲子？','那次唱歌练习选了夜空中的星星。','shared'],
      ['为什么改用周六直播？','因为考试安排冲突，我把直播改到了周六。','shared'],
    ];
    const gold:{query:string;memoryId:string;sourceId:string;visibility:string}[]=[];
    s.db.exec('BEGIN IMMEDIATE');
    for(const [query,text,visibility] of cases) {
      const room=visibility==='private'?'private-korax':'family';
      const source=s.event(OWNER,room,'message',{message:{role:'user',content:text}});
      s.event(K,room,'message',{message:{role:'assistant',content:'这是当时的原始回复。'},agentId:K.id});
      const m=s.append(K,{roomId:room,visibility:visibility as 'shared'|'private',text,sources:[source.id]});
      gold.push({query,memoryId:m.id,sourceId:source.id,visibility});
    }
    const origin=s.event(OWNER,'family','user.note',{text:'用于合成负例的来源'});
    for(let i=0;i<600;i++)s.append(K,{roomId:'family',visibility:'shared',text:`第${i}份课程安排：周一下午小组讨论，第二天整理课堂笔记。`,sources:[origin.id]});
    for(let i=0;i<2000;i++) {
      s.event(OWNER,'family','message',{message:{role:'user',content:`课程笔记编号${i}。${'今天复习了一章教材，明天继续整理例题。'.repeat(8)}`}});
      s.event(K,'family','message',{message:{role:'assistant',content:`收到第${i}次课堂记录。${'我们可以按章节复习。'.repeat(8)}`},agentId:K.id});
    }
    s.db.exec('COMMIT');
    let calls=0;
    const promptSizes:number[]=[];
    const gateway=new FamilyGateway(s,s.config,async(messages,_tools,_model,delta)=>{
      calls++;promptSizes.push(JSON.stringify(messages).length);delta?.('已核对。');return {content:'已核对。',toolCalls:[],usage:{},finishReason:'stop'};
    });
    const localCases=gold.map(g=>{
      const recalled=s.search.search(K,'family',g.query,{limit:8});
      // Precisely reproduces the development baseline’s authored-memory automatic selection. Raw
      // source coverage is measured separately; this is an intentionally old-
      // evidence regression set, not a representative public memory benchmark.
      const baseline=[...s.memories(K,'family'),...s.memories(K,'private-korax').filter(m=>m.visibility==='private')].slice(0,20);
      const before=baseline.some(m=>m.id===g.memoryId),after=recalled.memories.some(m=>m.id===g.memoryId);
      const raw=recalled.episodes.some(e=>e.sources.some(x=>x.id===g.sourceId));
      return {query:g.query,visibility:g.visibility,latest20ContainsGold:before,recallAt8ContainsGold:after,rawEvidenceContainsGold:raw};
    });
    const cold:number[]=[],warm:number[]=[];
    for(let i=0;i<15;i++)for(const g of gold) {
      const first=s.search.search(K,'family',g.query,{limit:8});cold.push(first.metrics.elapsedMs);
      s.search.search(K,'family',g.query,{limit:8},gateway.cache);
      const hot=s.search.search(K,'family',g.query,{limit:8},gateway.cache);warm.push(hot.metrics.elapsedMs);
    }
    const first:number[]=[],total:number[]=[],retrieval:number[]=[];let queryCacheHits=0;
    const clients=['tg','wechat-clawbot','qq','chat-client','discord'];
    for(let i=0;i<110;i++) {
      const response=await gateway.chat({messages:[{role:'user',content:gold[i%gold.length].query}]},'family',clients[i%clients.length],()=>{});
      if(i>=10){first.push(response.family.firstTokenMs);total.push(response.family.totalMs);retrieval.push(response.family.cache.retrievalMs);if(response.family.cache.recallHit)queryCacheHits++;}
    }
    const result={version:'0.1.0',node:process.version,date:new Date().toISOString(),
      scope:'Local disk-backed SQLite; 608 authored memories + 4017 initial events; immediate mock model; no vendor/network latency.',
      evaluation:{kind:'Eight hand-authored old-evidence regression cases with synthetic distractors; not a held-out or public memory benchmark; not an answer-quality score.',cases:localCases},
      retrievalOnly:{uncached:summary(cold),warmCache:summary(warm),samplesPerMode:cold.length},
      gateway:{warmup:10,measured:100,firstTextMs:summary(first),totalMs:summary(total),retrievalMs:summary(retrieval),queryCacheHits,modelCalls:calls,maxPromptCharacters:Math.max(...promptSizes)},
      index:s.search.status(),cache:gateway.cache.stats()};
    if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
    if(localCases.some(c=>!c.recallAt8ContainsGold || !c.rawEvidenceContainsGold))process.exitCode=1;
  } finally {s.close();}
} finally {rmSync(dir,{recursive:true,force:true});}
