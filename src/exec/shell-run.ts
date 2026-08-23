// Shell execution for human-facing entry points: the REPL's `!` command and
// the team engagement's --test post-merge command. Extracted from
// src/bin/m1m1r.ts (which runs main() unconditionally at import — not
// testable directly) both for testability and because this is the second
// shell-execution surface in the codebase (fs-tools.ts's run_shell tool
// executor is the first), and both must route through the same denylist:
// it's REPL/human-typed or human-configured, not LLM-controlled, but the
// denylist is a mistake guard too, not only an adversarial-LLM guard, and
// PLAN §3.6's "hard denylist, no exceptions" doesn't carve out an exception
// for human-typed commands.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { denylistCheck } from '../security/redact.js';

const execFileAsync = promisify(execFile);

export async function shellRun(cwd: string, cmd: string): Promise<{ ok: boolean; output: string }> {
  try {
    denylistCheck(cmd);
  } catch (e: unknown) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', cmd], { cwd, timeout: 120_000 });
    return { ok: true, output: `${stdout}${stderr}` };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}
