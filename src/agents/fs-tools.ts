// Shared write_file/run_shell tool definitions + executor, scoped to a
// workdir. Originally inline in generic-agent.ts (Phase 0); extracted so the
// Phase 1 openai-compat AgentRuntime reuses the identical, already-reviewed
// path-escape guard (safeJoin) and shell denylist rather than a re-diverged
// copy — a security-sensitive path shouldn't exist twice.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ToolDef } from '../providers/openai-compat.js';
import { denylistCheck } from '../security/redact.js';

const exec = promisify(execFile);

export interface Receipt {
  cmd: string;
  exit: number | null;
  outputRef: string;
}

export const FS_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a whitelisted shell command in the workspace and capture output.',
      parameters: {
        type: 'object',
        properties: { cmd: { type: 'string' } },
        required: ['cmd'],
      },
    },
  },
];

/** Resolve a relative path inside workdir; refuse escapes (scoped write).
 * Bare `startsWith` on the resolved prefix is a classic bypass (CWE-22):
 * "/work" `.startsWith("/wor")` is true, and so is "/workdir-evil" against
 * "/workdir" — only a path equal to the base or nested under it with an
 * actual separator counts as contained. */
export function safeJoin(workdir: string, rel: string): string {
  const base = resolve(workdir);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return abs;
}

/** Returns a tool executor for FS_TOOLS, appending each result to `receipts`. */
export function makeFsToolExecutor(
  workdir: string,
  receipts: Receipt[],
): (name: string, argsJson: string) => Promise<string> {
  return async (name: string, argsJson: string): Promise<string> => {
    const args = JSON.parse(argsJson) as { path?: string; content?: string; cmd?: string };
    if (name === 'write_file' && args.path !== undefined && typeof args.content === 'string') {
      const abs = safeJoin(workdir, args.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, args.content);
      receipts.push({ cmd: `write ${args.path}`, exit: 0, outputRef: 'inline' });
      return `wrote ${args.path} (${args.content.length} bytes)`;
    }
    if (name === 'run_shell' && typeof args.cmd === 'string') {
      denylistCheck(args.cmd); // throws on destructive input
      // ponytail: sh -c behind denylist + timeout; per-command allowlist when
      // Phase 3 shell policy lands (PLAN §3.6).
      try {
        const out = await exec('sh', ['-c', args.cmd], { cwd: workdir, timeout: 30_000 });
        const text = `${out.stdout}${out.stderr}`.slice(0, 2000);
        receipts.push({ cmd: args.cmd, exit: 0, outputRef: 'captured' });
        return text || '(no output)';
      } catch (e: unknown) {
        const err = e as { code?: number | null; stdout?: string; stderr?: string };
        const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(0, 2000);
        receipts.push({ cmd: args.cmd, exit: err.code ?? null, outputRef: 'captured' });
        return `exit ${err.code}\n${text}`;
      }
    }
    throw new Error(`unknown tool ${name}`);
  };
}
