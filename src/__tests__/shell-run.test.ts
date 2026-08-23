// Regression test for a real gap an independent review caught: the REPL's
// `!` command and the team engagement's --test runner both called
// execFile('sh', ['-c', cmd]) directly, bypassing the shell denylist that
// every other shell-execution surface (fs-tools.ts's run_shell tool) routes
// through — a second, unguarded path for exactly the kind of command the
// denylist exists to block.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shellRun } from '../exec/shell-run.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'm1m1r-shellrun-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('shellRun', () => {
  it('blocks a denylisted command before it ever executes', async () => {
    const result = await shellRun(dir, 'rm -rf /');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('blocked by shell policy');
  });

  it('runs an ordinary command normally', async () => {
    const result = await shellRun(dir, 'echo hello');
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('blocks a force-push attempt the same as fs-tools.ts would', async () => {
    const result = await shellRun(dir, 'git push origin main --force');
    expect(result.ok).toBe(false);
  });
});
