// Exercises PLAN.md §6 Phase 1's literal done-criterion: "one requirement
// fans out to ≥3 concurrent implementers that merge conflict-free on a demo
// repo — twice: once all-Anthropic, once mixed-provider." Both runs use fake
// AgentRuntime stand-ins (no network) — what's under test is the DAG +
// worktree + merge pipeline actually driving heterogeneous AgentRuntime
// instances correctly, which is provider-agnostic by construction: a real
// AnthropicRuntime/OpenAiCompatRuntime slots into the exact same
// `pickImplementerRuntime` seam these fakes do.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// Fake review client that returns empty findings (passes all gates)
function fakeReviewClient(): OpenAiCompat {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ findings: [] }) } }],
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

const THREE_NODES = {
  nodes: [
    { id: 'n1', scope: ['file-0.txt'], acceptanceCriteria: 'file-0.txt exists', dependsOn: [], input: 'write file-0.txt' },
    { id: 'n2', scope: ['file-1.txt'], acceptanceCriteria: 'file-1.txt exists', dependsOn: [], input: 'write file-1.txt' },
    { id: 'n3', scope: ['file-2.txt'], acceptanceCriteria: 'file-2.txt exists', dependsOn: [], input: 'write file-2.txt' },
  ],
};

function fakePlannerClient(): OpenAiCompat {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(THREE_NODES) } }],
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

/** Stands in for a real provider adapter — writes a marker file so the test
 * can prove the worktree isolation + merge actually carried each
 * implementer's real output through, not just that the pipeline ran. */
class FakeRuntime implements AgentRuntime {
  concurrentNow = 0;
  maxConcurrent = 0;
  calls: string[] = [];
  constructor(private label: string) {}

  async runTask(input: TaskInput): Promise<TaskResult> {
    this.concurrentNow++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrentNow);
    this.calls.push(basename(input.cwd));
    await new Promise((r) => setTimeout(r, 15)); // hold the slot briefly so concurrency is observable
    const id = basename(input.cwd);
    await writeFile(join(input.cwd, `${id}.txt`), `written by ${this.label}\n`);
    this.concurrentNow--;
    return { text: `done by ${this.label}`, receipts: [{ cmd: `write ${id}.txt`, exit: 0, outputRef: 'inline' }], isError: false };
  }
}

let repoRoot: string;
let engDir: string;

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'm1m1r-team-repo-'));
  engDir = await mkdtemp(join(tmpdir(), 'm1m1r-team-eng-'));
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

describe('runTeamEngagement — Phase 1 done-criterion', () => {
  it('all-same-provider: 3 concurrent implementers merge conflict-free', async () => {
    const conductor = await Conductor.open(engDir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'three independent files' });
    conductor.state.requirement = 'three independent files';

    const runtime = new FakeRuntime('anthropic-mock');
    const integrationBranch = 'integration-same';
    await git(['branch', integrationBranch], repoRoot);

    await runTeamEngagement(conductor, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 3,
      pickImplementerRuntime: () => runtime,
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient(),
      integrationBranch,
    });

    expect(conductor.state.phase).toBe('DONE');
    expect(runtime.maxConcurrent).toBeGreaterThan(1); // actually concurrent, not serialized
    expect(runtime.calls.sort()).toEqual(['n1', 'n2', 'n3']);

    await git(['checkout', integrationBranch], repoRoot);
    for (const id of ['n1', 'n2', 'n3']) {
      expect(await readFile(join(repoRoot, `${id}.txt`), 'utf8')).toBe('written by anthropic-mock\n');
    }
  });

it('mixed-provider: implementers split across two different AgentRuntime instances, still merge conflict-free', async () => {
    const conductor = await Conductor.open(engDir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'three independent files' });
    conductor.state.requirement = 'three independent files';

    const anthropicMock = new FakeRuntime('anthropic-mock');
    const openaiMock = new FakeRuntime('openai-compat-mock');
    let i = 0;
    const pick = () => (i++ % 2 === 0 ? anthropicMock : openaiMock);

    const integrationBranch = 'integration-mixed';
    await git(['branch', integrationBranch], repoRoot);

    await runTeamEngagement(conductor, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 3,
      pickImplementerRuntime: pick,
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient(),
      integrationBranch,
    });

    expect(conductor.state.phase).toBe('DONE');
    // Genuinely split across both runtimes, not all routed to one.
    expect(anthropicMock.calls.length).toBeGreaterThan(0);
    expect(openaiMock.calls.length).toBeGreaterThan(0);
    expect(anthropicMock.calls.length + openaiMock.calls.length).toBe(3);

    await git(['checkout', integrationBranch], repoRoot);
    for (const id of ['n1', 'n2', 'n3']) {
      const content = await readFile(join(repoRoot, `${id}.txt`), 'utf8');
      expect(content).toMatch(/^written by (anthropic|openai-compat)-mock\n$/);
    }
  });

  it('resume: re-running after teamNodes/teamResults are journaled does not re-plan or re-execute', async () => {
    const conductor = await Conductor.open(engDir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'req' });
    conductor.state.requirement = 'req';

    const runtime = new FakeRuntime('anthropic-mock');
    const integrationBranch = 'integration-resume';
    await git(['branch', integrationBranch], repoRoot);

    await runTeamEngagement(conductor, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 3,
      pickImplementerRuntime: () => runtime,
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient(),
      integrationBranch,
    });
    expect(runtime.calls.length).toBe(3);

    // Reopen fresh (simulates a new process after resume) and re-run.
    const reopened = await Conductor.open(engDir, CFG);
    expect(reopened.state.phase).toBe('DONE');
    await runTeamEngagement(reopened, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 3,
      pickImplementerRuntime: () => {
        throw new Error('should not launch any implementer on a DONE resume');
      },
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient(),
      integrationBranch,
    });
    expect(reopened.state.report).toBe(conductor.state.report);
  });

  it('a budget hard-stop mid-DAG (conductor.state.phase -> PARKED) stops further implementer launches', async () => {
    // Regression test: an independent review found runDag kept launching
    // every already-ready node regardless of the conductor parking mid-run —
    // the hard-stop was cosmetic for any node not already in flight at that
    // instant. concurrency:1 makes this deterministic: n1 parks the
    // conductor as a side effect of "spending," and n2/n3 (both ready with
    // no dependency on n1) must never launch afterward.
    const conductor = await Conductor.open(engDir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'req' });
    conductor.state.requirement = 'req';

    class ParkingRuntime implements AgentRuntime {
      calls: string[] = [];
      async runTask(input: TaskInput): Promise<TaskResult> {
        const id = basename(input.cwd);
        this.calls.push(id);
        if (id === 'n1') await conductor.park('budget hard stop (test)');
        return { text: 'done', receipts: [], isError: false };
      }
    }
    const runtime = new ParkingRuntime();
    const integrationBranch = 'integration-park';
    await git(['branch', integrationBranch], repoRoot);

    await runTeamEngagement(conductor, {
      repoRoot,
      worktreesRoot: join(engDir, 'worktrees'),
      concurrency: 1,
      pickImplementerRuntime: () => runtime,
      plannerClient: fakePlannerClient(),
      reviewClient: fakeReviewClient(),
      integrationBranch,
    });

    expect(runtime.calls).toEqual(['n1']); // n2/n3 never launched
    expect(conductor.state.phase).toBe('PARKED');
  });
});
