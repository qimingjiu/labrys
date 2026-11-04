import {ensure} from '../types.ts';
export type Schedule={type:'once';at:string}|{type:'interval';everyMs:number;startAt?:string}|{type:'calendar';time:string;timeZone:string;weekdays?:number[]};
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string):Intl.DateTimeFormat{
  try{let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>50)formatters.clear();formatters.set(zone,f);}return f;}catch{ensure(false,400,'bad_time_zone','需要有效的 IANA 时区，例如 Asia/Shanghai');}
}
export function instant(value:unknown,label='时间'):number{
  ensure(typeof value==='string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)),400,'bad_time',`${label}需要带时区的 ISO 时间`);return Date.parse(value);
}
function parts(time:number,zone:string):number[]{const v=Object.fromEntries(formatter(zone).formatToParts(time).map(p=>[p.type,p.value]));return [Number(v.year),Number(v.month),Number(v.day),Number(v.hour),Number(v.minute)];}
function localInstant(date:number[],zone:string):number|null{
  const naive=Date.UTC(date[0],date[1]-1,date[2],date[3],date[4]),offsets=new Set<number>();
  for(const hours of [-36,-12,0,12,36]){const sample=naive+hours*3600000,p=parts(sample,zone);offsets.add(Date.UTC(p[0],p[1]-1,p[2],p[3],p[4])-sample);}
  const matches=[...offsets].map(offset=>naive-offset).filter(time=>parts(time,zone).every((n,i)=>n===date[i])).sort((a,b)=>a-b);
  // Spring gaps are skipped; a repeated fall-back wall time fires only at its
  // first occurrence. This avoids firing the same daily alarm twice.
  return matches[0]??null;
}
export function validateSchedule(raw:any,now:number,minInterval=60000):Schedule{
  ensure(raw && typeof raw==='object' && !Array.isArray(raw),400,'bad_schedule','需要 schedule 对象');
  if(raw.type==='once'){const at=instant(raw.at);ensure(at>now,400,'past_schedule','一次提醒需要未来时间');return {type:'once',at:new Date(at).toISOString()};}
  if(raw.type==='interval'){
    ensure(Number.isSafeInteger(raw.everyMs) && raw.everyMs>=minInterval && raw.everyMs<=366*86400000,400,'bad_interval',`间隔至少 ${minInterval/1000} 秒，最多 366 天`);
    const start=raw.startAt?instant(raw.startAt):now+raw.everyMs;return {type:'interval',everyMs:raw.everyMs,startAt:new Date(start).toISOString()};
  }
  ensure(raw.type==='calendar' && typeof raw.time==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time),400,'bad_schedule','日历计划需要 HH:mm 时间');
  const zone=raw.timeZone??'Asia/Shanghai';ensure(typeof zone==='string',400,'bad_time_zone','时区需要字符串');formatter(zone);
  ensure(raw.weekdays===undefined || Array.isArray(raw.weekdays) && raw.weekdays.length>0 && raw.weekdays.length<=7 && raw.weekdays.every((v:unknown)=>Number.isInteger(v) && Number(v)>=1 && Number(v)<=7),400,'bad_weekdays','weekdays 使用周一=1至周日=7');
  return {type:'calendar',time:raw.time,timeZone:zone,...(raw.weekdays?{weekdays:[...new Set<number>(raw.weekdays)].sort()}: {})};
}
export function nextOccurrence(schedule:Schedule,after:number):number|null{
  if(schedule.type==='once'){const at=instant(schedule.at);return at>after?at:null;}
  if(schedule.type==='interval'){const start=instant(schedule.startAt!);return start>after?start:start+(Math.floor((after-start)/schedule.everyMs)+1)*schedule.everyMs;}
  const p=parts(after,schedule.timeZone),[hour,minute]=schedule.time.split(':').map(Number);
  for(let day=0;day<=8;day++){
    const d=new Date(Date.UTC(p[0],p[1]-1,p[2]+day));if(schedule.weekdays && !schedule.weekdays.includes(d.getUTCDay()||7))continue;
    const at=localInstant([d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),hour,minute],schedule.timeZone);if(at!==null && at>after)return at;
  }
  return null;
}
export function localDate(time:number,zone='Asia/Shanghai'):string{const p=parts(time,zone);return `${p[0]}-${String(p[1]).padStart(2,'0')}-${String(p[2]).padStart(2,'0')}`;}
export function dayBounds(date:string,zone='Asia/Shanghai'):{start:number;end:number}{
  ensure(/^\d{4}-\d\d-\d\d$/.test(date),400,'bad_diary_date','日记日期需要 YYYY-MM-DD');const [y,m,d]=date.split('-').map(Number),calendar=new Date(Date.UTC(y,m-1,d));ensure(calendar.toISOString().slice(0,10)===date,400,'bad_diary_date','日记日期不存在');
  const boundary=(offset:number)=>{const day=new Date(Date.UTC(y,m-1,d+offset));for(let minute=0;minute<180;minute++){const at=localInstant([day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),Math.floor(minute/60),minute%60],zone);if(at!==null)return at;}ensure(false,400,'bad_diary_date','该时区这一天没有可定位的午夜边界');};
  return {start:boundary(0),end:boundary(1)};
}
