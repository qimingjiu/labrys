import type { Tool } from '../types.ts';
import {PLANNER_TOOLS} from './planner-tools.ts';
import {COLLECTION_TOOLS} from './collection-tools.ts';
const s = { type: 'string' }; const list = { type: 'array', items: s };
const p = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, parameters: unknown): Tool => ({ type: 'function', function: { name, description, parameters } });
export const WORLD_TOOLS: Tool[] = [
  ...PLANNER_TOOLS,
  ...COLLECTION_TOOLS,
  tool('workspace_list', '列出自己的文件、草稿和收藏，返回文件 ID。文件默认私人可见。', p({})),
  tool('workspace_read', '读当前成员有权限的文件；文本返回原文，音频等返回元数据。不能传本地绝对路径。', p({ artifactId: s, name: s })),
  tool('workspace_write', '将完整 UTF-8 正文写入自己的工作区，保留旧版本，返回 artifactId。可以用 Markdown/JSON 存收藏、笔记和代码。', p({ name: s, text: s, mime: s }, ['name', 'text'])),
  tool('workspace_publish', '用户明确要求时，把自己的一份文件分享给指定成员或房间，作者不变。在私人房间说拿到客厅，targetRoom 使用 family。', p({ artifactId: s, agentId: s, room: { type: 'boolean' }, targetRoom: s }, ['artifactId'])),
  tool('task_start', '按用户目标让指定成员在后台干活，立即返回任务 ID，当前聊天继续。可指定已绑定目的地和最终交付类型；只能使用用户本轮指定的目的地。背景任务不能自己创建新任务。', p({ goal: s, agentId: s, destination: s, deliveryKind: { enum: ['text', 'file', 'voice', 'image'] }, artifactIds: list }, ['goal'])),
  tool('task_status', '查任务进度、检查点、产物和结果；不带 ID 时列出当前成员参与的任务。', p({ taskId: s })),
  tool('task_control', '按用户本轮要求暂停、恢复或取消后台任务，不能把结果不明的外部调用自动重发。', p({ taskId: s, action: { enum: ['pause', 'resume', 'cancel'] } }, ['taskId', 'action'])),
  tool('task_handoff', '用户明确要求时将任务交给另一成员；交接目标、检查点和任务产物，保留原作者，不复制旧成员私人记忆与未发布文件。', p({ taskId: s, agentId: s, reason: s }, ['taskId', 'agentId', 'reason'])),
  tool('task_checkpoint', '后台执行者记录当前实际进度、卡点和已产生的文件 ID。检查点是可交接的任务记录，不是个人记忆。', p({ text: s, artifactIds: list }, ['text'])),
  tool('delivery_targets', '列出用户预先绑定的目的地、别名和媒体能力；不能猜测用户 ID、频道或任意收件人。', p({})),
  tool('delivery_send', '用户本轮明确要求发送时，把文字、文件、图片或原生语音发到其指定目的地。支持在 QQ/微信发指令而发送到 DC/TG。kind=voice 必须传音频文件 ID，不附文字；缺少目的地配置要如实说明。', p({ destination: s, kind: { enum: ['text', 'file', 'voice', 'image'] }, text: s, artifactId: s }, ['destination', 'kind'])),
  tool('inbox_read', '读取当前成员的跨端收件箱与任务成果，用户可从任意已认证客户端领取附件。', p({})),
  tool('speech_generate', '按当前成员配置的音色朗读正文，返回音频文件 ID。需要已配置的兼容语音服务；返回音频后可用 delivery_send 作为原生语音发送。', p({ text: s }, ['text'])),
  tool('notify_when', '用户明确交代“完成/失败告诉我”或定时通知时登记持久规则。event 可选 task.succeeded/task.failed/mcp.job.completed/signal；match 为 taskId/serviceId/status/name 等精确字段。at 为 ISO 时间，everyMs 为明确要求的周期。只向用户指定目的地发，未指定则进收件箱。', p({ event: { enum: ['task.succeeded', 'task.failed', 'mcp.job.completed', 'signal'] }, match: { type: 'object', additionalProperties: s }, at: s, everyMs: { type: 'integer', minimum: 60000 }, destination: s, text: s, once: { type: 'boolean' } }, ['text'])),
  tool('notify_control', '按用户本轮要求关闭一条通知规则，停止后续自动触发；已经发出的消息不会撤回。', p({ ruleId: s, action: { enum: ['disable'] } }, ['ruleId', 'action'])),
];
export const WORLD_NAMES = new Set(WORLD_TOOLS.map(t => t.function.name));
export const WORKER_NAMES = new Set(['workspace_list', 'workspace_read', 'workspace_write', 'task_checkpoint', 'speech_generate']);
