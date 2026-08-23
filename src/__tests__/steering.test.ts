import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Conductor, type Config } from '../conductor/conductor.js';

const CFG: Config = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };
let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('journaled cockpit steering', () => {
  it('pauses and resumes waiters without terminating the engagement', async () => {
    dir = await mkdtemp(join(tmpdir(), 'm1m1r-steer-'));
    const conductor = await Conductor.open(dir, CFG);
    await conductor.pause();
    let continued = false;
    const waiting = conductor.waitWhilePaused().then(() => { continued = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(continued).toBe(false);
    await conductor.resumeRun();
    await waiting;
    expect(continued).toBe(true);

    const reopened = await Conductor.open(dir, CFG);
    expect(reopened.state.paused).toBe(false);
  });

  it('persists question answers and task redirects across resume', async () => {
    dir = await mkdtemp(join(tmpdir(), 'm1m1r-steer-'));
    const conductor = await Conductor.open(dir, CFG);
    conductor.state.teamNodes = [{ id: 'auth', scope: ['src/auth.ts'], acceptanceCriteria: 'works', dependsOn: [], input: 'old brief' }];
    await conductor.record('TEAM_PLAN', conductor.state.teamNodes, 'PLAN');
    await conductor.raiseQuestion({
      id: 'q1', blocking: true, questionLayman: 'Which policy?', options: [{ id: 'soft', label: 'Soft delete' }],
    });
    await conductor.answerQuestion('q1', 'soft');
    await conductor.redirectTask('auth', 'keep backward compatibility');

    const reopened = await Conductor.open(dir, CFG);
    expect(reopened.state.openQuestions).toEqual([]);
    expect(reopened.state.taskRedirects.auth).toBe('keep backward compatibility');
    expect(reopened.taskInput('auth', 'old brief')).toContain('Human redirect: keep backward compatibility');
  });
});
