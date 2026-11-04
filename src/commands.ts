import type { Agent } from './types.ts';
import { AppError } from './types.ts';

export function normalize(s: string): string { return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(); }
function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Only explicit user commands are routed. Names in quotations, conditionals and tool output are data.
// Complex requests remain normal conversation; no extra classification-model call is made.
export function parseSwitch(text: string, agents: Agent[]): { agentId: string; reason: string } | null {
  const visible = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/g, ' ');
  if (/^(?:如果|假如|要是|比如|例如|举例|测试这句|解释|翻译|写(?:一段|个|一句))/.test(visible.trim())) return null;
  const input = normalize(visible);
  const found = new Set<string>();
  for (const agent of agents) {
    const names = [agent.name, agent.id, ...agent.aliases].map(normalize).map(escape).sort((a, b) => b.length - a.length).join('|');
    const prefix = '(?:^|[，,。！!？?；;\\n])\\s*(?:现在|那就|就|请|我要|我想)?\\s*';
    const forms = [
      `${prefix}(?:让|叫|请)\\s*(?:${names})\\s*(?:来(?:接话|回答|聊|说话)?|回来|上线|出来|登场)(?:吧|一下)?(?=$|[\\s，,。！!？?；;])`,
      `${prefix}(?:切换(?:到|成)?|换成|换到|换回|换)\\s*(?:${names})(?:来|接话|吧)?(?=$|[\\s，,。！!？?；;])`,
      `${prefix}(?:${names})\\s*(?:来接话|来回答|出来|上线|来吧)(?=$|[\\s，,。！!？?；;])`,
    ];
    if (forms.some(pattern => new RegExp(pattern, 'u').test(input))) found.add(agent.id);
  }
  if (found.size > 1) throw new AppError(409, 'ambiguous_switch', '一次指定了多个接话成员，请明确这次让谁来。');
  return found.size === 1 ? { agentId: [...found][0], reason: text } : null;
}
