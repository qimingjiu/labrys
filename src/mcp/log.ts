import type { Log } from './types.ts';
// Process chunks do not align with credential or line boundaries. Only release complete
// bounded lines for redaction; discard oversized lines rather than logging partial secrets.
export function lineLogger(log: Log): { write: (chunk: string) => void; end: () => void } {
  let buffer = '', dropping = false;
  return {
    write(chunk) {
      for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        buffer += part;
        if (buffer.length > 16000) { buffer = ''; dropping = true; }
        if (part.endsWith('\n')) { if (dropping) log('超长日志行已省略'); else if (buffer.trim()) log(buffer.trimEnd()); buffer = ''; dropping = false; }
      }
    },
    end() { if (!dropping && buffer.trim()) log(buffer.trimEnd()); buffer = ''; },
  };
}
