import type { Message, Tool, ToolCall } from './types.ts';
import { AppError, ensure } from './types.ts';
import { digest } from './cache.ts';

export type Completion = { content: string; toolCalls: ToolCall[]; usage: Record<string, number>; finishReason: string; reasoningContent?:string;reasoningDetails?:unknown[];reasoningScope?:string;routing?: {routeId:string;providerId:string;model:string;attempts:number} };
export type GenerationOptions = { temperature?: number; max_tokens?: number; cache?: { mode: 'automatic' | 'openai'; key: string }; routing?: {agentId:string;roomId:string}; timeoutMs?:number;firstTokenTimeoutMs?:number };
export type Generate = (messages: Message[], tools: Tool[], model: string, delta?: (text: string) => void, signal?: AbortSignal, options?: GenerationOptions) => Promise<Completion>;
export class UpstreamError extends AppError {
  upstreamStatus?:number;retryAfterMs?:number;
  constructor(code:string,message:string,upstreamStatus?:number,retryAfterMs?:number){super(502,code,message);this.upstreamStatus=upstreamStatus;this.retryAfterMs=retryAfterMs;}
}

export function normalizeUsage(raw: any): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = value;
  const read = raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens;
  const write = raw.prompt_tokens_details?.cache_write_tokens ?? raw.input_tokens_details?.cache_write_tokens ?? raw.cache_creation_input_tokens ?? raw.cache_write_tokens;
  if (typeof read === 'number' && Number.isFinite(read) && read >= 0) result.cached_tokens = read;
  if (typeof write === 'number' && Number.isFinite(write) && write >= 0) result.cache_write_tokens = write;
  return result;
}

export function openAIProvider(baseURL: string, apiKey: string, defaultModel: string): Generate {
  return async (messages, tools, model, delta, signal, options = {}) => {
    ensure(baseURL && (model || defaultModel), 503, 'provider_not_configured', '请配置 MODEL_BASE_URL、MODEL_NAME 和需要的 MODEL_API_KEY。');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 45_000);
    const first = new AbortController();
    // Routed non-stream clients still use upstream SSE internally so a dead
    // model cannot consume the entire request timeout before first progress.
    const streaming=!!delta || options.firstTokenTimeoutMs!==undefined;
    const firstTimer = streaming && options.firstTokenTimeoutMs ? setTimeout(()=>first.abort(),options.firstTokenTimeoutMs) : undefined;
    firstTimer?.unref();
    const requestSignal=AbortSignal.any([timeout,first.signal,...(signal?[signal]:[])]);
    try {
    const actualModel = model || defaultModel;
    // Optional provider fields are opt-in. Generic OpenAI-compatible endpoints continue to
    // receive only their standard parameters; stable prefixes also work with automatic caches.
    const sampling = { ...(options.temperature !== undefined ? { temperature: options.temperature } : {}), ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}) };
    const cacheFields = options.cache?.mode === 'openai' ? {
      prompt_cache_key: `fgw-${digest({ route: baseURL, credential: digest(apiKey), model: actualModel, scope: options.cache.key }).slice(0, 48)}`,
    } : {};
    let response: Response;
    try {
      response = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: actualModel, messages:messages.map(({reasoning_scope:_internal,...message})=>message), stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}), ...(tools.length ? { tools } : {}), ...sampling, ...cacheFields }),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw new AppError(499, 'client_disconnected', '客户端已断开，本次上游请求已取消');
      throw new AppError(504, 'upstream_unavailable', `模型连接失败或超时：${error instanceof Error ? error.name : 'network_error'}`);
    }
    if (!response.ok) {
      const retry=response.headers.get('retry-after'), parsed=retry ? Number(retry) : NaN;
      const retryAfterMs=retry ? Number.isFinite(parsed) ? Math.max(0,parsed*1000) : Math.max(0,Date.parse(retry)-Date.now()) : undefined;
      await response.body?.cancel();throw new UpstreamError('upstream_rejected',`模型服务返回 HTTP ${response.status}，请检查模型配置和用量。`,response.status,Number.isFinite(retryAfterMs)?retryAfterMs:undefined);
    }
    if (!streaming || response.headers.get('content-type')?.includes('application/json')) {
      let data:any;try{data=await response.json();}catch{if(signal?.aborted)throw new AppError(499,'client_disconnected','客户端已断开');throw new UpstreamError('invalid_upstream','模型服务没有返回有效 JSON');}
      const choice = data.choices?.[0];
      ensure(choice?.message && (typeof choice.message.content === 'string' || Array.isArray(choice.message.tool_calls)), 502, 'invalid_upstream', '模型服务没有返回有效的 message');
      if(typeof choice.message.content==='string' && choice.message.content.length)delta?.(choice.message.content);
      return { content: choice.message.content ?? '', toolCalls: choice.message.tool_calls ?? [], usage: normalizeUsage(data.usage), finishReason: choice.finish_reason ?? 'stop',...(typeof choice.message.reasoning_content==='string'?{reasoningContent:choice.message.reasoning_content}:{}),...(Array.isArray(choice.message.reasoning_details)?{reasoningDetails:choice.message.reasoning_details}:{}) };
    }
    ensure(response.body, 502, 'empty_upstream', '上游没有返回流');
    let content = '', buffer = '', finished = false,done=false,reasoningContent='';const reasoningDetails:unknown[]=[];
    let usage: Record<string, number> = {}, finishReason = 'stop';
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    const frame = (input: string) => {
      const data = input.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { finished = true;done=true; return; }
      let part: any;
      try { part = JSON.parse(data); } catch { throw new AppError(502, 'invalid_sse', '上游 SSE 帧不是有效 JSON'); }
      if (part.error) throw new AppError(502, 'upstream_stream_error', '模型流返回错误');
      if (part.usage) usage = normalizeUsage(part.usage);
      const choice = part.choices?.[0];
      if(typeof choice?.delta?.reasoning_content==='string')reasoningContent+=choice.delta.reasoning_content;
      if(Array.isArray(choice?.delta?.reasoning_details))reasoningDetails.push(...choice.delta.reasoning_details);
      if (choice?.finish_reason) { finishReason = choice.finish_reason; finished = true; }
      if (typeof choice?.delta?.content === 'string') { if(choice.delta.content.length)clearTimeout(firstTimer);content += choice.delta.content; delta?.(choice.delta.content); }
      if(choice?.delta?.tool_calls?.length)clearTimeout(firstTimer);
      for (const call of choice?.delta?.tool_calls ?? []) {
        const previous = calls.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
        previous.id += call.id ?? ''; previous.function.name += call.function?.name ?? ''; previous.function.arguments += call.function?.arguments ?? '';
        calls.set(call.index, previous);
      }
    };
    try {
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          frame(buffer.slice(0, boundary.index)); buffer = buffer.slice(boundary.index + boundary[0].length);
          if(done)break;
        }
        ensure(buffer.length < 2_000_000 && content.length+reasoningContent.length+JSON.stringify(reasoningDetails).length < 2_000_000, 502, 'upstream_too_large', '模型响应超过本轮大小限制');
        if(done)break;
      }
      if(!done){buffer += decoder.decode(); if (buffer.trim()) frame(buffer);}
    } catch (error) {
      if(signal?.aborted)throw new AppError(499,'client_disconnected','客户端已断开，本次上游请求已取消');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'interrupted_stream', '模型流中断，本轮未标记为成功');
    }
    ensure(finished, 502, 'truncated_stream', '模型流提前结束，缺少完成帧');
    return { content, toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c), usage, finishReason,...(reasoningContent?{reasoningContent}:{}),...(reasoningDetails.length?{reasoningDetails}:{}) };
    } finally {clearTimeout(firstTimer);}
  };
}
