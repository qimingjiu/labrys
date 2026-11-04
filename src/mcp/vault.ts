import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensure } from '../types.ts';

export class SecretVault {
  db: DatabaseSync; key: Buffer;
  constructor(db: DatabaseSync, directory: string, configuredKey?: string) {
    this.db = db; mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'vault.key');
    if (configuredKey) this.key = /^[a-f0-9]{64}$/i.test(configuredKey) ? Buffer.from(configuredKey, 'hex') : Buffer.from(configuredKey, 'base64');
    else {
      if (!existsSync(path)) writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
      ensure(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 500, 'bad_vault_key', '凭据密钥文件无效');
      this.key = readFileSync(path);
    }
    ensure(this.key.length === 32, 500, 'bad_vault_key', 'MCP_SECRET_KEY 需要 32 字节');
    db.exec('CREATE TABLE IF NOT EXISTS mcp_secrets(ref TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  put(ref: string, value: string): void {
    ensure(typeof ref === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(ref), 400, 'bad_secret_ref', '凭据引用名无效');
    ensure(typeof value === 'string' && value.length > 0 && value.length <= 16000, 400, 'bad_secret', '凭据需要 1–16000 字符');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.db.prepare('INSERT OR REPLACE INTO mcp_secrets VALUES(?,?)').run(ref, JSON.stringify([iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')]));
  }
  value(ref: string): string {
    const row = this.db.prepare('SELECT value FROM mcp_secrets WHERE ref=?').get(ref) as any;
    ensure(row, 409, 'missing_secret', `需要先填写凭据引用 ${ref}`);
    const [iv, tag, data] = JSON.parse(row.value); const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
  list(): string[] { return (this.db.prepare('SELECT ref FROM mcp_secrets ORDER BY ref').all() as any[]).map(r => r.ref); }
  redact(text: string): string {
    let safe = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
    for (const ref of this.list()) { try { const value = this.value(ref); for (const part of [value, ...value.split(/\r?\n/)].filter(Boolean)) safe = safe.split(part).join('[REDACTED]'); } catch {} }
    return safe.slice(0, 2000);
  }
}
