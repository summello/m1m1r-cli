// Evidence store tests (PLAN §3.3 minimal slice): grounding rule, roundtrip.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conductor, Journal, type JournalEvent, type Config } from '../conductor/conductor.js';
import { Redactor } from '../security/redact.js';
import { cmdEvidence, attachEvidence, collectEvidence, type EvidenceObject } from '../evidence/store.js';

const CFG: Config = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };

async function makeConductor(dir: string): Promise<Conductor> {
  const redactor = new Redactor();
  const journal = await Journal.open(join(dir, 'journal.jsonl'), redactor);
  const c = new Conductor(dir, journal, { id: '', phase: 'VERIFY', budget: { spentUsd: 0, ceilingUsd: 25, level: 'ok' }, usageTotals: { promptTokens: 0, completionTokens: 0 }, openQuestions: [], paused: false, taskRedirects: {} }, CFG);
  return c;
}

describe('evidence store', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'm1m1r-evid-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('cmdEvidence: verified when exit 0, unverified otherwise', () => {
    const v = cmdEvidence('test passes', 'journal#1', 'npm test', 0);
    expect(v.confidence).toBe('verified');
    const u = cmdEvidence('test fails', 'journal#2', 'npm test', 1);
    expect(u.confidence).toBe('unverified');
  });

  it('attachEvidence journals EVIDENCE event', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const ev: EvidenceObject = { claim: 'foo', source: { kind: 'cmd_output', ref: 'journal#1', cmd: 'echo foo', exit: 0 }, confidence: 'verified' };
    const evt = await attachEvidence(c, ev);
    expect(evt.event).toBe('EVIDENCE');
    expect((evt.payload as EvidenceObject).claim).toBe('foo');
  });

  it('collectEvidence rebuilds from journal', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    await attachEvidence(c, { claim: 'a', source: { kind: 'cmd_output', ref: 'journal#1', cmd: 'x', exit: 0 }, confidence: 'verified' });
    await attachEvidence(c, { claim: 'b', source: { kind: 'diff_scan', ref: 'worktree:n1' }, confidence: 'inferred' });
    const evs = collectEvidence(c.journal.eventsAll);
    expect(evs.length).toBe(2);
    expect(evs[0].claim).toBe('a');
    expect(evs[1].confidence).toBe('inferred');
  });

  it('evidence roundtrip preserves structure', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const original: EvidenceObject = {
      claim: 'the suite passed',
      source: { kind: 'cmd_output', ref: 'journal#42', cmd: 'npm test', exit: 0 },
      confidence: 'verified',
    };
    await attachEvidence(c, original);
    const rebuilt = collectEvidence(c.journal.eventsAll);
    expect(rebuilt).toEqual([original]);
  });
});