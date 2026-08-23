// Hooks runner tests (PLAN §3.6): .m1m1r/hooks/<event>.sh interception.
// A pre-gate hook failure can fail a gate that would otherwise pass (done-criterion).

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookRunner, HookBlockedError, type HookEvent } from '../conductor/hooks.js';

let hooksDir: string;
let runner: HookRunner;

beforeEach(async () => {
  hooksDir = await mkdtemp(join(tmpdir(), 'm1m1r-hooks-'));
  runner = new HookRunner(hooksDir);
});

afterEach(async () => {
  await rm(hooksDir, { recursive: true, force: true });
});

async function makeHook(event: HookEvent, content: string): Promise<void> {
  const path = join(hooksDir, `${event}.sh`);
  await writeFile(path, `#!/bin/sh\n${content}\n`);
  await chmod(path, 0o755);
}

describe('HookRunner', () => {
  it('no hook file -> fired:false, ok:true (no-op, never error)', async () => {
    const res = await runner.fire('pre-gate', { gate: 'security' });
    expect(res).toEqual({ fired: false, ok: true });
  });

  it('exit 0 -> ok:true', async () => {
    await makeHook('pre-gate', 'echo pre-ok; exit 0');
    const res = await runner.fire('pre-gate', { gate: 'security' });
    expect(res.fired).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('pre-ok');
  });

  it('exit 1 -> ok:false, output captured', async () => {
    await makeHook('pre-gate', 'echo block >&2; exit 1');
    const res = await runner.fire('pre-gate', { gate: 'security' });
    expect(res.fired).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('block');
  });

  it('payload passed via M1M1R_PAYLOAD env', async () => {
    await makeHook('pre-gate', 'echo "PAYLOAD=$M1M1R_PAYLOAD"');
    const res = await runner.fire('pre-gate', { gate: 'security', taskId: 'n1' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('taskId');
    expect(res.output).toContain('n1');
  });

  it('M1M1R_PHASE and M1M1R_ENGAGEMENT_DIR env set', async () => {
    await makeHook('phase-transition', 'echo "PHASE=$M1M1R_PHASE ENG=$M1M1R_ENGAGEMENT_DIR"');
    const res = await runner.fire('phase-transition', { to: 'VERIFY' }, { phase: 'PLAN', engagementDir: '/foo/eng' });
    expect(res.ok).toBe(true);
    expect(res.output).toContain('PHASE=PLAN');
    expect(res.output).toContain('ENG=/foo/eng');
  });

  it('pre-elevated-action event works', async () => {
    await makeHook('pre-elevated-action', 'exit 0');
    const res = await runner.fire('pre-elevated-action', { action: 'deploy' });
    expect(res.fired).toBe(true);
    expect(res.ok).toBe(true);
  });

  it('post-gate event works', async () => {
    await makeHook('post-gate', 'exit 0');
    const res = await runner.fire('post-gate', { gate: 'review', pass: true });
    expect(res.fired).toBe(true);
    expect(res.ok).toBe(true);
  });
});

describe('Conductor phase-transition hook integration', () => {
  it('hook blocking phase-transition throws HookBlockedError and records HOOK_BLOCKED', async () => {
    const { Conductor } = await import('../conductor/conductor.js');
    const { Redactor } = await import('../security/redact.js');
    const { mkdtemp, rm, writeFile, chmod, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const dir = await mkdtemp(join(tmpdir(), 'm1m1r-hook-test-'));
    const hooksDir = join(dir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(join(hooksDir, 'phase-transition.sh'), `#!/bin/sh\necho blocked >&2\nexit 1\n`);
    await chmod(join(hooksDir, 'phase-transition.sh'), 0o755);

    const redactor = new Redactor();
    const cfg = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };
    const conductor = await Conductor.open(dir, cfg, redactor, hooksDir);
    await conductor.journal.append('INTAKE', 'START', { requirement: 'test' });

    try {
      await conductor.transition('PLAN', 'PHASE');
      expect.fail('expected HookBlockedError');
    } catch (e) {
      expect(e).toBeInstanceOf(HookBlockedError);
      expect((e as HookBlockedError).hookEvent).toBe('phase-transition');
    }
    // HOOK_BLOCKED event recorded
    const events = conductor.journal.eventsAll;
    const blocked = events.find((e) => e.event === 'HOOK_BLOCKED');
    expect(blocked).toBeDefined();
    expect((blocked?.payload as any).hookEvent).toBe('phase-transition');
    // phase did not advance
    expect(conductor.state.phase).toBe('INTAKE');

    await rm(dir, { recursive: true, force: true });
  });
});