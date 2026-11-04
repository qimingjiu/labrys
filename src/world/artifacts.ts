import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, open, lstat, realpath } from 'node:fs/promises';
import { mkdirSync, lstatSync } from 'node:fs';
import { join, resolve, sep, posix } from 'node:path';
import { constants } from 'node:fs';
import type { FamilyStore } from '../store.ts';
import { OWNER, ensure } from '../types.ts';
import type { Actor } from '../types.ts';
import type { Artifact } from './types.ts';

export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
export class Workspaces {
  store: FamilyStore; root: string;
  constructor(store: FamilyStore, root: string) {
    this.store = store; this.root = resolve(root); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    ensure(!lstatSync(this.root).isSymbolicLink(), 500, 'bad_workspace_root', '工作区目录不能是符号链接');
    store.db.exec(`CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_files(agent_id TEXT NOT NULL,name TEXT NOT NULL,artifact_id TEXT NOT NULL,PRIMARY KEY(agent_id,name));`);
  }
  private safeName(name: string): string {
    ensure(typeof name === 'string' && name.length > 0 && name.length <= 180 && !/[\\\x00-\x1f]/.test(name) && !posix.isAbsolute(name) && name.split('/').every(s => s && s !== '.' && s !== '..' && !s.startsWith('.')), 400, 'bad_workspace_name', '工作区文件名必须是安全的相对名称'); return name;
  }
  get(actor: Actor, id: string, roomId: string): Artifact {
    this.store.room(actor, roomId); const row = this.store.db.prepare('SELECT data FROM artifacts WHERE id=?').get(id) as any;
    ensure(row, 404, 'artifact_not_found', '文件不存在'); const value: Artifact = JSON.parse(row.data);
    ensure(actor.kind === 'user' || actor.kind === 'agent' && (value.ownerId === actor.id || value.agentIds.includes(actor.id) || value.roomIds.includes(roomId)), 403, 'artifact_forbidden', '不能读取其他成员的私人文件'); return value;
  }
  private path(a: Artifact): string { return join(this.root, a.ownerId, a.id); }
  async bytes(actor: Actor, id: string, roomId: string): Promise<Buffer> {
    const artifact = this.get(actor, id, roomId); const path = this.path(artifact);
    ensure((await realpath(path)).startsWith((await realpath(this.root)) + sep) && !(await lstat(join(this.root, artifact.ownerId))).isSymbolicLink(), 403, 'workspace_escape', '工作区文件路径越界');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await handle.stat(); ensure(stat.isFile() && stat.size === artifact.bytes && stat.size <= MAX_ARTIFACT_BYTES, 409, 'artifact_changed', '文件内容已在网关之外变更'); const data = await handle.readFile(); ensure(createHash('sha256').update(data).digest('hex') === artifact.sha256, 409, 'artifact_changed', '文件内容校验不一致'); return data; }
    finally { await handle.close(); }
  }
  async create(actor: Actor, roomId: string, input: { name: string; mime: string; bytes: Buffer; ownerId?: string; parentId?: string; voice?: Artifact['voice'] }, updateWorkspace = true): Promise<Artifact> {
    this.store.room(actor, roomId); ensure(actor.kind !== 'controller', 403, 'controller_read_only', '总控不能写成员工作区');
    const ownerId = actor.kind === 'agent' ? actor.id : input.ownerId ?? this.store.room(OWNER, roomId).activeAgentId; this.store.agent(ownerId);
    ensure(this.store.room(OWNER, roomId).members.includes(ownerId), 403, 'workspace_room_forbidden', '成员不在这个房间');
    const name = this.safeName(input.name); ensure(typeof input.mime === 'string' && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(input.mime), 400, 'bad_mime', '文件 MIME 类型无效');
    ensure(Buffer.isBuffer(input.bytes) && input.bytes.length > 0 && input.bytes.length <= MAX_ARTIFACT_BYTES, 413, 'artifact_too_large', '文件需要 1 字节到 25 MiB');
    const directory = join(this.root, ownerId); await mkdir(directory, { recursive: true, mode: 0o700 });
    ensure(!(await lstat(directory)).isSymbolicLink() && (await realpath(directory)).startsWith((await realpath(this.root)) + sep), 403, 'workspace_escape', '成员工作区路径越界');
    const artifact: Artifact = { id: randomUUID(), ownerId, name, mime: input.mime, bytes: input.bytes.length, sha256: createHash('sha256').update(input.bytes).digest('hex'), createdAt: new Date().toISOString(), roomIds: [], agentIds: [], ...(input.parentId ? { parentId: input.parentId } : {}), ...(input.voice ? { voice: input.voice } : {}) };
    await writeFile(this.path(artifact), input.bytes, { flag: 'wx', mode: 0o600 });
    this.store.db.prepare('INSERT INTO artifacts VALUES(?,?)').run(artifact.id, JSON.stringify(artifact));
    if (updateWorkspace) this.store.db.prepare('INSERT OR REPLACE INTO workspace_files VALUES(?,?,?)').run(ownerId, name, artifact.id);
    this.store.event(actor, roomId, 'workspace.written', { artifactId: artifact.id, name, privateTo: ownerId }); return artifact;
  }
  list(actor: Actor, roomId: string, ownerId = actor.id): Artifact[] {
    this.store.room(actor, roomId); this.store.agent(ownerId);
    const ids = this.store.db.prepare('SELECT artifact_id FROM workspace_files WHERE agent_id=? ORDER BY name LIMIT 200').all(ownerId) as any[];
    return ids.flatMap(row => { try { return [this.get(actor, row.artifact_id, roomId)]; } catch { return []; } });
  }
  byName(actor: Actor, roomId: string, name: string): Artifact {
    this.safeName(name); const row = this.store.db.prepare('SELECT artifact_id FROM workspace_files WHERE agent_id=? AND name=?').get(actor.id, name) as any;
    ensure(row, 404, 'workspace_file_not_found', '工作区中没有这个文件'); return this.get(actor, row.artifact_id, roomId);
  }
  share(actor: Actor, id: string, roomId: string, target: { agentId?: string; room?: boolean; roomId?: string }): Artifact {
    const value = this.get(actor, id, roomId);
    ensure(actor.kind === 'user' || actor.kind === 'agent' && value.ownerId === actor.id, 403, 'artifact_share_forbidden', '只有作者或用户能扩大文件可见范围');
    if (target.agentId) { this.store.agent(target.agentId); value.agentIds = [...new Set([...value.agentIds, target.agentId])]; }
    if (target.room) { const targetRoom = target.roomId ?? roomId; this.store.room(actor, targetRoom); value.roomIds = [...new Set([...value.roomIds, targetRoom])]; }
    this.store.db.prepare('UPDATE artifacts SET data=? WHERE id=?').run(JSON.stringify(value), id); this.store.event(actor, roomId, 'workspace.shared', { artifactId: id, ...target }); return value;
  }
}
