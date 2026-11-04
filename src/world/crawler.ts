import {createHash} from 'node:crypto';
import type {FamilyStore} from '../store.ts';
import {ensure,AppError} from '../types.ts';
import {safeRequest} from '../mcp/http.ts';

export type Page={url:string;finalUrl:string;title:string;text:string;html:string;hash:string;fetchedAt:string;changed:boolean;notModified:boolean;truncated:boolean};
type Cache={page:Page;etag?:string;lastModified?:string};
export function cleanURL(value:unknown):string{
  ensure(typeof value==='string' && value.length<=2000,400,'bad_crawl_url','网页地址需要字符串且不超过 2000 字符');let u:URL;
  try{u=new URL(value);}catch{throw new AppError(400,'bad_crawl_url','网页地址无效');}
  ensure(['https:','http:'].includes(u.protocol) && !u.username && !u.password,400,'bad_crawl_url','只读取无内嵌凭据的 HTTP(S) 网页');u.hash='';return u.href;
}
const entities=(s:string)=>s.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi,(m,n,name)=>{if(n){const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0 && v<=0x10ffff?String.fromCodePoint(v):m;}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as any)[name.toLowerCase()];});
export function extractPage(html:string,mime:string):{title:string;text:string;truncated:boolean;hash:string}{
  if(/text\/plain|application\/(?:json|xml)|text\/xml/.test(mime)){const text=html.replace(/\r\n/g,'\n');return {title:'',text:text.slice(0,40000),truncated:text.length>40000,hash:createHash('sha256').update(text).digest('hex')};}
  const title=entities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]?.replace(/<[^>]*>/g,'')??'').replace(/\s+/g,' ').trim().slice(0,300);
  let main=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  main=main.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i)?.[1]??main.replace(/<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const text=entities(main.replace(/<\/(?:p|div|li|h[1-6]|section|article|tr)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[\t ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {title,text:text.slice(0,40000),truncated:text.length>40000,hash:createHash('sha256').update(title+'\n'+text).digest('hex')};
}
function robotsAllowed(body:string,path:string):boolean{
  const groups:{agents:string[];rules:{allow:boolean;path:string}[]}[]=[];let group:{agents:string[];rules:{allow:boolean;path:string}[]}|undefined;
  for(const line of body.split(/\r?\n/)){
    const match=/^\s*([^:#]+)\s*:\s*([^#]*)/.exec(line);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].trim();
    if(key==='user-agent'){if(!group || group.rules.length){group={agents:[],rules:[]};groups.push(group);}group.agents.push(value.toLowerCase());}
    else if(group && (key==='allow'||key==='disallow') && value)group.rules.push({allow:key==='allow',path:value});
  }
  const specific=groups.filter(g=>g.agents.some(a=>a!=='*' && 'labrys'.includes(a))),selected=specific.length?specific:groups.filter(g=>g.agents.includes('*'));
  let best={length:-1,allow:true};
  for(const rule of selected.flatMap(g=>g.rules)){
    const regex='^'+rule.path.split('*').map(s=>s.replace(/[.+?^{}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\?\$$/,'$');
    if(new RegExp(regex).test(path) && (rule.path.length>best.length || rule.path.length===best.length && rule.allow))best={length:rule.path.length,allow:rule.allow};
  }
  return best.allow;
}
export class PageCrawler{
  store:FamilyStore;allowPrivateHosts:string[];private robots=new Map<string,{expires:number;body:string}>();
  constructor(store:FamilyStore,allowPrivateHosts:string[]=[]){this.store=store;this.allowPrivateHosts=allowPrivateHosts;store.db.exec('CREATE TABLE IF NOT EXISTS crawl_cache(key TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at INTEGER NOT NULL)');}
  private async request(url:string,headers:Record<string,string>,signal:AbortSignal,maxBytes=2000000){return safeRequest(url,'GET',{'User-Agent':'Labrys/0.1','Accept':'text/html,application/xhtml+xml,text/plain,application/json;q=0.8','Accept-Encoding':'identity',...headers},undefined,{allowPrivateHosts:this.allowPrivateHosts,timeoutMs:12000,maxBytes},signal);}
  private async robotsCheck(url:string,signal:AbortSignal):Promise<void>{
    const u=new URL(url);let entry=this.robots.get(u.origin);
    if(!entry || entry.expires<=Date.now()){
      const response=await this.request(u.origin+'/robots.txt',{},signal,256000);
      ensure(response.status<500 && response.status!==429,502,'robots_unavailable','网站 robots 暂不可用，稍后再抓取');
      entry={expires:Date.now()+3600000,body:response.status>=200 && response.status<300?response.text:response.status===401||response.status===403?'User-agent: *\nDisallow: /':''};
      if(this.robots.size>100)this.robots.clear();this.robots.set(u.origin,entry);
    }
    ensure(robotsAllowed(entry.body,u.pathname+u.search),403,'robots_disallowed','网站 robots 不允许读取这个页面');
  }
  async read(scope:unknown,input:string,signal:AbortSignal):Promise<Page>{
    const url=cleanURL(input),key=createHash('sha256').update(JSON.stringify([scope,url])).digest('hex');const row=this.store.db.prepare('SELECT data FROM crawl_cache WHERE key=?').get(key) as any;const cached:Cache|undefined=row?JSON.parse(row.data):undefined;
    let current=url;let response:Awaited<ReturnType<typeof safeRequest>>|undefined;
    for(let redirects=0;redirects<=3;redirects++){
      await this.robotsCheck(current,signal);
      const headers:Record<string,string>={};
      if(cached && cached.page.finalUrl===current){if(cached.etag)headers['If-None-Match']=cached.etag;if(cached.lastModified)headers['If-Modified-Since']=cached.lastModified;}
      response=await this.request(current,headers,signal);
      if([301,302,303,307,308].includes(response.status)){ensure(redirects<3 && response.headers.location,502,'crawl_redirect_limit','网页重定向过多或缺少地址');current=cleanURL(new URL(response.headers.location,current).href);continue;}break;
    }
    ensure(response,502,'crawl_failed','网页没有响应');
    if(response.status===304){ensure(cached,502,'crawl_missing_cache','网页返回 304，但没有对应缓存');const page={...cached.page,fetchedAt:new Date().toISOString(),changed:false,notModified:true};this.store.db.prepare('UPDATE crawl_cache SET updated_at=? WHERE key=?').run(Date.now(),key);return page;}
    ensure(response.status>=200 && response.status<300,502,'crawl_http',`网页返回 HTTP ${response.status}`);
    const mime=String(response.headers['content-type']??'').toLowerCase();ensure(/text\/|application\/(?:xhtml\+xml|json|xml)/.test(mime),415,'crawl_unsupported','只读取 HTML、文本、JSON 和 XML；不处理登录页、PDF、视频或脚本渲染');
    const parsed=extractPage(response.text,mime);ensure(parsed.text.trim().length>0,502,'crawl_empty','页面没有可读取的正文，可能需要浏览器或登录');
    const hash=parsed.hash;const page:Page={url,finalUrl:current,...parsed,html:response.text,hash,fetchedAt:new Date().toISOString(),changed:cached?.page.hash!==hash,notModified:false};
    const header=(v:unknown)=>typeof v==='string' && v.length<=2000 && !/[\r\n]/.test(v)?v:undefined;
    this.store.db.prepare('INSERT OR REPLACE INTO crawl_cache VALUES(?,?,?)').run(key,JSON.stringify({page,etag:header(response.headers.etag),lastModified:header(response.headers['last-modified'])}),Date.now());
    this.store.db.prepare('DELETE FROM crawl_cache WHERE key IN (SELECT key FROM crawl_cache ORDER BY updated_at DESC LIMIT -1 OFFSET 100)').run();return page;
  }
}
