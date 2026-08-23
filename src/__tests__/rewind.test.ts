// Rewind tests (PLAN §3.1): fork a new engagement from journal prefix.

import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conductor, Journal, type Config } from '../conductor/conductor.js';
import { Redactor } from '../security/redact.js';
import { listCheckpoints, rewindEngagement } from '../conductor/rewind.js';
import { newEngagementId } from '../conductor/conductor.js';

const CFG: Config = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };

async function makeJournal(dir: string): Promise<Journal> {
  const redactor = new Redactor();
  return Journal.open(join(dir, 'journal.jsonl'), redactor);
}

describe('listCheckpoints', () => {
  it('finds phase transitions, gate passes, question answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm1m1r-rewind-'));
    const j = await makeJournal(dir);
    await j.append('INTAKE', 'PHASE');
    await j.append('CLARIFY', 'SKIPPED', { reason: 'no questions' });
    await j.append('PLAN', 'PHASE');
    await j.append('APPROVE', 'AUTO_APPROVED', { mode: 'semi' });
    await j.append('EXECUTE', 'PHASE');
    await j.append('VERIFY', 'GATE_RESULT', { gate: 'security', pass: true, taskId: 'n1', findings: [], evidenceRefs: [] });
    await j.append('VERIFY', 'GATE_RESULT', { gate: 'review', pass: false, taskId: 'n2', findings: [], evidenceRefs: [] });
    await j.append('INTEGRATE', 'GATE_RESULT', { gate: 'integrate', pass: true, findings: [], evidenceRefs: [] });
    await j.append('REPORT', 'QUESTION_ANSWERED', { id: 'q1' });
    const events = j.eventsAll;
    const cps = listCheckpoints(events);
    // PHASE (INTAKE), SKIPPED, PHASE (PLAN), AUTO_APPROVED, PHASE (EXECUTE), GATE_RESULT pass (security), GATE_RESULT pass (integrate), QUESTION_ANSWERED
    expect(cps.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 7, 8]);
    expect(cps.find((c) => c.seq === 5)?.label).toContain('gate passed: security');
    expect(cps.find((c) => c.seq === 6)).toBeUndefined(); // failed gate not a checkpoint
    await rm(dir, { recursive: true, force: true });
  });
});

describe('rewindEngagement', () => {
  let srcDir: string;
  let destRoot: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'm1m1r-rewind-src-'));
    destRoot = await mkdtemp(join(tmpdir(), 'm1m1r-rewind-dest-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destRoot, { recursive: true, force: true });
  });

  it('copies exact byte prefix and new dir has verbatim journal lines', async () => {
    const j = await makeJournal(srcDir);
    await j.append('INTAKE', 'START', { requirement: 'foo' });
    await j.append('PLAN', 'PHASE');
    await j.append('PLAN', 'GATE_RESULT', { gate: 'security', pass: true, taskId: 'n1', findings: [], evidenceRefs: [] });
    const srcJournal = join(srcDir, 'journal.jsonl');
    const newId = newEngagementId();
    const forkDir = join(destRoot, newId);
    await rewindEngagement(srcJournal, forkDir, newId, 1); // copy 0..1 (START + PHASE)
    // verify content
    const srcText = await readFile(srcJournal, 'utf8');
    const destText = await readFile(join(forkDir, 'journal.jsonl'), 'utf8');
    expect(destText.trim().split('\n')).toEqual(srcText.trim().split('\n').slice(0, 2));
    // source untouched
    const srcAfter = await readFile(srcJournal, 'utf8');
    expect(srcAfter.trim().split('\n').length).toBe(3);
  });

  it('forked engagement replays state correctly', async () => {
    const j = await makeJournal(srcDir);
    await j.append('INTAKE', 'START', { requirement: 'my req' });
    await j.append('PLAN', 'PHASE');
    await j.append('APPROVE', 'AUTO_APPROVED', { mode: 'semi' });
    const srcJournal = join(srcDir, 'journal.jsonl');
    const newId = newEngagementId();
    const forkDir = join(destRoot, newId);
    await rewindEngagement(srcJournal, forkDir, newId, 2); // up to APPROVE
    // open forked
    const { Conductor } = await import('../conductor/conductor.js');
    const c = await Conductor.open(forkDir, CFG);
    expect(c.state.requirement).toBe('my req');
    expect(c.state.phase).toBe('APPROVE'); // last phase from replay
  });

  it('invalid seq throws', async () => {
    const j = await makeJournal(srcDir);
    await j.append('INTAKE', 'START', { requirement: 'x' });
    const srcJournal = join(srcDir, 'journal.jsonl');
    const newId = newEngagementId();
    await expect(rewindEngagement(srcJournal, join(destRoot, newId), newId, 5)).rejects.toThrow(/invalid journal seq/);
  });
});