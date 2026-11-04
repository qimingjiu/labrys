import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FamilyStore} from '../src/store.ts';
import {FamilyGateway} from '../src/gateway.ts';
import {OWNER} from '../src/types.ts';
import type {Config} from '../src/types.ts';
import type {Generate} from '../src/provider.ts';
const template:Config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const quantile=(v:number[],p:number)=>+v.toSorted((a,b)=>a-b)[Math.min(v.length-1,Math.floor(v.length*p))].toFixed(3);
const summary=(v:number[])=>({p50:quantile(v,.5),p95:quantile(v,.95)});
const dir=mkdtempSync(join(tmpdir(),'family-model-bench-')),results:any[]=[];
try{
  for(const routed of [false,true]){
    const config=structuredClone(template);if(routed)config.modelRouting={providers:[{id:'mock',name:'本地替身',baseURL:'https://mock.invalid/v1'}],routes:[{id:'main',providerId:'mock',model:'mock-main'},{id:'backup',providerId:'mock',model:'mock-backup'}],defaultRouteId:'main',fallbackRouteIds:['backup','main']};
    const store=new FamilyStore(join(dir,String(routed)+'.sqlite'),config);
    try{
      store.db.exec('BEGIN');for(let i=0;i<150;i++){store.event(OWNER,'family','message',{message:{role:'user',content:`过去第${i}轮。`+'这是完整的课程笔记。'.repeat(20)}});store.event({kind:'agent',id:'korax'},'family','message',{message:{role:'assistant',content:`过去第${i}轮的回复。`+'这是原始回复。'.repeat(20)},agentId:'korax'});}store.db.exec('COMMIT');
      let modelCalls=0;const generate:Generate=async(_messages,_tools,_model,delta)=>{modelCalls++;delta?.('即时回复。');return {content:'即时回复。',toolCalls:[],usage:{},finishReason:'stop'};};
      const gateway=new FamilyGateway(store,config,generate);gateway.router.options.factory=()=>generate;
      const first:number[]=[],total:number[]=[],retrieval:number[]=[];const clients=['tg','wechat-clawbot','qq','client','discord'];
      for(let i=0;i<110;i++){const r=await gateway.chat({messages:[{role:'user',content:`继续第${i}次聊天。`}]},'family',clients[i%clients.length],()=>{});if(i>=10){first.push(r.family.firstTokenMs);total.push(r.family.totalMs);retrieval.push(r.family.cache.retrievalMs);}}
      results.push({routing:routed,measured:100,warmup:10,modelCalls,firstTextMs:summary(first),totalMs:summary(total),retrievalMs:summary(retrieval)});
    }finally{store.close();}
  }
  const result={version:'0.1.0',node:process.version,date:new Date().toISOString(),scope:'Disk-backed SQLite + immediate in-process model; no HTTP/vendor/network latency. Same 150 initial turns and five client labels in each mode. Healthy requests only.',results};
  if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
