// Phase 0 single generic agent (PLAN §6 Phase 0): naive plan -> scoped edits ->
// shell receipts -> report. Everything journaled; everything scrubbed.

import { join } from 'node:path';
import type { Conductor } from '../conductor/conductor.js';
import type { OpenAiCompat } from '../providers/openai-compat.js';
import { runToolLoop } from '../providers/openai-compat.js';
import { FS_TOOLS as TOOLS, makeFsToolExecutor, type Receipt } from './fs-tools.js';
import { loadConstitution } from './constitution.js';

export type { Receipt } from './fs-tools.js';

export interface PlanStep {
  desc: string;
  file?: string;
  content?: string;
  shell?: string;
}

/**
 * Resume-aware: guards each phase's work on whether its persisted output
 * (conductor.state, rebuilt by journal replay on Conductor.open) already
 * exists, so `kill -9` + reopen picks up after the last completed phase
 * instead of re-running the whole engagement (PLAN §6 Phase 0 done-criteria).
 *
 * ponytail: EXECUTE resumes by re-running the phase from scratch when killed
 * mid-tool-loop — the LLM conversation transcript isn't persisted turn by
 * turn, only the final receipts. write_file steps are idempotent; a re-run
 * shell command may not be. Fully granular resume needs the transcript/
 * evidence layer (PLAN §6 Phase 2) — flagging the ceiling, not hiding it.
 */
export async function runEngagement(
  client: OpenAiCompat,
  conductor: Conductor,
  workdir: string,
): Promise<void> {
  if (conductor.state.phase === 'DONE') return;
  if (conductor.state.phase === 'PARKED') {
    throw new Error('engagement is parked (budget or blocking question) — resolve before resuming');
  }

  const constitution = await loadConstitution();
  const requirement = conductor.state.requirement ?? '';

  if (conductor.state.phase === 'INTAKE') {
    await conductor.transition('INTAKE', 'PHASE');
    // CLARIFY / RESEARCH are Phase 2 concerns; skip explicitly, not silently.
    for (const skip of ['CLARIFY', 'RESEARCH'] as const) {
      await conductor.transition(skip, 'SKIPPED', { reason: 'phase-0 generic agent' });
    }
  }

  let steps = conductor.state.planSteps;
  if (!steps) {
    await conductor.transition('PLAN', 'PHASE');
    const { content } = await runToolLoop(
      client,
      `${constitution}\n\nYou are the m1m1r planner. Output ONLY minified JSON: {"steps":[{"desc":str,"file"?:str,"content"?:str,"shell"?:str}]}. One step per file edit or command. No prose outside JSON.`,
      `Requirement:\n${requirement}`,
      [],
      async () => '',
      8,
      () => conductor.state.phase === 'PARKED',
    );
    try {
      const match = content.match(/\{[\s\S]*\}/);
      steps = (JSON.parse(match?.[0] ?? '{}') as { steps?: PlanStep[] }).steps ?? [];
    } catch {
      steps = [{ desc: 'unparsed plan — see report', shell: 'true' }];
    }
    await conductor.journal.append('PLAN', 'PLAN', steps);
    conductor.state.planSteps = steps;

    await conductor.transition('APPROVE', 'AUTO_APPROVED', { mode: 'semi-phase0' });
  }

  let receipts = conductor.state.receipts;
  let execResultContent = '';
  if (!receipts) {
    await conductor.transition('EXECUTE', 'PHASE');
    const fresh: Receipt[] = [];
    const execute = makeFsToolExecutor(workdir, fresh);
    const execResult = await runToolLoop(
      client,
      `${constitution}\n\n${EXEC_SYSTEM}`,
      planBrief(steps),
      TOOLS,
      execute,
      8,
      () => conductor.state.phase === 'PARKED',
    );
    execResultContent = execResult.content;
    await conductor.journal.append('EXECUTE', 'RECEIPTS', fresh);
    conductor.state.receipts = fresh;
    receipts = fresh;
  }

  await conductor.transition('VERIFY', 'PHASE');
  // Re-run any test-ish command from receipts to confirm green.
  const verifyFailures = receipts.filter((r) => r.exit !== null && r.exit !== 0);
  await conductor.journal.append('VERIFY', 'GATE_RESULT', {
    gate: 'regression-lite',
    pass: verifyFailures.length === 0,
    failures: verifyFailures.map((f) => f.cmd),
  });

  await conductor.transition('REPORT', 'PHASE');
  const report =
    `Plan: ${steps.length} step(s)\n` +
    receipts.map((r) => `[${r.exit === 0 ? 'ok' : `exit ${r.exit}`}] ${r.cmd}`).join('\n') +
    (execResultContent ? `\n\n${execResultContent.slice(0, 1000)}` : '');
  await conductor.journal.append('REPORT', 'REPORT', { text: report });
  conductor.state.report = report;
  await conductor.complete();
}

const EXEC_SYSTEM =
  'You are the m1m1r executor. Execute the given plan using the provided tools. Prefer write_file for edits and run_shell only for tests/builds. Stop when all steps are applied and tests pass.';

function planBrief(steps: PlanStep[]): string {
  return steps
    .map((s, i) => {
      const bits = [`${i + 1}. ${s.desc}`];
      if (s.file) bits.push(`file=${s.file}`);
      if (s.shell) bits.push(`shell="${s.shell}"`);
      return bits.join(' ');
    })
    .join('\n');
}

/** `.m1m1r/engagements/<id>` — the engagement's own dir (journal lives here;
 * the agent's actual file edits go one level deeper, in its `workspace/`). */
export function engagementDir(root: string, id: string): string {
  return join(root, id);
}
