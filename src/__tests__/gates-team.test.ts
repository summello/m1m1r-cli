// Gates-in-team e2e test (Phase 3 done-criteria):
// 1. A failing-security diff is blocked with findings (security gate)
// 2. DoD checklist prints receipts for every line
// 3. A pre-gate project hook can fail a gate that would otherwise pass

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTeamEngagement } from '../conductor/team.js';
import { Conductor, type Config } from '../conductor/conductor.js';
import { OpenAiCompat } from '../providers/openai-compat.js';
import { Redactor } from '../security/redact.js';
import type { AgentRuntime, TaskInput, TaskResult } from '../runtime/agent-runtime.js';

const exec = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

const CFG: Config = { budgetSoftWarnUsd: 10, budgetHardStopUsd: 25, prices: {} };

// 4 nodes: n1 clean, n2 has secret, n3 clean, n4 has dangerous API
const FOUR_NODES = {
  nodes: [
    { id: 'n1', scope: ['file-0.txt'], acceptanceCriteria: 'file-0.txt exists', dependsOn: [], input: 'write file-0.txt' },
    { id: 'n2', scope: ['file-1.txt'], acceptanceCriteria: 'file-1.txt exists', dependsOn: [], input: 'write file-1.txt' },
    { id: 'n3', scope: ['file-2.txt'], acceptanceCriteria: 'file-2.txt exists', dependsOn: [], input: 'write file-2.txt' },
    { id: 'n4', scope: ['file-3.txt'], acceptanceCriteria: 'file-3.txt exists', dependsOn: [], input: 'write file-3.txt' },
  ],
};

function fakePlannerClient(nodes = FOUR_NODES): OpenAiCompat {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(nodes) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  return new OpenAiCompat({
    baseUrl: 'https://fake',
    apiKey: 'k',
    model: 'planner-model',
    redactor: new Redactor(),
    onUsage: () => {},
    fetchImpl,
  });
}

function fakeReviewClient(findings: string = '[]'): OpenAiCompat {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ findings: JSON.parse(findings) }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    );
  return new OpenAiCompat({
    baseUrl: 'https://fake',
    apiKey: 'k',
    model: 'review-model',
    redactor: new Redactor(),
    onUsage: () => {},
    fetchImpl,
  });
}

class FakeRuntime implements AgentRuntime {
  concurrentNow = 0;
  maxConcurrent = 0;
  calls: string[] = [];
  constructor(private label: string, private secretToPlant?: string) {}

  async runTask(input: TaskInput): Promise<TaskResult> {
    this.concurrentNow++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrentNow);
    this.calls.push(basename(input.cwd));
    await new Promise((r) => setTimeout(r, 15));
    const id = basename(input.cwd);
    const content = this.secretToPlant && id === 'n2'
      ? `const secret = '${this.secretToPlant}'\n`
      : this.secretToPlant && id === 'n4'
        ? `eval('x')\n`
        : `written by ${this.label}\n`;
    await writeFile(join(input.cwd, `${id}.txt`), content);
    this.concurrentNow--;
    return { text: `done by ${this.label}`, receipts: [{ cmd: `write ${id}.txt`, exit: 0, outputRef: 'inline' }], isError: false };
  }
}

let repoRoot: string;
let engDir: string;
let hooksDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'm1m1r-gates-team-repo-'));
  engDir = await mkdtemp(join(tmpdir(), 'm1m1r-gates-team-eng-'));
  hooksDir = join(engDir, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], repoRoot);
  await git(['config', 'user.email', 'test@example.com'], repoRoot);
  await git(['config', 'user.name', 'Test'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'root\n');
  await git(['add', '-A'], repoRoot);
  await git(['commit', '-q', '-m', 'initial'], repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(engDir, { recursive: true, force: true });
});

describe('runTeamEngagement — Phase 3 gates done-criteria', () => {
  it('security gate blocks task with secret; other tasks merge; report has DoD checklist with receipts', async () => {
    const conductor = await Conductor.open(engDir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'four files' });
    conductor.state.requirement = 'four files';

    const runtime = new FakeRuntime('mock', 'sk-secretkey12345678901234567890');
    const integrationBranch = 'integration-gates';
    await git(['branch', integrationBranch], repoRoot);

    await runTeamEngagement(conductor, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 3,
      pickImplementerRuntime: () => runtime,
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient('[]'),
      integrationBranch,
      testCommand: 'echo ok',
      runTestCommand: async () => ({ ok: true, output: 'PASS' }),
    });

    expect(conductor.state.phase).toBe('DONE');
    // n2 blocked by security gate; n4 blocked by dangerous API scan
    const report = conductor.state.report!;
    expect(report).toContain('[BLOCKED] n2');
    expect(report).toContain('[BLOCKED] n4');
    expect(report).toContain('[ok] n1');
    expect(report).toContain('[ok] n3');

    // DoD checklist present with receipts
    expect(report).toContain('Definition of Done:');
    expect(report).toContain('[PASS] security:n1');
    expect(report).toContain('[FAIL] security:n2');
    expect(report).toContain('receipts: journal#');
    // n2 not in integration branch
    await git(['checkout', integrationBranch], repoRoot);
    expect(await readFile(join(repoRoot, 'n1.txt'), 'utf8')).toBe('written by mock\n');
    expect(await readFile(join(repoRoot, 'n3.txt'), 'utf8')).toBe('written by mock\n');
    // n2 and n4 should not exist
    await expect(readFile(join(repoRoot, 'n2.txt'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(repoRoot, 'n4.txt'), 'utf8')).rejects.toThrow();
  });

  it('pre-gate hook failure blocks a gate that would otherwise pass', async () => {
    const conductor = await Conductor.open(engDir, CFG, new Redactor(), hooksDir);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'hooks test' });
    conductor.state.requirement = 'hooks test';

// Hook that blocks the security gate
  await writeFile(join(hooksDir, 'pre-gate.sh'), `#!/bin/sh
# Always block for debugging
echo "pre-gate hook called with payload: $M1M1R_PAYLOAD" >&2
exit 1
`);
  await chmod(join(hooksDir, 'pre-gate.sh'), 0o755);

    const runtime = new FakeRuntime('mock');
    const integrationBranch = 'integration-hook';
    await git(['branch', integrationBranch], repoRoot);

await runTeamEngagement(conductor, {
    repoRoot,
    worktreesRoot: join(engDir, 'worktrees'),
    concurrency: 1,
    pickImplementerRuntime: () => runtime,
    plannerClient: fakePlannerClient({ nodes: [{ id: 'n1', scope: ['a.txt'], acceptanceCriteria: 'a.txt', dependsOn: [], input: 'write a' }] }),
    reviewClient: fakeReviewClient('[]'),
    integrationBranch,
  });

  expect(conductor.state.phase).toBe('PARKED');
  // When parked, no report is generated; the journal has the gate failure
  const events = conductor.journal.eventsAll;
  const securityGate = events.find((e) => e.event === 'GATE_RESULT' && (e.payload as any).gate === 'security');
  expect(securityGate).toBeDefined();
  expect((securityGate?.payload as any).pass).toBe(false);
  expect((securityGate?.payload as any).findings.some((f: any) => f.origin === 'hook')).toBe(true);
});
});