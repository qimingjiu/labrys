import { readFileSync } from 'node:fs';
import { ensure } from './types.ts';
import type { Config } from './types.ts';
import { normalize } from './commands.ts';
import { CACHE_DEFAULTS } from './cache.ts';
import {validateModelRouting} from './models.ts';

export function loadConfig(path: string): Config {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  ensure(Array.isArray(config.agents) && config.agents.length > 0 && config.agents.length <= 50, 400, 'bad_config', '需要 1–50 个家庭成员');
  const ids = new Set<string>(), aliases = new Map<string, string>();
  for (const agent of config.agents) {
    ensure(/^[a-z][a-z0-9_-]{0,31}$/.test(agent.id) && !ids.has(agent.id) && !['controller', 'owner'].includes(agent.id), 400, 'bad_config', '成员 ID 重复或无效'); ids.add(agent.id);
    ensure(typeof agent.name === 'string' && agent.name.length > 0 && typeof agent.persona === 'string' && agent.persona.length > 0 && typeof agent.model === 'string', 400, 'bad_config', '成员需要 name/persona/model');
    ensure(Array.isArray(agent.aliases) && agent.aliases.every(a => typeof a === 'string' && a.length > 0), 400, 'bad_config', 'aliases 需要非空字符串数组');
    for (const alias of [agent.id, agent.name, ...agent.aliases]) {
      const n = normalize(alias);
      ensure(!aliases.has(n) || aliases.get(n) === agent.id, 400, 'alias_conflict', '成员名字或别名冲突'); aliases.set(n, agent.id);
    }
  }
  ensure(ids.has(config.defaultAgentId), 400, 'bad_config', '默认成员不存在');
  if(config.modelRouting)config.modelRouting=validateModelRouting(config.modelRouting);
  config.maxContextCharacters ??= 60000;
  ensure(Number.isInteger(config.maxContextCharacters) && config.maxContextCharacters >= 4000 && config.maxContextCharacters <= 1_000_000, 400, 'bad_config', '上下文字符预算需要在 4000–1000000 范围内');
  config.cache = { ...CACHE_DEFAULTS, ...config.cache };
  ensure(typeof config.cache.enabled === 'boolean' && ['automatic', 'openai'].includes(config.cache.providerMode!), 400, 'bad_cache_config', '缓存开关或 providerMode 无效');
  for (const [key, min, max] of [['ttlSeconds', 1, 2592000], ['maxEntries', 4, 10000], ['maxBytes', 4096, 268435456]] as const) {
    const value = config.cache[key]!;
    ensure(Number.isInteger(value) && value >= min && value <= max, 400, 'bad_cache_config', `缓存 ${key} 配置无效`);
  }
  return config;
}
