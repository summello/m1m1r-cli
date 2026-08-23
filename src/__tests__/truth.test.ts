import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conductor, loadConfig } from '../conductor/conductor.js';
import { canGroundWork, gradeEvidence, makeEvidence } from '../truth/evidence.js';
import { auditReport, survivalRate } from '../truth/auditor.js';
import { loadRole, DEFAULT_ROLES_DIR } from '../agents/registry.js';
import {
  batchQuestions,
  MalformedQuestionError,
  parseOpenQuestion,
  renderQuestion,
} from '../truth/questions.js';

describe('evidence grading (PLAN §3.3 rule 1)', () => {
  it('grades a claim by its source, not by what the agent says about itself', () => {
    expect(gradeEvidence(undefined)).toBe('unverified');
    expect(gradeEvidence({ kind: 'cmd_output', ref: 'journal#1', cmd: 'npm test', exit: 0 })).toBe('verified');
    expect(gradeEvidence({ kind: 'cmd_output', ref: 'journal#1', cmd: 'npm test', exit: 1 })).toBe('inferred');
    expect(gradeEvidence({ kind: 'file', ref: 'src/auth.ts:42' })).toBe('verified');
    expect(gradeEvidence({ kind: 'file', ref: 'src/auth.ts' })).toBe('inferred');
    expect(gradeEvidence({ kind: 'url', ref: 'https://example.com/spec' })).toBe('verified');
  });

  it('refuses to let an uncited claim ground further work', () => {
    expect(canGroundWork(makeEvidence('e1', 'auth rejects expired tokens'))).toBe(false);
    expect(
      canGroundWork(
        makeEvidence('e2', 'auth rejects expired tokens', {
          kind: 'cmd_output', ref: 'journal#7', cmd: 'npm test -- auth', exit: 0,
        }),
      ),
    ).toBe(true);
  });

  it('ignores a confidence an agent asserts about its own uncited claim', () => {
    const forged = { id: 'e3', claim: 'the cache is invalidated on write', confidence: 'verified' };
    const graded = makeEvidence(forged.id, forged.claim, undefined);
    expect(graded.confidence).toBe('unverified');
  });
});

describe('claim auditor (PLAN §6 Phase 2 done-criterion)', () => {
  const evidence = [
    makeEvidence('e1', 'auth middleware rejects expired tokens', {
      kind: 'cmd_output', ref: 'journal#142', cmd: 'npm test -- auth', exit: 0,
    }),
    makeEvidence('e2', 'the token expiry check lives in src/auth.ts', {
      kind: 'file', ref: 'src/auth.ts:42',
    }),
  ];

  it('strikes a planted false claim and keeps the supported ones', () => {
    const report = [
      'The auth middleware rejects expired tokens.',
      'The token expiry check lives in src/auth.ts.',
      'We also migrated the billing database to Postgres 16.',
    ].join('\n');

    const result = auditReport(report, evidence);

    expect(result.text).toContain('The auth middleware rejects expired tokens. [verified]');
    expect(result.text).toContain('~~We also migrated the billing database to Postgres 16.~~ [unsupported]');
    expect(result.struckCount).toBe(1);
    expect(survivalRate(result)).toBeCloseTo(2 / 3);
  });

  it('downgrades a claim whose evidence only ran without proving', () => {
    const weak = [
      makeEvidence('e1', 'the suite passes', {
        kind: 'cmd_output', ref: 'journal#9', cmd: 'npm test', exit: 1,
      }),
    ];
    const result = auditReport('The suite passes.', weak);
    expect(result.text).toContain('[assumed]');
    expect(result.struckCount).toBe(0);
  });

  it('treats unverified evidence as no evidence at all', () => {
    const uncited = [makeEvidence('e1', 'the suite passes')];
    const result = auditReport('The suite passes.', uncited);
    expect(result.struckCount).toBe(1);
    expect(result.text).toContain('[unsupported]');
  });

  it('leaves headings and code fences alone', () => {
    const report = ['# Summary', '```', 'npm test', '```'].join('\n');
    const result = auditReport(report, evidence);
    expect(result.text).toBe(report);
    expect(result.claims).toHaveLength(0);
  });

  it('strikes everything when no evidence was ever recorded', () => {
    const result = auditReport('The auth middleware rejects expired tokens.', []);
    expect(result.struckCount).toBe(1);
    expect(survivalRate(result)).toBe(0);
  });
});

describe('OPEN_QUESTION protocol (PLAN §3.3 rules 2 and 5)', () => {
  const good = {
    id: 'q-delete',
    blocking: true,
    question_layman: 'When someone deletes their account, should we erase their data right away?',
    example: 'Today nothing happens on delete — the rows stay forever.',
    proposed_default: '30-day soft delete',
    options: [
      { id: 'hard', label: 'Hard delete now', description: 'Gone within minutes, unrecoverable.' },
      { id: 'soft', label: '30-day soft delete', description: 'Recoverable; needs a purge job.' },
    ],
  };

  it('accepts a question that carries an example and a proposed default', () => {
    const question = parseOpenQuestion(good);
    expect(question.id).toBe('q-delete');
    expect(question.blocking).toBe(true);
    expect(question.example).toContain('Today nothing happens');
    expect(question.options).toHaveLength(2);
  });

  it('rejects an ambiguity dressed up as a question with no example', () => {
    expect(() => parseOpenQuestion({ ...good, example: undefined }))
      .toThrow(MalformedQuestionError);
    expect(() => parseOpenQuestion({ ...good, example: '  ' }))
      .toThrow(/guess in disguise/);
  });

  it('rejects a question with no proposed default', () => {
    expect(() => parseOpenQuestion({ ...good, proposed_default: undefined }))
      .toThrow(/proposed_default/);
  });

  it('rejects a question written in implementation jargon', () => {
    expect(() =>
      parseOpenQuestion({
        ...good,
        question_layman: 'Should the delete path be idempotent across retries?',
      }),
    ).toThrow(/layman/);
  });

  it('renders a question the human can answer without reading the code', () => {
    const rendered = renderQuestion(parseOpenQuestion(good));
    expect(rendered).toContain('Q: When someone deletes their account');
    expect(rendered).toContain('Today nothing happens on delete');
    expect(rendered).toContain('• Hard delete now — Gone within minutes, unrecoverable.');
    expect(rendered).toContain('Proposed default: 30-day soft delete');
  });

  it('batches questions into one screen, blocking first', () => {
    const batched = batchQuestions([
      { id: 'a', blocking: false, questionLayman: 'a' },
      { id: 'b', blocking: true, questionLayman: 'b' },
    ]);
    expect(batched.map((question) => question.id)).toEqual(['b', 'a']);
  });
});

describe('evidence store on the conductor', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'm1m1r-truth-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives resume and audits the report against replayed evidence', async () => {
    const cfg = await loadConfig();
    const first = await Conductor.open(dir, cfg);
    await first.recordEvidence('e1', 'auth middleware rejects expired tokens', {
      kind: 'cmd_output', ref: 'journal#142', cmd: 'npm test -- auth', exit: 0,
    });

    const resumed = await Conductor.open(dir, cfg);
    expect(resumed.state.evidence).toHaveLength(1);
    expect(resumed.state.evidence[0]!.confidence).toBe('verified');

    const result = await resumed.auditAndRecordReport(
      'The auth middleware rejects expired tokens.\nWe also rewrote the payments service.',
    );
    expect(result.struckCount).toBe(1);
    expect(resumed.state.report).toContain('[verified]');
    expect(resumed.state.report).toContain('[unsupported]');
  });
});

describe('Phase 2 roles', () => {
  it.each(['clarifier', 'auditor'])('loads the %s role with the constitution prepended', async (name) => {
    const role = await loadRole(DEFAULT_ROLES_DIR, name);
    expect(role.name).toBe(name);
    expect(role.description).not.toBe('');
    expect(role.systemPrompt).toContain('## Purpose');
  });
});
