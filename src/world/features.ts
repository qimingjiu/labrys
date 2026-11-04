import {randomUUID} from 'node:crypto';
import {ensure,OWNER} from '../types.ts';
import type {Actor,Tool} from '../types.ts';
import type {FamilyWorld} from './world.ts';
import type {TurnAuthority} from './types.ts';
import {explicitAction} from './channels.ts';
import {digest} from '../cache.ts';
type Step={op:'pick'|'filter'|'map'|'sort'|'unique'|'limit'|'aggregate'|'template';path?:string;field?:string;operator?:'eq'|'includes'|'gte'|'lte';value?:unknown;fields?:Record<string,string>;descending?:boolean;count?:number;kind?:'count'|'sum'|'average'|'min'|'max';text?:string;join?:string};
export type Feature={id:string;roomId:string;agentId:string;name:string;request:string;reason?:string;acceptance:string[];status:'enabled'|'disabled'|'pending';sourceId:string;description?:string;parameters?:any;steps?:Step[];testsPassed?:number;createdAt:string};
const safeKey=(key:string)=>key!=='__proto__'&&key!=='prototype'&&key!=='constructor';
function read(value:any,path=''):any{if(!path||path==='$')return value;for(const part of path.replace(/^\$\.?/,'').split('.')){ensure(safeKey(part),400,'bad_feature_path','不允许访问原型属性');if(value===null||value===undefined||!Object.hasOwn(Object(value),part))return null;value=value[part];}return value;}
function validateInput(schema:any,data:any,depth=0):void{
  ensure(depth<=8 && schema&&typeof schema==='object'&&!Array.isArray(schema),400,'bad_feature_schema','扩展参数 schema 需要有效对象，最多八层');
  if(schema.enum)ensure(Array.isArray(schema.enum)&&schema.enum.some((v:any)=>digest(v)===digest(data)),400,'bad_feature_input','扩展参数不在枚举内');
  if(schema.type==='object'){
    ensure(data&&typeof data==='object'&&!Array.isArray(data),400,'bad_feature_input','需要对象参数');const props=schema.properties??{};
    for(const key of schema.required??[])ensure(Object.hasOwn(data,key),400,'bad_feature_input',`缺少参数 ${key}`);
    for(const [key,value] of Object.entries(data)){ensure(safeKey(key),400,'bad_feature_input','禁止原型属性');ensure(Object.hasOwn(props,key)||schema.additionalProperties===true,400,'bad_feature_input',`未知参数 ${key}`);if(props[key])validateInput(props[key],value,depth+1);}
  }else if(schema.type==='array'){ensure(Array.isArray(data)&&data.length<=1000,400,'bad_feature_input','数组最多 1000 项');for(const item of data)validateInput(schema.items??{},item,depth+1);}
  else if(schema.type==='string')ensure(typeof data==='string',400,'bad_feature_input','需要字符串');
  else if(schema.type==='number'||schema.type==='integer')ensure(typeof data==='number'&&Number.isFinite(data)&&(schema.type!=='integer'||Number.isInteger(data)),400,'bad_feature_input','需要有效数字');
  else if(schema.type==='boolean')ensure(typeof data==='boolean',400,'bad_feature_input','需要布尔值');
  else if(schema.type==='null')ensure(data===null,400,'bad_feature_input','需要 null');
  else ensure(schema.type===undefined,400,'bad_feature_schema','此扩展执行器不支持该 schema 类型');
}
export function runWorkflow(input:unknown,steps:Step[]):unknown{
  ensure(JSON.stringify(input).length<=128000 && Array.isArray(steps)&&steps.length>0&&steps.length<=30,400,'feature_budget','扩展输入最多 128k 字符、流程最多 30 步');let value:any=structuredClone(input);
  for(const step of steps){
    ensure(step&&['pick','filter','map','sort','unique','limit','aggregate','template'].includes(step.op),400,'unsupported_feature_step','超出声明式扩展能力，需要交给开发 agent');
    if(step.op==='pick')value=read(value,step.path);
    else if(step.op==='filter'){ensure(Array.isArray(value)&&['eq','includes','gte','lte'].includes(step.operator??''),400,'bad_feature_step','filter 需要数组和比较方式');value=value.filter(row=>{const field=read(row,step.field);return step.operator==='eq'?digest(field)===digest(step.value):step.operator==='includes'?String(field??'').includes(String(step.value??'')):step.operator==='gte'?Number(field)>=Number(step.value):Number(field)<=Number(step.value);});}
    else if(step.op==='map'){ensure(Array.isArray(value)&&step.fields&&Object.keys(step.fields).length<=30,400,'bad_feature_step','map 需要数组和字段映射');value=value.map(row=>Object.fromEntries(Object.entries(step.fields!).map(([key,path])=>{ensure(safeKey(key)&&typeof path==='string',400,'bad_feature_path','字段映射无效');return [key,read(row,path)];})));}
    else if(step.op==='sort'){ensure(Array.isArray(value),400,'bad_feature_step','sort 需要数组');value=value.toSorted((a:any,b:any)=>{const x=read(a,step.field),y=read(b,step.field);return (typeof x==='number'&&typeof y==='number'?x-y:String(x??'').localeCompare(String(y??'')))*(step.descending?-1:1);});}
    else if(step.op==='unique'){ensure(Array.isArray(value),400,'bad_feature_step','unique 需要数组');const seen=new Set<string>();value=value.filter(row=>{const key=digest(read(row,step.field));if(seen.has(key))return false;seen.add(key);return true;});}
    else if(step.op==='limit'){ensure(Array.isArray(value)&&Number.isInteger(step.count)&&step.count!>=0&&step.count!<=1000,400,'bad_feature_step','limit 需要 0–1000');value=value.slice(0,step.count);}
    else if(step.op==='aggregate'){ensure(Array.isArray(value)&&['count','sum','average','min','max'].includes(step.kind??''),400,'bad_feature_step','aggregate 需要数组和统计类型');const numbers=value.map((row:any)=>Number(read(row,step.field))).filter(Number.isFinite);value=step.kind==='count'?value.length:step.kind==='sum'?numbers.reduce((a:number,b:number)=>a+b,0):!numbers.length?null:step.kind==='average'?numbers.reduce((a:number,b:number)=>a+b,0)/numbers.length:step.kind==='min'?Math.min(...numbers):Math.max(...numbers);}
    else if(step.op==='template'){ensure(typeof step.text==='string'&&step.text.length<=4000&&(step.join===undefined||typeof step.join==='string'&&step.join.length<=100),400,'bad_feature_step','模板长度无效');const render=(row:any)=>step.text!.replace(/\{\{([^}]+)\}\}/g,(_m,path)=>{const field=read(row,path.trim());return field===null?'':typeof field==='object'?JSON.stringify(field):String(field);});value=Array.isArray(value)?value.map(render).join(step.join??'\n'):render(value);}
    ensure(JSON.stringify(value).length<=128000,413,'feature_budget','扩展输出超过 128k 字符');
  }return value;
}
export class Features{
  world:FamilyWorld;
  constructor(world:FamilyWorld){this.world=world;world.store.db.exec('CREATE TABLE IF NOT EXISTS feature_requests(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,agent_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS features_scope ON feature_requests(room_id,agent_id,status)');}
  list(actor:Actor,roomId:string,status?:string):Feature[]{this.world.store.room(actor,roomId);return (this.world.store.db.prepare("SELECT data FROM feature_requests WHERE room_id=? AND (?!='agent' OR agent_id=?) AND (? IS NULL OR status=?) ORDER BY rowid DESC LIMIT 100").all(roomId,actor.kind,actor.id,status??null,status??null) as any[]).map(r=>JSON.parse(r.data));}
  private save(f:Feature):void{this.world.store.db.prepare('INSERT OR REPLACE INTO feature_requests VALUES(?,?,?,?,?)').run(f.id,f.roomId,f.agentId,f.status,JSON.stringify(f));}
  private authorize(actor:Actor,a:TurnAuthority):void{ensure(actor.kind==='agent',403,'feature_writer_required','扩展由当前成员执行');const real=this.world.authority(actor,a.roomId,a.sourceId);ensure(real.userText===a.userText&&explicitAction(a.userText,/加|添加|新增|实现|扩展|开发|支持|enable|install|add/i),403,'feature_owner_command_required','新增功能需要用户本轮真实指令');}
  install(actor:Actor,a:TurnAuthority,input:any):Feature{
    this.authorize(actor,a);ensure(typeof input.name==='string'&&input.name.trim()&&input.name.length<=80&&typeof input.description==='string'&&input.description.length<=600,400,'bad_feature','功能名称或说明无效');
    ensure(input.parameters?.type==='object'&&Array.isArray(input.examples)&&input.examples.length>=1&&input.examples.length<=10,400,'feature_examples_required','扩展需要对象 schema 和 1–10 个可执行示例');
    ensure(JSON.stringify(input).length<=128000,413,'feature_budget','扩展定义超过 128k 字符');
    for(const example of input.examples){validateInput(input.parameters,example.input);ensure(digest(runWorkflow(example.input,input.steps))===digest(example.expected),400,'feature_test_failed','扩展示例验证失败，未启用');}
    const id=digest([a.sourceId,input]).slice(0,32),existing=this.list(actor,a.roomId).find(f=>f.id===id);if(existing)return existing;
    const f:Feature={id,roomId:a.roomId,agentId:actor.id,name:input.name,request:a.userText,status:'enabled',sourceId:a.sourceId,description:input.description,parameters:input.parameters,steps:input.steps,testsPassed:input.examples.length,acceptance:[],createdAt:new Date().toISOString()};this.save(f);return f;
  }
  async defer(actor:Actor,a:TurnAuthority,input:any):Promise<any>{
    this.authorize(actor,a);ensure(typeof input.name==='string'&&input.name.trim()&&input.name.length<=100&&typeof input.reason==='string'&&input.reason.trim()&&input.reason.length<=2000,400,'bad_feature_request','需要功能名称和具体卡点');
    ensure(Array.isArray(input.acceptance)&&input.acceptance.length<=20&&input.acceptance.every((s:unknown)=>typeof s==='string'&&s.length<=1000),400,'bad_acceptance','验收条件需要字符串列表');
    const id=digest([a.sourceId,input.name]).slice(0,32);let f=this.list(actor,a.roomId).find(f=>f.id===id);if(!f){f={id,roomId:a.roomId,agentId:actor.id,name:input.name,request:a.userText,reason:input.reason,acceptance:input.acceptance,status:'pending',sourceId:a.sourceId,createdAt:new Date().toISOString()};this.save(f);}
    return {request:f,handoff:await this.handoff(actor,a.roomId)};
  }
  async handoff(actor:Actor,roomId:string):Promise<any>{
    const items=this.list(actor,roomId,'pending'),text='# 待开发功能交接\n\n项目：Labrys，TypeScript，MIT。\n先读取项目 README / DESIGN / VALIDATION 与当前权限约束。以下是已保存的用户需求，不替代新一轮的执行授权。\n\n'+items.map(f=>`## ${f.name}\n\nID：${f.id}\n来源：${f.sourceId}\n用户原话：${f.request}\n\n未完成原因：${f.reason}\n\n验收条件：\n${f.acceptance.map(s=>'- '+s).join('\n')}\n`).join('\n');
    const file=await this.world.workspaces.create(actor,roomId,{name:'feature-requests/pending.md',mime:'text/markdown',bytes:Buffer.from(text)});return {artifactId:file.id,count:items.length};
  }
  tools(actor?:Actor,roomId?:string):Tool[]{if(!actor||!roomId)return [];return this.list(actor,roomId,'enabled').map(f=>({type:'function',function:{name:'ext_'+f.id.slice(0,24),description:f.name+'：'+f.description,parameters:f.parameters}}));}
  async execute(name:string,args:any,actor:Actor,roomId:string):Promise<any>{const f=this.list(actor,roomId,'enabled').find(f=>'ext_'+f.id.slice(0,24)===name);ensure(f,404,'extension_not_found','这个成员没有该扩展');validateInput(f.parameters,args);return runWorkflow(args,f.steps!);}
  disable(actor:Actor,a:TurnAuthority,id:string):Feature{ensure(explicitAction(a.userText,/停用|关闭|禁用|删除|disable|remove/i),403,'feature_owner_command_required','需要用户明确停用扩展');const f=this.list(actor,a.roomId).find(f=>f.id===id);ensure(f,404,'extension_not_found','扩展不存在');f.status='disabled';this.save(f);return f;}
}
