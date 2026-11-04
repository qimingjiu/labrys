export type Actor = { kind: 'user' | 'agent' | 'controller'; id: string };
export const OWNER: Actor = { kind: 'user', id: 'owner' };
export const CONTROLLER: Actor = { kind: 'controller', id: 'controller' };
export type Agent = { id: string; name: string; aliases: string[]; persona: string; model: string };
export type Config = { defaultAgentId: string; agents: Agent[]; maxContextCharacters: number; cache?: Partial<import('./cache.ts').CacheConfig>; modelRouting?:import('./models.ts').ModelRoutingConfig };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Message = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: unknown; name?: string; tool_calls?: ToolCall[]; tool_call_id?: string;
  reasoning_content?:string;reasoning_details?:unknown[];
  reasoning_scope?:string;
};
export type Tool = { type: 'function'; function: { name: string; description: string; parameters: unknown } };
export type Source = { id: string; kind: string; roomId: string; actorId: string; data: unknown; createdAt: string };
export type Memory = {
  id: string; roomId: string; authorId: string; ownerId: string | null;
  visibility: 'private' | 'shared'; text: string; kind: 'fact' | 'observation';
  status: 'candidate' | 'confirmed' | 'contested'; sources: string[];
  recordedAt: string | null;
  validity: { validFrom: string | null; validUntil: string | null; context: string | null };
  operations: { id: string; actorId: string; type: string; text: string; sources: string[]; recordedAt: string | null }[];
  relations: MemoryRelation[];
};
export type MemoryRelation = { id: string; fromId: string; toId: string; type: 'supersedes' | 'corrects' | 'qualifies' | 'contradicts'; actorId: string; status: 'candidate' | 'confirmed'; sources: string[]; recordedAt: string };
export class AppError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function ensure(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => p?.type === 'text' ? String(p.text ?? '') : '').join('\n');
  return '';
}
