import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {FamilyStore} from '../src/store.ts';
import {FamilyGateway} from '../src/gateway.ts';
import {FamilyWorld} from '../src/world/world.ts';
import {SecretVault} from '../src/mcp/vault.ts';
import {OWNER} from '../src/types.ts';
import type {Config} from '../src/types.ts';
import type {Generate} from '../src/provider.ts';

const template:Config=JSON.parse(readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
const percentile=(v:number[],p:number)=>+v.toSorted((a,b)=>a-b)[Math.min(v.length-1,Math.floor(v.length*p))].toFixed(3);
const stats=(v:number[])=>({p50:percentile(v,.5),p95:percentile(v,.95)});
const dir=mkdtempSync(join(tmpdir(),'family-desk-bench-')),results:any[]=[];
try{
  for(const worldEnabled of [false,true]){
    const store=new FamilyStore(join(dir,String(worldEnabled)+'.sqlite'),structuredClone(template));let world:FamilyWorld|undefined;
    try{
      store.db.exec('BEGIN');for(let i=0;i<150;i++){store.event(OWNER,'family','message',{message:{role:'user',content:`过去第${i}轮。`+'这是完整的课程笔记。'.repeat(20)}});store.event({kind:'agent',id:'korax'},'family','message',{message:{role:'assistant',content:`过去第${i}轮的回复。`+'这是原始回复。'.repeat(20)},agentId:'korax'});}store.db.exec('COMMIT');
      let calls=0,toolCount=0;const generate:Generate=async(_messages,tools,_model,delta)=>{calls++;toolCount=tools.length;delta?.('即时回复。');return {content:'即时回复。',toolCalls:[],usage:{},finishReason:'stop'};};
      const gateway=new FamilyGateway(store,store.config,generate);if(worldEnabled){const vault=new SecretVault(store.db,join(dir,'vault'));world=new FamilyWorld(store,join(dir,'world'),generate,{secrets:vault});gateway.world=world;}
      const first:number[]=[],total:number[]=[],clients=['tg','wechat-clawbot','qq','client','discord'];
      for(let i=0;i<110;i++){const r=await gateway.chat({messages:[{role:'user',content:`继续第${i}次聊天。`}]},'family',clients[i%clients.length],()=>{});if(i>=10){first.push(r.family.firstTokenMs);total.push(r.family.totalMs);}}
      results.push({worldEnabled,measured:100,warmup:10,modelCalls:calls,toolCount,firstTextMs:stats(first),totalMs:stats(total)});
    }finally{await world?.close();store.close();}
  }
  const result={version:'0.1.0',node:process.version,date:new Date().toISOString(),scope:'Disk SQLite, 150 initial turns, five client labels, immediate in-process model. Healthy foreground requests; world/desk enabled but no active background jobs. No HTTP, prompt processing, actual model, vendor cache or network wait.',results};
  if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
