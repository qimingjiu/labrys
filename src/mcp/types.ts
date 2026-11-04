import type { Tool } from '../types.ts';
export type Manifest = {
  id: string; kind: 'npm' | 'python' | 'docker' | 'remote'; package?: string; version?: string;
  executable?: string; module?: string; image?: string; url?: string; args?: string[];
  protocol?: '2025-11-25' | '2026-07-28'; env?: Record<string, string>;
  secretEnv?: Record<string, string>; secretHeaders?: Record<string, string>;
  allowedAgents: string[]; allowedRooms: string[]; allowedTools?: string[];
};
export type Launch = { command: string; args: string[]; cwd: string; env: Record<string, string> };
export type McpTool = { name: string; description?: string; inputSchema?: Record<string, unknown> };
export type Connection = {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>; close(): Promise<void>;
};
export type SecretResolver = { value(ref: string): string; redact(text: string): string };
export type Log = (line: string) => void;
export type DeploymentRunner = { deploy(manifest: Manifest, directory: string, log: Log, signal: AbortSignal): Promise<Launch | null> };
export type ManagedTool = Tool & { serverId: string; originalName: string };
export type Attachment = { kind: 'image' | 'audio'; mime_type: string; data: string };
