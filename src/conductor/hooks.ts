// User-defined hooks (PLAN §3.6): `.m1m1r/hooks/<event>.sh` — project-authored
// shell scripts firing on conductor events. Events: `pre-gate`, `post-gate`,
// `pre-elevated-action`, `phase-transition`. A hook can BLOCK (non-zero exit
// halts the transition, same as a failed gate) but can never silently
// auto-approve — it's additive friction, not a bypass.
//
// Distinct from the shell denylist (src/security/redact.ts): the denylist is
// the harness's own hard floor and can't be relaxed by anything; hooks are the
// project's extension point for things the harness can't anticipate (a
// project-specific linter as an extra pre-gate check, a Slack ping on
// pre-elevated-action).
//
// Contract: the script runs as `sh <hooksDir>/<event>.sh` with cwd = the
// hooks dir, env `M1M1R_EVENT`, `M1M1R_PHASE`, `M1M1R_ENGAGEMENT_DIR`, and
// `M1M1R_PAYLOAD` (JSON string of the event context). Missing script is a
// no-op (fired:false), never an error — absence of hooks means default
// behavior, not blockage.

import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type HookEvent = 'pre-gate' | 'post-gate' | 'pre-elevated-action' | 'phase-transition';

export interface HookOutcome {
  fired: boolean;
  ok: boolean;
  output?: string;
}

export class HookBlockedError extends Error {
  constructor(
    readonly hookEvent: HookEvent,
    readonly output: string,
  ) {
    super(`${hookEvent} hook blocked the transition: ${output.slice(0, 500)}`);
    this.name = 'HookBlockedError';
  }
}

export class HookRunner {
  constructor(private hooksDir: string) {}

  private scriptPath(event: HookEvent): string {
    return join(this.hooksDir, `${event}.sh`);
  }

  private async present(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Fire `<hooksDir>/<event>.sh` if it exists. Never throws for the script's
   * own non-zero exit — that's reported as ok:false so the caller decides how
   * the block propagates (gates turn it into a failed gate; transitions throw
   * HookBlockedError). A script that can't even spawn counts as blocked, not
   * silently passed: additive friction must fail closed. */
  async fire(
    event: HookEvent,
    payload: Record<string, unknown> = {},
    env: { phase?: string; engagementDir?: string } = {},
  ): Promise<HookOutcome> {
    const script = this.scriptPath(event);
    if (!(await this.present(script))) return { fired: false, ok: true };
    try {
      const { stdout, stderr } = await execFileAsync('sh', [script], {
        cwd: this.hooksDir,
        timeout: 30_000,
        env: {
          ...process.env,
          M1M1R_EVENT: event,
          M1M1R_PHASE: env.phase ?? '',
          M1M1R_ENGAGEMENT_DIR: env.engagementDir ?? '',
          M1M1R_PAYLOAD: JSON.stringify(payload),
        },
        maxBuffer: 1024 * 1024,
      });
      return { fired: true, ok: true, output: `${stdout}${stderr}` };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return {
        fired: true,
        ok: false,
        output: `${err.stdout ?? ''}${err.stderr ?? err.message ?? 'hook failed'}`,
      };
    }
  }
}
