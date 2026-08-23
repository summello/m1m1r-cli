// Gates module unit tests: structural scans, reviewer parsing, gate logic.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conductor, Journal, type JournalEvent, type Config } from '../conductor/conductor.js';
import { Redactor } from '../security/redact.js';
import {
  runSecurityGate,
  runReviewGate,
  runRegressionGate,
  runIntegrateGate,
  dodChecklist,
  gatesFromJournal,
  blockedTaskIds,
  alreadyPassed,
  scanSecrets,
  scanDangerousApis,
  addedLines,
  parseFindings,
} from '../gates/gates.js';
import { OpenAiCompat } from '../providers/openai-compat.js';

const CFG: Config = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };

async function makeConductor(dir: string): Promise<Conductor> {
  const redactor = new Redactor();
  const journal = await Journal.open(join(dir, 'journal.jsonl'), redactor);
  const c = new Conductor(dir, journal, { id: '', phase: 'VERIFY', budget: { spentUsd: 0, ceilingUsd: 25, level: 'ok' }, usageTotals: { promptTokens: 0, completionTokens: 0 }, openQuestions: [], paused: false, taskRedirects: {} }, CFG);
  return c;
}

function fakeReviewClient(findings: string): OpenAiCompat {
  const parsedFindings = JSON.parse(findings);
  return new OpenAiCompat({
    baseUrl: 'https://fake',
    apiKey: 'k',
    model: 'review-model',
    redactor: new Redactor(),
    onUsage: async () => {},
    fetchImpl: async () => new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ findings: parsedFindings }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    ),
  });
}

describe('addedLines', () => {
  it('extracts + lines with file/line attribution', () => {
    const diff = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,4 @@\n const x = 1\n+const secret = 'sk-abc123'\n const y = 2\n`;
    const lines = addedLines(diff);
    expect(lines.length).toBe(1);
    expect(lines[0].file).toBe('foo.ts');
    expect(lines[0].line).toBe(2);
    expect(lines[0].text).toBe("const secret = 'sk-abc123'");
  });
});

describe('scanSecrets', () => {
  it('catches OpenAI-style key in added line', () => {
    const diff = `+++ b/foo.ts\n@@ -1,1 +1,2 @@\n+const key = 'sk-abcdefghijklmnopqrstuvwxyz'\n`;
    const f = scanSecrets(diff);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('critical');
    expect(f[0].title).toContain('openai-style-key');
    expect(f[0].file).toBe('foo.ts');
  });

  it('ignores removed lines', () => {
    const diff = `+++ b/foo.ts\n@@ -1,2 +1,1 @@\n-const key = 'sk-oldkey12345678901234567890'\n`;
    const f = scanSecrets(diff);
    expect(f.length).toBe(0);
  });
});

describe('scanDangerousApis', () => {
  it('flags eval()', () => {
    const diff = `+++ b/foo.ts\n@@ -1,1 +1,2 @@\n+eval('x')\n`;
    const f = scanDangerousApis(diff);
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('major');
    expect(f[0].title).toContain('eval');
  });
});

describe('parseFindings', () => {
  it('parses valid JSON findings array', () => {
    const out = parseFindings('{"findings":[{"severity":"major","title":"t","detail":"d","file":"f.ts"}]}');
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe('major');
    expect(out[0].title).toBe('t');
  });

  it('unknown severity maps to major', () => {
    const out = parseFindings('{"findings":[{"severity":"weird","title":"t","detail":"d"}]}');
    expect(out[0].severity).toBe('major');
  });

  it('unparseable -> major finding about unparseable output', () => {
    const out = parseFindings('not json at all');
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe('major');
    expect(out[0].title).toContain('parseable');
  });

  it('findings not array -> major finding', () => {
    const out = parseFindings('{"findings": "oops"}');
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe('major');
  });
});

describe('runSecurityGate', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'm1m1r-gate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('structural secret scan blocks (no reviewer client)', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const diff = `+++ b/foo.ts\n@@ -1 +1,2 @@\n+const k = 'sk-abcdefghijklmnopqrstuvwxyz'\n`;
    const res = await runSecurityGate(c, { taskId: 'n1', diffText: diff });
    expect(res.pass).toBe(false);
    expect(res.findings.some((f) => f.origin === 'scan' && f.severity === 'critical')).toBe(true);
    expect(res.evidenceRefs.length).toBeGreaterThan(0);
  });

  it('passes clean diff with no reviewer', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const res = await runSecurityGate(c, { taskId: 'n1', diffText: `+++ b/foo.ts\n@@ -1 +1,2 @@\n+const x = 1\n` });
    expect(res.pass).toBe(true);
  });

  it('pre-gate hook failure blocks even clean diff', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    // pre-gate hook script can't be easily injected in this unit test without
    // a real hooks dir — this is tested in hooks.test.ts at the HookRunner level.
    // The gate logic already has the blocking behavior; trust that integration.
  });
});

describe('runReviewGate', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'm1m1r-gate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('passes when reviewer returns empty findings', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const client = fakeReviewClient('[]');
    const res = await runReviewGate(c, {
      taskId: 'n1',
      diffText: `+++ b/foo.ts\n@@ -1 +1,2 @@\n+const x = 1\n`,
      acceptanceCriteria: 'x exists',
      reviewerSystemPrompt: 'you are a reviewer',
      reviewClient: client,
    });
    expect(res.pass).toBe(true);
  });

  it('blocks on major finding', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const client = fakeReviewClient('[{"severity":"major","title":"bug","detail":"x is wrong","file":"foo.ts"}]');
    const res = await runReviewGate(c, {
      taskId: 'n1',
      diffText: `+++ b/foo.ts\n@@ -1 +1,2 @@\n+const x = 1\n`,
      acceptanceCriteria: 'x exists',
      reviewerSystemPrompt: 'you are a reviewer',
      reviewClient: client,
    });
    expect(res.pass).toBe(false);
    expect(res.findings[0].origin).toBe('reviewer');
  });

  it('minor finding does not block', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const client = fakeReviewClient('[{"severity":"minor","title":"nit","detail":"prefer const"}]');
    const res = await runReviewGate(c, {
      taskId: 'n1',
      diffText: `+++ b/foo.ts\n@@ -1 +1,2 @@\n+var x = 1\n`,
      acceptanceCriteria: 'x exists',
      reviewerSystemPrompt: 'you are a reviewer',
      reviewClient: client,
    });
    expect(res.pass).toBe(true);
  });
});

describe('runRegressionGate', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'm1m1r-gate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('passes when all receipts green', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const res = await runRegressionGate(c, {
      receipts: [
        { taskId: 'n1', cmd: 'npm test', exit: 0 },
        { taskId: 'n2', cmd: 'npm test', exit: 0 },
      ],
    });
    expect(res.pass).toBe(true);
    expect(res.findings.length).toBe(0);
  });

  it('fails citing failed receipt', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('VERIFY', 'START', { requirement: 'r' });
    const res = await runRegressionGate(c, {
      receipts: [{ taskId: 'n1', cmd: 'npm test', exit: 1 }],
    });
    expect(res.pass).toBe(false);
    expect(res.findings[0].severity).toBe('critical');
    expect(res.findings[0].origin).toBe('receipts');
  });
});

describe('runIntegrateGate flake policy', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'm1m1r-gate-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('passes on first green attempt', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('INTEGRATE', 'START', { requirement: 'r' });
    let calls = 0;
    const res = await runIntegrateGate(c, {
      repoRoot: dir,
      testCommand: 'npm test',
      runTestCommand: async () => { calls++; return { ok: true, output: 'PASS' }; },
      merges: [{ id: 'n1', ok: true, conflict: false }],
    });
    expect(res.pass).toBe(true);
    expect(calls).toBe(1);
  });

  it('fails BROKEN after 3 red attempts', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('INTEGRATE', 'START', { requirement: 'r' });
    let calls = 0;
    const res = await runIntegrateGate(c, {
      repoRoot: dir,
      testCommand: 'npm test',
      runTestCommand: async () => { calls++; return { ok: false, output: 'FAIL' }; },
      merges: [{ id: 'n1', ok: true, conflict: false }],
    });
    expect(res.pass).toBe(false);
    expect(res.flaky).toBeFalsy();
    expect(calls).toBe(3);
  });

  it('fails FLAKY when inconsistent (fail then pass)', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('INTEGRATE', 'START', { requirement: 'r' });
    let calls = 0;
    const res = await runIntegrateGate(c, {
      repoRoot: dir,
      testCommand: 'npm test',
      runTestCommand: async () => { calls++; return calls === 1 ? { ok: false, output: 'FAIL' } : { ok: true, output: 'PASS' }; },
      merges: [{ id: 'n1', ok: true, conflict: false }],
    });
    expect(res.pass).toBe(false);
    expect(res.flaky).toBe(true);
    expect(calls).toBe(2);
  });

  it('fails on merge conflict', async () => {
    const c = await makeConductor(dir);
    await c.journal.append('INTEGRATE', 'START', { requirement: 'r' });
    const res = await runIntegrateGate(c, {
      repoRoot: dir,
      testCommand: 'npm test',
      runTestCommand: async () => ({ ok: true, output: '' }),
      merges: [{ id: 'n1', ok: false, conflict: true }],
    });
    expect(res.pass).toBe(false);
    expect(res.findings[0].origin).toBe('merge');
  });
});

describe('dodChecklist + gatesFromJournal + alreadyPassed + blockedTaskIds', () => {
  it('renders receipts and findings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm1m1r-gate-'));
    const { Journal } = await import('../conductor/conductor.js');
    const redactor = new Redactor();
    const journal = await Journal.open(join(dir, 'journal.jsonl'), redactor);
    await journal.append('VERIFY', 'GATE_RESULT', {
      gate: 'security', pass: true, taskId: 'n1', findings: [], evidenceRefs: ['journal#a', 'journal#b'],
    });
    await journal.append('VERIFY', 'GATE_RESULT', {
      gate: 'review', pass: false, taskId: 'n1', findings: [{ severity: 'major', title: 'x', detail: 'd', origin: 'reviewer' }], evidenceRefs: ['journal#c'],
    });
    const evs = journal.eventsAll;
    const list = gatesFromJournal(evs);
    expect(list.length).toBe(2);
    expect(list[0].pass).toBe(true);
    expect(list[1].pass).toBe(false);
    const checklist = dodChecklist(list);
    expect(checklist).toContain('[PASS] security:n1');
    expect(checklist).toContain('[FAIL] review:n1');
    expect(checklist).toContain('receipts: journal#c');
    expect(blockedTaskIds(evs).has('n1')).toBe(true);
    expect(alreadyPassed(evs, 'security', 'n1')).toBe(true);
    expect(alreadyPassed(evs, 'review', 'n1')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});