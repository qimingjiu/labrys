import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Manifest, Launch, Log, DeploymentRunner } from './types.ts';
import { AppError, ensure } from '../types.ts';
import { lineLogger } from './log.ts';

export function cleanEnvironment(directory: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), TEMP: join(directory, 'tmp'), PYTHONUNBUFFERED: '1' };
}
export function runProcess(command: string, args: string[], directory: string, log: Log, signal: AbortSignal, timeoutMs = 300000): Promise<string> {
  const cancel = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  return new Promise((resolveResult, reject) => {
    if (cancel.aborted) { reject(new AppError(499, 'job_cancelled', '任务已取消')); return; }
    const child = spawn(command, args, { cwd: directory, env: cleanEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
    let output = '', finished = false; let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      try { process.platform !== 'win32' && child.pid ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.platform !== 'win32' && child.pid ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch {} }, 1000); killTimer.unref();
    };
    const cleanup = () => { cancel.removeEventListener('abort', terminate); if (killTimer) clearTimeout(killTimer); };
    const fail = (e: unknown) => { if (finished) return; finished = true; cleanup(); reject(e); };
    cancel.addEventListener('abort', terminate, { once: true });
    for (const stream of [child.stdout, child.stderr]) { const lines = lineLogger(log); stream.setEncoding('utf8'); stream.on('data', text => { output = (output + text).slice(-32768); lines.write(String(text)); }); stream.on('end', () => lines.end()); }
    child.on('error', e => fail(new AppError(409, 'runtime_missing', `运行程序不可用：${command}（${e.name}）`)));
    child.on('close', code => {
      if (finished) return; finished = true; cleanup();
      if (cancel.aborted) reject(new AppError(504, 'install_timeout', '安装被取消或超过时限'));
      else if (code !== 0) reject(new AppError(502, 'install_failed', `部署命令退出码 ${code}`));
      else resolveResult(output);
    });
  });
}

export class PackageRunner implements DeploymentRunner {
  // The resolver is an injection point for an administrator-provided package mirror and hermetic tests.
  // It is never supplied by a model or HTTP request.
  source: (manifest: Manifest) => string;
  constructor(source?: (manifest: Manifest) => string) { this.source = source ?? (m => m.kind === 'npm' ? `${m.package}@${m.version}` : `${m.package}==${m.version}`); }
  async deploy(manifest: Manifest, directory: string, log: Log, signal: AbortSignal): Promise<Launch | null> {
    await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(join(directory, 'home'), { recursive: true, mode: 0o700 }); await mkdir(join(directory, 'tmp'), { recursive: true, mode: 0o700 });
    const env = cleanEnvironment(directory);
    if (manifest.kind === 'remote') return null;
    if (manifest.kind === 'npm') {
      await runProcess('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--', this.source(manifest)], directory, log, signal);
      const packageRoot = join(directory, 'node_modules', manifest.package!);
      const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      ensure(installed.name === manifest.package && installed.version === manifest.version, 409, 'package_mismatch', '安装得到的包名或版本与计划不同');
      const bins: Record<string, string> = typeof installed.bin === 'string' ? { [manifest.package!.split('/').at(-1)!]: installed.bin } : installed.bin ?? {};
      const names = Object.keys(bins); const executable = manifest.executable ?? (names.length === 1 ? names[0] : undefined);
      ensure(executable && typeof bins[executable] === 'string', 409, 'executable_required', `需要选择启动入口，可用名称：${names.join(', ').slice(0, 200)}`);
      const entry = await realpath(resolve(packageRoot, bins[executable])); const root = await realpath(packageRoot);
      ensure(entry.startsWith(root + sep), 403, 'bad_package_entry', 'MCP 启动文件超出所安装的包目录');
      return { command: process.execPath, args: [entry, ...(manifest.args ?? [])], cwd: directory, env };
    }
    if (manifest.kind === 'python') {
      await runProcess('python3', ['-m', 'venv', join(directory, 'venv')], directory, log, signal);
      const bin = join(directory, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
      const python = join(bin, process.platform === 'win32' ? 'python.exe' : 'python');
      await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', this.source(manifest)], directory, log, signal);
      if (manifest.module) return { command: python, args: ['-m', manifest.module, ...(manifest.args ?? [])], cwd: directory, env };
      ensure(manifest.executable, 409, 'executable_required', 'Python MCP 需要 executable 或 module');
      const entry = await realpath(join(bin, manifest.executable!));
      ensure(entry.startsWith((await realpath(join(directory, 'venv'))) + sep), 403, 'bad_package_entry', 'Python 入口超出专属环境');
      return { command: entry, args: manifest.args ?? [], cwd: directory, env };
    }
    await runProcess('docker', ['pull', manifest.image!], directory, log, signal);
    const image = (await runProcess('docker', ['image', 'inspect', '--format={{.Id}}', manifest.image!], directory, () => {}, signal)).trim();
    ensure(/^sha256:[a-f0-9]{64}$/.test(image), 502, 'invalid_image_id', '无法固定 Docker 镜像内容标识');
    return { command: 'docker', args: ['run', '--rm', '-i', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--cpus=1', '--pids-limit=128', '--tmpfs=/tmp:rw,nosuid,size=128m', ...Object.keys({ ...manifest.env, ...manifest.secretEnv }).flatMap(k => ['--env', k]), image, ...(manifest.args ?? [])], cwd: directory, env };
  }
}
