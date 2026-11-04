import {readFileSync} from 'node:fs';
import {AppError,OWNER,ensure} from './types.ts';
import type {Message,Tool} from './types.ts';
import type {FamilyStore} from './store.ts';
import {openAIProvider,UpstreamError} from './provider.ts';
import type {Generate,Completion,GenerationOptions} from './provider.ts';
import {normalize} from './commands.ts';
import {digest} from './cache.ts';

export type ModelProvider={id:string;name:string;aliases?:string[];baseURL:string;apiKeyEnv?:string;keyRef?:string};
export type ModelRoute={id:string;providerId:string;model:string;name?:string;aliases?:string[];capabilities?:{tools?:boolean;vision?:boolean}};
export type ModelRoutingConfig={providers:ModelProvider[];routes:ModelRoute[];defaultRouteId:string;fallbackRouteIds?:string[];maxAttempts?:number;firstTokenTimeoutMs?:number;attemptTimeoutMs?:number;totalTimeoutMs?:number;cooldownSeconds?:number};
type Settings=ModelRoutingConfig & Required<Pick<ModelRoutingConfig,'maxAttempts'|'firstTokenTimeoutMs'|'attemptTimeoutMs'|'totalTimeoutMs'|'cooldownSeconds'|'fallbackRouteIds'>>;
type Options={secrets?:{value:(ref:string)=>string};env?:NodeJS.ProcessEnv;clock?:()=>number;factory?:typeof openAIProvider};
type State={agent_id:string;route_id:string;revision:number;forced:number;last_success:string|null};
type Menu={stage:'providers'|'routes';ids:string[];agentId:string;expires:number;config:string};
const id=(v:unknown)=>typeof v==='string' && /^[a-z][a-z0-9_-]{0,47}$/.test(v);
const aliasList=(v:any)=>v===undefined || Array.isArray(v) && v.length<=30 && v.every((x:any)=>typeof x==='string' && x.trim() && x.length<=160);
const exact=(input:string,names:(string|undefined)[])=>names.some(n=>n && normalize(n.trim())===normalize(input.trim()));
export function validateModelRouting(raw:unknown):Settings {
  ensure(raw && typeof raw==='object' && !Array.isArray(raw),400,'bad_model_config','模型配置需要对象');
  const c=raw as ModelRoutingConfig;
  ensure(Object.keys(c).every(k=>['providers','routes','defaultRouteId','fallbackRouteIds','maxAttempts','firstTokenTimeoutMs','attemptTimeoutMs','totalTimeoutMs','cooldownSeconds'].includes(k)),400,'bad_model_config','模型配置含未知字段');
  ensure(Array.isArray(c.providers) && c.providers.length>0 && c.providers.length<=30 && Array.isArray(c.routes) && c.routes.length>0 && c.routes.length<=500,400,'bad_model_config','需要 1–30 个服务商及 1–500 个模型路由');
  const providers=new Set<string>(),routes=new Set<string>(),providerAliases=new Map<string,string>();
  for(const p of c.providers){
    ensure(p && id(p.id) && !providers.has(p.id) && typeof p.name==='string' && p.name.trim() && p.name.length<=100 && aliasList(p.aliases),400,'bad_model_provider','服务商 ID、名称或别名无效');providers.add(p.id);
    ensure(!Object.keys(p).some(k=>!['id','name','aliases','baseURL','apiKeyEnv','keyRef'].includes(k)),400,'bad_model_provider','服务商仅接受凭据引用，不能内嵌密钥');
    let url:URL;try{url=new URL(p.baseURL);}catch{throw new AppError(400,'bad_model_url','服务商需要有效完整地址');}
    ensure(['https:','http:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search,400,'bad_model_url','服务商地址不能含用户名、密码、查询或片段');
    ensure(!p.apiKeyEnv || /^[A-Z][A-Z0-9_]{0,100}$/.test(p.apiKeyEnv),400,'bad_model_provider','apiKeyEnv 需要环境变量名');
    ensure(!p.keyRef || typeof p.keyRef==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(p.keyRef),400,'bad_model_provider','keyRef 需要已保存的凭据引用');
    ensure(!(p.apiKeyEnv && p.keyRef),400,'bad_model_provider','一个服务商只选择一种凭据引用');
    for(const name of [p.id,p.name,...p.aliases??[]]){const key=normalize(name);ensure(!providerAliases.has(key)||providerAliases.get(key)===p.id,400,'ambiguous_model_provider','服务商名称或别名重复');providerAliases.set(key,p.id);}
  }
  for(const r of c.routes){ensure(r && id(r.id) && !routes.has(r.id) && providers.has(r.providerId) && typeof r.model==='string' && r.model.trim()===r.model && r.model.length>0 && r.model.length<=300 && !/[\r\n\0]/.test(r.model) && (!r.name || typeof r.name==='string' && r.name.length<=100) && aliasList(r.aliases),400,'bad_model_route','模型路由 ID、服务商、完整模型 ID 或别名无效');routes.add(r.id);
    ensure(Object.keys(r).every(k=>['id','providerId','model','name','aliases','capabilities'].includes(k)),400,'bad_model_route','模型路由含未知字段');
    ensure(!r.capabilities || typeof r.capabilities==='object' && Object.keys(r.capabilities).every(k=>['tools','vision'].includes(k)) && ['tools','vision'].every(k=>(r.capabilities as any)[k]===undefined || typeof (r.capabilities as any)[k]==='boolean'),400,'bad_model_capabilities','模型能力需要布尔值');}
  ensure(routes.has(c.defaultRouteId),400,'bad_model_route','默认路由不在模型名单内');
  const result:Settings={...structuredClone(c),maxAttempts:c.maxAttempts??3,firstTokenTimeoutMs:c.firstTokenTimeoutMs??12000,attemptTimeoutMs:c.attemptTimeoutMs??45000,totalTimeoutMs:c.totalTimeoutMs??60000,cooldownSeconds:c.cooldownSeconds??60,fallbackRouteIds:c.fallbackRouteIds??c.routes.map(r=>r.id)};
  ensure(Array.isArray(result.fallbackRouteIds) && result.fallbackRouteIds.length<=500 && result.fallbackRouteIds.every(x=>routes.has(x)),400,'bad_model_route','备用顺序必须引用已配置模型');
  for(const [key,min,max] of [['maxAttempts',1,20],['firstTokenTimeoutMs',100,120000],['attemptTimeoutMs',100,600000],['totalTimeoutMs',100,600000],['cooldownSeconds',1,86400]] as const)ensure(Number.isInteger(result[key]) && result[key]>=min && result[key]<=max,400,'bad_model_budget',`${key} 配置超出范围`);
  ensure(result.firstTokenTimeoutMs<=result.attemptTimeoutMs && result.attemptTimeoutMs<=result.totalTimeoutMs,400,'bad_model_budget','首字、单模型与总时间预算顺序不正确');
  return result;
}
export function loadModelRouting(path:string):Settings {return validateModelRouting(JSON.parse(readFileSync(path,'utf8')));}

// Routing is local server policy. Natural-language commands never reach an LLM,
// and only allowlisted routes may receive the existing authorized conversation.
export class ModelRouter {
  store:FamilyStore;config:Settings|null=null;legacy:Generate;options:Options;clock:()=>number;
  private generators=new Map<string,Generate>();
  constructor(store:FamilyStore,config:ModelRoutingConfig|undefined,legacy:Generate,options:Options={}){
    this.store=store;this.legacy=legacy;this.options=options;this.clock=options.clock??Date.now;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_config(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_agents(agent_id TEXT PRIMARY KEY,route_id TEXT NOT NULL,revision INTEGER NOT NULL,forced INTEGER NOT NULL,last_success TEXT);
      CREATE TABLE IF NOT EXISTS model_health(route_id TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,failures INTEGER NOT NULL,code TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_menus(key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    const saved=store.db.prepare("SELECT data FROM model_config WHERE id='routing'").get() as any;
    if(config || saved)this.config=validateModelRouting(saved?JSON.parse(saved.data):config);
  }
  configure(raw:unknown):Settings {const c=validateModelRouting(raw);this.store.db.prepare("INSERT OR REPLACE INTO model_config VALUES('routing',?)").run(JSON.stringify(c));this.config=c;this.generators.clear();this.store.db.exec('DELETE FROM model_menus; DELETE FROM model_health; UPDATE model_agents SET revision=revision+1,forced=0;');return c;}
  private state(agentId:string):State {
    this.store.agent(agentId);ensure(this.config,409,'model_routing_unconfigured','请先在 /models 保存服务商和模型名单');
    let row=this.store.db.prepare('SELECT * FROM model_agents WHERE agent_id=?').get(agentId) as State|undefined;
    if(!row || !this.config.routes.some(r=>r.id===row!.route_id)){
      const configured=this.store.agent(agentId).model;
      const route=this.config.routes.find(r=>r.id===configured)??this.config.routes.find(r=>r.model===configured)??this.config.routes.find(r=>r.id===this.config!.defaultRouteId)!;
      this.store.db.prepare('INSERT INTO model_agents VALUES(?,?,?,0,NULL) ON CONFLICT(agent_id) DO UPDATE SET route_id=excluded.route_id,revision=model_agents.revision+1,forced=0,last_success=NULL').run(agentId,route.id,1);
      row=this.store.db.prepare('SELECT * FROM model_agents WHERE agent_id=?').get(agentId) as State;
    }
    return row;
  }
  current(agentId:string):ModelRoute|null {if(!this.config)return null;return this.config.routes.find(r=>r.id===this.state(agentId).route_id)!;}
  private label(r:ModelRoute):string {const p=this.config!.providers.find(p=>p.id===r.providerId)!;return `${p.name} · ${r.name??r.model}（${r.model}）`;}
  view(agentId:string):any {const route=this.current(agentId);return {configured:!!this.config,agentId,current:route?{...route,providerName:this.config!.providers.find(p=>p.id===route.providerId)!.name}:null,config:this.config};}
  select(agentId:string,routeId:string,roomId:string,sourceId?:string):ModelRoute {
    this.store.room(OWNER,roomId);const state=this.state(agentId);const route=this.config!.routes.find(r=>r.id===routeId);ensure(route,404,'unknown_model_route','这个模型不在已配置名单内');
    this.store.db.prepare('UPDATE model_agents SET route_id=?,revision=revision+1,forced=1 WHERE agent_id=?').run(route.id,agentId);
    this.store.event({kind:'controller',id:'controller'},roomId,'model.user_selected',{agentId,routeId:route.id,previousRouteId:state.route_id,sourceId,privateTo:agentId});return route;
  }
  private menuKey(room:string,client:string):string{return JSON.stringify([room,client]);}
  clearMenu(room:string,client:string):void{this.store.db.prepare('DELETE FROM model_menus WHERE key=?').run(this.menuKey(room,client));}
  private saveMenu(key:string,stage:Menu['stage'],ids:string[],agentId:string):void{this.store.db.prepare('INSERT OR REPLACE INTO model_menus VALUES(?,?)').run(key,JSON.stringify({stage,ids,agentId,expires:this.clock()+600000,config:digest(this.config)}));}
  private providersMenu(key:string,agentId:string):string{
    const current=this.current(agentId)!,c=this.config!;this.saveMenu(key,'providers',c.providers.map(p=>p.id),agentId);
    return `${this.store.agent(agentId).name} 当前选择：${this.label(current)}。\n可选服务商：\n${c.providers.map((p,i)=>`${i+1}. ${p.name}`).join('\n')}\n回复服务商名称或编号，再选具体模型；也可以直接说“模型换成模型名”。回复“取消”结束。`;
  }
  private routesMenu(key:string,agentId:string,ids:string[]):string{this.saveMenu(key,'routes',ids,agentId);return `${this.store.agent(agentId).name} 当前选择：${this.label(this.current(agentId)!)}。\n可选模型：\n${ids.map((id,i)=>`${i+1}. ${this.label(this.config!.routes.find(r=>r.id===id)!)}`).join('\n')}\n回复完整名称、已配置别名或编号；“返回”重新选商，“取消”结束。`;}
  command(text:string,currentAgent:string,roomId:string,clientId:string,sourceId:string):string|null{
    const key=this.menuKey(roomId,clientId),row=this.store.db.prepare('SELECT data FROM model_menus WHERE key=?').get(key) as any;
    let menu:Menu|undefined=row?JSON.parse(row.data):undefined;
    if(menu && (menu.expires<=this.clock() || menu.config!==digest(this.config))){this.store.db.prepare('DELETE FROM model_menus WHERE key=?').run(key);menu=undefined;}
    const visible=text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/g,' ').trim();
    if(!visible || /^(?:如果|假如|要是|比如|例如|解释|翻译|写一|不要|别|不想|不准|别再|他(?:说|让我)|她(?:说|让我))/.test(visible))return null;
    let input=visible.replace(/[。！!？?]+$/u,'').trim(),agentId=currentAgent;
    for(const a of this.store.config.agents)for(const name of [a.id,a.name,...a.aliases]){
      if(normalize(input).startsWith(normalize('给'+name))){agentId=a.id;input=input.slice(('给'+name).length).trim();}
    }
    const simple=input.replace(/^(?:现在|那就|请|帮我|给我|我要|我想)\s*/,'').trim();
    const show=/^(?:\/模型|\/models|换(?:个|一下)?模型|切换模型|列出(?:可用的?)?模型|看看模型(?:列表)?|模型列表|有哪些模型|(?:现在|当前)(?:用的?|使用的?)?(?:是什么)?模型|你现在用什么模型)$/i.test(simple);
    const direct=/^(?:\/模型\s+|\/models\s+|(?:把)?模型(?:给我)?(?:切换|切|换|改|用)(?:到|成|回|为)?\s*|(?:切换到|换成|换到|换回)\s*)(.+?)(?:吧)?$/iu.exec(simple);
    const next=/^(?:模型)?换(?:到|成)?下一个(?:模型)?$/.test(simple);
    if(!show && !direct && !next && !menu)return null;
    if(!this.config)return show||next||direct && /模型|^\/models/i.test(simple) ? '模型路由还没有配置。打开 /models 填服务商、凭据引用和可用模型，保存后可直接在聊天里切换。' : null;
    if(show)return this.providersMenu(key,agentId);
    if(next){const order=[...new Set([this.current(agentId)!.id,...this.config.fallbackRouteIds])];const route=this.select(agentId,order[1]??order[0],roomId,sourceId);this.store.db.prepare('DELETE FROM model_menus WHERE key=?').run(key);return `已将 ${this.store.agent(agentId).name} 的模型设为 ${this.label(route)}。`;}
    let target=direct?.[1]?.trim();
    if(menu && !direct){agentId=menu.agentId;if(/^(?:取消|算了|cancel)$/i.test(simple)){this.store.db.prepare('DELETE FROM model_menus WHERE key=?').run(key);return '已结束模型选择。';}if(/^(?:返回|back)$/i.test(simple))return this.providersMenu(key,agentId);
      const index=/^[1-9]\d*$/.test(simple)?Number(simple)-1:-1;
      if(menu.stage==='providers'){
        const p=index>=0?this.config.providers.find(p=>p.id===menu!.ids[index]):this.config.providers.find(p=>exact(simple,[p.id,p.name,...p.aliases??[]]));
        if(!p)return /^\d+$/.test(simple)?'编号不在当前菜单里，请回复列出的服务商编号。':null;const ids=this.config.routes.filter(r=>r.providerId===p.id).map(r=>r.id);return ids.length?this.routesMenu(key,agentId,ids):'这个服务商还没有配置可用模型。';
      }
      target=index>=0?menu.ids[index]:simple;
    }
    const matches=(wanted:string)=>this.config!.routes.filter(r=>(!menu || direct || menu.stage!=='routes' || menu.ids.includes(r.id)) && exact(wanted,[r.id,r.model,r.name,...r.aliases??[],`${r.providerId}/${r.model}`,`${this.config!.providers.find(p=>p.id===r.providerId)!.name} 的 ${r.name??r.model}`]));
    let candidates=matches(target??'');if(!candidates.length && direct)candidates=matches((target??'').replace(/\s*模型$/,''));
    if(candidates.length>1)return this.routesMenu(key,agentId,candidates.map(r=>r.id));
    if(!candidates.length)return direct && /模型|^\/models/i.test(simple)?`没有匹配到已配置模型“${target}”。\n${this.providersMenu(key,agentId)}`:menu && /^\d+$/.test(simple)?'编号不在当前菜单里，请回复列出的模型编号。':null;
    const route=this.select(agentId,candidates[0].id,roomId,sourceId);this.store.db.prepare('DELETE FROM model_menus WHERE key=?').run(key);return `已将 ${this.store.agent(agentId).name} 的模型设为 ${this.label(route)}。`;
  }
  private compatible(route:ModelRoute,messages:Message[],tools:Tool[]):boolean{return !(route.capabilities?.tools===false && (tools.length || messages.some(m=>m.role==='tool'||m.tool_calls?.length))) && !(route.capabilities?.vision===false && messages.some(m=>Array.isArray(m.content) && m.content.some(p=>p?.type==='image_url')));}
  private generator(route:ModelRoute):Generate{
    const provider=this.config!.providers.find(p=>p.id===route.providerId)!,env=this.options.env??process.env;
    const key=provider.keyRef?this.options.secrets?.value(provider.keyRef):provider.apiKeyEnv?env[provider.apiKeyEnv]:'';
    ensure((!provider.keyRef && !provider.apiKeyEnv) || key,409,'missing_model_credential','模型服务商的凭据尚未填写');
    const identity=digest({route,base:provider.baseURL,credential:digest(key??'')});
    if(!this.generators.has(identity)){
      if(this.generators.size>100)this.generators.clear();const generate=(this.options.factory??openAIProvider)(provider.baseURL,key??'',route.model);
      this.generators.set(identity,async(messages,tools,model,delta,signal,options)=>{
        const adapted=messages.map(({reasoning_scope,...message})=>{
          if(reasoning_scope!==identity){const {reasoning_content:_content,reasoning_details:_details,...plain}=message;return plain;}
          return message;
        });
        return {...await generate(adapted,tools,model,delta,signal,options),reasoningScope:identity};
      });
    }
    return this.generators.get(identity)!;
  }
  private recoverable(error:unknown):boolean{
    if(!(error instanceof AppError))return false;
    if(error instanceof UpstreamError && error.upstreamStatus!==undefined)return [400,401,403,404,408,409,413,422,425,429].includes(error.upstreamStatus)||error.upstreamStatus>=500;
    return new Set(['provider_not_configured','missing_model_credential','missing_secret','upstream_unavailable','invalid_upstream','empty_upstream','invalid_sse','upstream_stream_error','upstream_too_large','interrupted_stream','truncated_stream','bad_upstream_tools','unknown_tool','empty_completion']).has(error.code);
  }
  private check(result:Completion,tools:Tool[]):void{
    ensure(result && typeof result.content==='string' && Array.isArray(result.toolCalls) && result.toolCalls.length<=32 && new Set(result.toolCalls.map(c=>c?.id)).size===result.toolCalls.length && result.toolCalls.every(c=>c && c.type==='function' && typeof c.id==='string' && c.id && typeof c.function?.name==='string' && typeof c.function.arguments==='string'),502,'bad_upstream_tools','模型返回了无效工具调用');
    ensure(result.toolCalls.every(c=>tools.some(t=>t.function.name===c.function.name)),502,'unknown_tool','模型调用了未注册工具');
    ensure(result.content.trim() || result.toolCalls.length,502,'empty_completion','模型返回了空回复');
  }
  private failed(route:ModelRoute,error:unknown,roomId:string,agentId:string):void{
    const retry=error instanceof UpstreamError?error.retryAfterMs??0:0;
    const until=this.clock()+Math.min(86400000,Math.max(this.config!.cooldownSeconds*1000,retry));
    const code=error instanceof AppError?error.code:'model_error';
    this.store.db.prepare('INSERT INTO model_health VALUES(?,?,1,?) ON CONFLICT(route_id) DO UPDATE SET until_ms=excluded.until_ms,failures=failures+1,code=excluded.code').run(route.id,until,code);
    this.store.event({kind:'controller',id:'controller'},roomId,'model.route_failed',{routeId:route.id,agentId,code,privateTo:agentId});
  }
  private commit(snapshot:State,route:ModelRoute,roomId:string):void{
    const result=this.store.db.prepare('UPDATE model_agents SET route_id=?,revision=revision+1,forced=0,last_success=? WHERE agent_id=? AND revision=? AND (route_id!=? OR forced=1 OR last_success IS NOT ?)').run(route.id,route.id,snapshot.agent_id,snapshot.revision,route.id,route.id);
    this.store.db.prepare('DELETE FROM model_health WHERE route_id=?').run(route.id);
    if(result.changes && snapshot.route_id!==route.id)this.store.event({kind:'controller',id:'controller'},roomId,'model.auto_switched',{agentId:snapshot.agent_id,routeId:route.id,previousRouteId:snapshot.route_id,privateTo:snapshot.agent_id});
  }
  generate:Generate=async(messages,tools,legacyModel,delta,signal,options={})=>{
    if(!this.config || !options.routing)return this.legacy(messages,tools,legacyModel,delta,signal,options);
    const {agentId,roomId}=options.routing;this.store.room({kind:'agent',id:agentId},roomId);
    const snapshot=this.state(agentId),c=this.config,started=performance.now();
    const routes=[...new Set([snapshot.route_id,...c.fallbackRouteIds])].map(id=>c.routes.find(r=>r.id===id)!).filter(r=>this.compatible(r,messages,tools));
    let last:unknown,attempts=0;
    for(const route of routes){
      ensure(!signal?.aborted,499,'client_disconnected','客户端已断开，本次上游请求已取消');
      const health=this.store.db.prepare('SELECT until_ms FROM model_health WHERE route_id=?').get(route.id) as any;
      if(health?.until_ms>this.clock() && !(snapshot.forced && route.id===snapshot.route_id))continue;
      const remaining=Math.floor(c.totalTimeoutMs-(performance.now()-started));if(attempts>=c.maxAttempts || remaining<=0)break;
      ensure(this.config===c,409,'model_config_changed','模型配置已更新，请重新发起本轮请求');
      attempts++;let visible=false;
      if(snapshot.forced && route.id===snapshot.route_id)this.store.db.prepare('UPDATE model_agents SET forced=0 WHERE agent_id=? AND revision=?').run(agentId,snapshot.revision);
      try{
        const result=await this.generator(route)(messages,tools,route.model,delta?s=>{if(s.length)visible=true;delta(s);}:undefined,signal,{...options,timeoutMs:Math.min(c.attemptTimeoutMs,remaining),firstTokenTimeoutMs:Math.min(c.firstTokenTimeoutMs,remaining)});
        this.check(result,tools);this.commit(snapshot,route,roomId);return {...result,routing:{routeId:route.id,providerId:route.providerId,model:route.model,attempts}};
      }catch(error){
        if(signal?.aborted)throw new AppError(499,'client_disconnected','客户端已断开，本次上游请求已取消');
        if(!this.recoverable(error))throw error;last=error;if(this.config===c)this.failed(route,error,roomId,agentId);
        if(visible){
          const next=routes.find(r=>r.id!==route.id && ((this.store.db.prepare('SELECT until_ms FROM model_health WHERE route_id=?').get(r.id) as any)?.until_ms??0)<=this.clock());
          if(next)this.store.db.prepare('UPDATE model_agents SET route_id=?,revision=revision+1,forced=0 WHERE agent_id=? AND revision=?').run(next.id,agentId,snapshot.revision);
          throw error;
        }
      }
    }
    if(last)throw last;throw new AppError(503,'no_available_model','当前没有满足能力要求且可用的模型，请稍后重试或在聊天中切换模型。');
  };
}
