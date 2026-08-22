// Exercises the Phase 0 done-criterion directly (PLAN §6): "kill -9 mid-run,
// `m1m1r resume` completes the engagement; statusline $ matches journal Σ
// within rounding." Simulated by reopening a Conductor on a journal seeded to
// a given point, rather than actually killing a process — same code path
// (Conductor.open's replay), deterministic.

import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runEngagement } from '../agents/generic-agent.js';
import { Conductor, type Config } from '../conductor/conductor.js';
import { OpenAiCompat, type ChatMessage } from '../providers/openai-compat.js';
import { Redactor } from '../security/redact.js';

const MODEL = 'fake-model';
const CFG: Config = {
  budgetSoftWarnUsd: 10,
  budgetHardStopUsd: 25,
  prices: { [MODEL]: { inPerM: 1, outPerM: 1 } },
};

/** Fakes the /chat/completions endpoint. `onCall` inspects the system prompt
 * so tests can assert a phase's LLM call never happened (resume skipped it). */
function fakeClient(onCall: (systemPrompt: string, turn: number) => ChatMessage): OpenAiCompat {
  const calls = new Map<string, number>();
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
    const system = String(body.messages[0]?.content ?? '');
    const key = system.includes('planner') ? 'planner' : 'executor';
    const turn = (calls.get(key) ?? 0) + 1;
    calls.set(key, turn);
    const message = onCall(system, turn);
    return new Response(
      JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 },
    );
  };
  return new OpenAiCompat({
    baseUrl: 'https://fake',
    apiKey: 'test-key',
    model: MODEL,
    redactor: new Redactor(),
    onUsage: () => {},
    fetchImpl,
  });
}

let dir: string;
let workdir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'm1m1r-test-'));
  workdir = join(dir, 'workspace');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resume-aware runEngagement', () => {
  it('runs a fresh engagement end to end and reaches DONE', async () => {
    const client = fakeClient((system, turn) => {
      if (system.includes('planner')) {
        return { role: 'assistant', content: '{"steps":[{"desc":"write hello","file":"hello.txt","content":"hi"}]}' };
      }
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'hi' }) },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'done' };
    });

    const conductor = await Conductor.open(dir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'write hello.txt' });
    conductor.state.requirement = 'write hello.txt';

    await runEngagement(client, conductor, workdir);

    expect(conductor.state.phase).toBe('DONE');
    expect(conductor.state.report).toContain('write hello.txt');
  });

  it('resume skips planning when planSteps already exist in the journal', async () => {
    const conductor = await Conductor.open(dir, CFG);
    // Seed the exact sequence a real run writes before getting killed -9 mid
    // EXECUTE, including the SKIPPED/AUTO_APPROVED events replay() used to
    // drop — a prior version of this test seeded only START/PLAN/AUTO_APPROVED
    // and never checked the resumed phase, so it passed even while replay()
    // silently reset state.phase to INTAKE on those event names.
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'req' });
    await conductor.journal.append('INTAKE', 'PHASE');
    await conductor.journal.append('CLARIFY', 'SKIPPED', { reason: 'phase-0 generic agent' });
    await conductor.journal.append('RESEARCH', 'SKIPPED', { reason: 'phase-0 generic agent' });
    const steps = [{ desc: 'noop', shell: 'true' }];
    await conductor.journal.append('PLAN', 'PLAN', steps);
    await conductor.journal.append('APPROVE', 'AUTO_APPROVED', { mode: 'semi-phase0' });

    const reopened = await Conductor.open(dir, CFG);
    expect(reopened.state.phase).toBe('APPROVE'); // not reset to INTAKE by the SKIPPED events
    expect(reopened.state.planSteps).toEqual(steps);

    const client = fakeClient((system, turn) => {
      if (system.includes('planner')) throw new Error('planner must not run again on resume');
      return { role: 'assistant', content: 'ok' };
    });

    await runEngagement(client, reopened, workdir);
    expect(reopened.state.phase).toBe('DONE');
  });

  it('rejects a write_file path that escapes the workspace (CWE-22)', async () => {
    // "workspace-evil" starts-with "workspace" as a bare string — the exact
    // bypass the old `startsWith(resolve(workdir))` check let through.
    const evilFile = join(dir, 'workspace-evil', 'pwned.txt');
    const client = fakeClient((system, turn) => {
      if (system.includes('planner')) {
        return { role: 'assistant', content: '{"steps":[{"desc":"escape attempt"}]}' };
      }
      if (turn === 1) {
        return {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: '../workspace-evil/pwned.txt', content: 'x' }),
              },
            },
          ],
        };
      }
      return { role: 'assistant', content: 'done' };
    });

    const conductor = await Conductor.open(dir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'try escape' });
    conductor.state.requirement = 'try escape';

    await runEngagement(client, conductor, workdir);

    expect(conductor.state.phase).toBe('DONE');
    // The escape was caught inside execute() before any receipt was pushed
    // (runToolLoop's try/catch turns it into a tool-error message instead),
    // so no receipt is recorded for it at all — and, decisively, the file
    // never landed outside the workspace.
    expect(conductor.state.receipts).toEqual([]);
    await expect(access(evilFile)).rejects.toThrow();
  });

  it('resume is a no-op once the engagement is already DONE', async () => {
    const conductor = await Conductor.open(dir, CFG);
    await conductor.journal.append(conductor.state.phase, 'START', { requirement: 'req' });
    await conductor.journal.append('REPORT', 'REPORT', { text: 'already finished' });
    await conductor.transition('DONE', 'COMPLETE');

    const reopened = await Conductor.open(dir, CFG);
    expect(reopened.state.phase).toBe('DONE');

    const client = fakeClient(() => {
      throw new Error('no LLM call should happen once DONE');
    });

    await runEngagement(client, reopened, workdir);
    expect(reopened.state.report).toBe('already finished');
  });

  it('budget survives resume: governor snapshot equals the journal USAGE sum within rounding', async () => {
    const conductor = await Conductor.open(dir, CFG);
    await conductor.charge({ prompt_tokens: 1000, completion_tokens: 1000 }, MODEL);
    await conductor.charge({ prompt_tokens: 2000, completion_tokens: 2000 }, MODEL);
    const expectedUsd = ((1000 + 1000) * 1 + (2000 + 2000) * 1) / 1e6;

    const reopened = await Conductor.open(dir, CFG);
    expect(reopened.state.budget.spentUsd).toBeCloseTo(expectedUsd, 6);
  });

  it('BUDGET_UPDATE and USAGE events are emitted live to subscribers, not just journaled', async () => {
    const conductor = await Conductor.open(dir, CFG);
    const seen: string[] = [];
    conductor.subscribe((ev) => seen.push(ev.event));
    await conductor.charge({ prompt_tokens: 1000, completion_tokens: 1000 }, MODEL);
    expect(seen).toContain('USAGE');
    expect(seen).toContain('BUDGET_UPDATE');
  });
});
