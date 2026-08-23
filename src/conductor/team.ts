// Team engagement (PLAN §6 Phase 1 done-criterion: "one requirement fans
// out to ≥3 concurrent implementers that merge conflict-free on a demo
// repo"). planner -> task DAG -> N implementers in parallel worktrees ->
// quality gates -> sequential merge into an integration branch -> suite ->
// DoD checklist -> report.
//
// Phase 3 wires the four §3.5 gates in as VERIFY/INTEGRATE exit criteria:
//   VERIFY    security + review per task diff (a failing-security diff never
//             reaches the integration branch), then the receipts-based
//             regression gate over survivors' captured TEST_RECEIPTs
//   INTEGRATE merges, then the integrate gate (post-merge suite, ×3 flake
//             discrimination)
// An engagement-level gate failure parks the run (resumable; already-passed
// gates are skipped on resume via their journaled verdicts). Task-level
// blocks exclude just that task and surface as findings.
//
// Resume-aware the same coarse way as Phase 0's generic-agent.ts: each
// major step is guarded on whether its persisted output already exists.
// ponytail: EXECUTE resumes by re-running the whole DAG from scratch, same
// documented ceiling as Phase 0 — worktree creation is now idempotent-safe
// (WorktreeManager.create) so this is safe, just possibly redundant work.

import { mkdir } from 'node:fs/promises';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { OpenAiCompat } from '../providers/openai-compat.js';
import { runToolLoop } from '../providers/openai-compat.js';
import type { JournalEvent } from './conductor.js';
import { WorktreeManager, type WorktreeHandle } from '../exec/worktree.js';
import { TaskDag, runDag, type TaskNode as DagNode } from './dag.js';
import type { Conductor, PlannedTeamNode } from './conductor.js';
import {
  alreadyPassed,
  blockedTaskIds,
  dodChecklist,
  gatesFromJournal,
  runIntegrateGate,
  runRegressionGate,
  runReviewGate,
  runSecurityGate,
} from '../gates/gates.js';
import { loadRole, DEFAULT_ROLES_DIR } from '../agents/registry.js';

export interface TeamOptions {
  repoRoot: string;
  worktreesRoot: string;
  concurrency: number;
  /** Round-robin (or any other split) across providers — this is what makes
   * "mixed-provider" a real capability of the DAG runner, not just two
   * separate same-provider test runs. */
  pickImplementerRuntime: (node: PlannedTeamNode, index: number) => AgentRuntime;
  /** Used only for the planner's single call — a raw OpenAiCompat client,
   * since the planner just needs one JSON-producing turn, not a tool loop
   * with file/shell access. */
  plannerClient: OpenAiCompat;
  /** Single-turn JSON clients for the security-reviewer and code-reviewer
   * gates — same shape as plannerClient (diff goes in findings JSON comes
   * back; no tools offered, so read-only by construction). */
  reviewClient: OpenAiCompat;
  integrationBranch: string;
  testCommand?: string;
  runTestCommand?: (cwd: string, cmd: string) => Promise<{ ok: boolean; output: string }>;
}

/** Task ids any task-level gate rejected — excluded from the merge. Derived
 * from the journal (not from in-memory result flags) so a resumed process
 * sees exactly what the first process saw. */
function gateBlocked(events: readonly JournalEvent[]): Set<string> {
  return blockedTaskIds(events);
}

export async function runTeamEngagement(conductor: Conductor, opts: TeamOptions): Promise<void> {
  if (conductor.state.phase === 'DONE') return;
  if (conductor.state.phase === 'PARKED') {
    throw new Error('engagement is parked (budget or blocking question) — resolve before resuming');
  }

  const requirement = conductor.state.requirement ?? '';

  if (conductor.state.phase === 'INTAKE') {
    await conductor.transition('INTAKE', 'PHASE');
    for (const skip of ['CLARIFY', 'RESEARCH'] as const) {
      await conductor.transition(skip, 'SKIPPED', { reason: 'phase-1 team engagement' });
    }
  }

  let nodes = conductor.state.teamNodes;
  if (!nodes) {
    await conductor.transition('PLAN', 'PHASE');
    const plannerRole = await loadRole(DEFAULT_ROLES_DIR, 'planner');
    const { content } = await runToolLoop(
      opts.plannerClient,
      plannerRole.systemPrompt,
      `Requirement:\n${requirement}`,
      [],
      async () => '',
      8,
      () => conductor.state.phase === 'PARKED',
    );
    try {
      const match = content.match(/\{[\s\S]*\}/);
      nodes = (JSON.parse(match?.[0] ?? '{}') as { nodes?: PlannedTeamNode[] }).nodes ?? [];
    } catch {
      nodes = [];
    }
    if (nodes.length === 0) {
      throw new Error('planner produced no task nodes — nothing to fan out');
    }
    await conductor.record('TEAM_PLAN', nodes, 'PLAN');
    conductor.state.teamNodes = nodes;
    await conductor.transition('APPROVE', 'AUTO_APPROVED', { mode: 'semi-phase1' });
  }

  let results = conductor.state.teamResults;
  const wm = new WorktreeManager(opts.repoRoot, opts.worktreesRoot);
  const handles = new Map<string, WorktreeHandle>();
  if (!results) {
    await conductor.transition('EXECUTE', 'PHASE');
    await mkdir(opts.worktreesRoot, { recursive: true });
    const implementerRole = await loadRole(DEFAULT_ROLES_DIR, 'implementer');

    const dagNodes: DagNode[] = nodes.map((n) => ({
      id: n.id,
      role: 'implementer',
      scope: n.scope,
      acceptanceCriteria: n.acceptanceCriteria,
      dependsOn: n.dependsOn,
      input: n.input,
    }));
    const dag = new TaskDag(dagNodes);

    const runNode = async (dagNode: DagNode) => {
      const planned = nodes!.find((n) => n.id === dagNode.id)!;
      await conductor.waitWhilePaused();
      await conductor.record('AGENT_STARTED', {
        id: dagNode.id,
        role: dagNode.role,
        task: dagNode.input,
      });
      const handle = await wm.create(dagNode.id);
      handles.set(dagNode.id, handle);
      const runtime = opts.pickImplementerRuntime(planned, [...handles.keys()].indexOf(dagNode.id));
      try {
        const result = await runtime.runTask({
          systemPrompt: implementerRole.systemPrompt,
          userPrompt: `Task: ${conductor.taskInput(dagNode.id, dagNode.input)}\nScope: ${dagNode.scope.join(', ')}\nAcceptance criteria: ${dagNode.acceptanceCriteria}`,
          cwd: handle.path,
        });
        for (const stat of await wm.diffStat(handle)) {
          await conductor.record('DIFF_RECEIPT', { taskId: dagNode.id, ...stat });
        }
        for (const receipt of result.receipts) {
          await conductor.record('TEST_RECEIPT', { taskId: dagNode.id, ...receipt });
        }
        if (!result.isError) await wm.commit(handle, `implement ${dagNode.id}`);
        await conductor.record('AGENT_FINISHED', {
          id: dagNode.id,
          role: dagNode.role,
          ok: !result.isError,
        });
        return { id: dagNode.id, ok: !result.isError, text: result.text };
      } catch (error: unknown) {
        await conductor.record('AGENT_FINISHED', {
          id: dagNode.id,
          role: dagNode.role,
          ok: false,
        });
        throw error;
      }
    };

    results = await runDag(dag, runNode, opts.concurrency, () => conductor.state.phase === 'PARKED');
    await conductor.record('TEAM_RESULTS', results, 'EXECUTE');
    conductor.state.teamResults = results;
  } else {
    // Resumed past EXECUTE — worktrees from that run are gone (or were never
    // recreated this process); re-derive handles for INTEGRATE below from
    // the ids we know succeeded, since mergeInto only needs id -> branch/path,
    // both deterministic from the WorktreeManager's naming scheme.
    for (const n of nodes) handles.set(n.id, { id: n.id, branch: `m1m1r/${n.id}`, path: `${opts.worktreesRoot}/${n.id}` });
  }

  if (conductor.state.paused) return; // budget hard-stop mid-DAG: park cleanly, resume re-enters here

  await conductor.transition('VERIFY', 'PHASE');
  const events = conductor.journal.eventsAll;
  const blocked = gateBlocked(events);
  const shouldStop = () => conductor.state.phase === 'PARKED';
  const survivors = results.filter((r) => r.ok && !blocked.has(r.id));
  if (survivors.length === 0) {
    await conductor.park('all implementer tasks failed or were gate-blocked');
    return;
  }
  const [securityRole, reviewRole] = await Promise.all([
    loadRole(DEFAULT_ROLES_DIR, 'security-reviewer'),
    loadRole(DEFAULT_ROLES_DIR, 'code-reviewer'),
  ]);

  // Task-level gates over each surviving implementer's diff. A task blocked
  // here never reaches the integration branch (done-criterion: "a
  // failing-security diff is blocked with findings"); the others proceed.
  for (const r of results) {
    if (!r.ok || blocked.has(r.id)) continue;
    const handle = handles.get(r.id);
    if (!handle) continue;

    if (!alreadyPassed(events, 'security', r.id)) {
      const verdict = await runSecurityGate(conductor, {
        taskId: r.id,
        diffText: await wm.diff(handle),
        reviewerSystemPrompt: securityRole.systemPrompt,
        reviewClient: opts.reviewClient,
        shouldStop,
      });
      if (!verdict.pass) {
        blocked.add(r.id);
        continue;
      }
    }

    if (!alreadyPassed(events, 'review', r.id)) {
      const planned = nodes.find((n) => n.id === r.id);
      const verdict = await runReviewGate(conductor, {
        taskId: r.id,
        diffText: await wm.diff(handle),
        acceptanceCriteria: planned?.acceptanceCriteria ?? '',
        reviewerSystemPrompt: reviewRole.systemPrompt,
        reviewClient: opts.reviewClient,
        shouldStop,
      });
      if (!verdict.pass) blocked.add(r.id);
    }
  }

  // Regression gate: receipts-based over the tasks still merging.
  if (!alreadyPassed(events, 'regression')) {
    const mergingIds = new Set(results.filter((r) => r.ok && !blocked.has(r.id)).map((r) => r.id));
    const receipts = events.flatMap((ev) => {
      if (ev.event !== 'TEST_RECEIPT') return [];
      const p = ev.payload as { taskId?: string; cmd?: string; exit?: number | null };
      if (!p.cmd || p.taskId?.startsWith('integration-attempt-')) return [];
      return mergingIds.has(p.taskId ?? '') ? [{ taskId: p.taskId!, cmd: p.cmd, exit: p.exit ?? null }] : [];
    });
    const regression = await runRegressionGate(conductor, { receipts });
    if (!regression.pass && !shouldStop()) {
      await conductor.park('gate regression failed — fix or rewind, then resume');
      return;
    }
  }

  if (conductor.state.paused) return;

  await conductor.transition('INTEGRATE', 'PHASE');
  type MergeRow = { id: string; ok: boolean; conflict: boolean };
  let merges: MergeRow[] = (
    events.find((ev) => ev.event === 'MERGE_RESULTS')?.payload as MergeRow[] | undefined
  ) ?? [];
  if (merges.length === 0) {
    merges = [];
    for (const r of results) {
      if (!r.ok || blocked.has(r.id)) continue;
      const handle = handles.get(r.id);
      if (!handle) continue;
      const merge = await wm.mergeInto(opts.integrationBranch, handle);
      merges.push({ id: r.id, ...merge });
      await wm.cleanup(handle);
    }
    await conductor.record('MERGE_RESULTS', merges, 'INTEGRATE');
  }

  if (!alreadyPassed(events, 'integrate')) {
    const integrate = await runIntegrateGate(conductor, {
      repoRoot: opts.repoRoot,
      testCommand: opts.testCommand,
      runTestCommand: opts.runTestCommand,
      merges,
      shouldStop,
    });
    if (!integrate.pass && !shouldStop()) {
      await conductor.park(`gate integrate failed${integrate.flaky ? ' (FLAKY)' : ''} — resume to re-run`);
      return;
    }
  }

  if (conductor.state.paused) return;

  await conductor.transition('REPORT', 'PHASE');
  const failedCount = results.filter((r) => !r.ok).length;
  const report =
    `Fan-out: ${nodes.length} node(s), ${failedCount} failed, ${blocked.size} gate-blocked\n` +
    results.map((r) => `[${r.ok ? (blocked.has(r.id) ? 'BLOCKED' : 'ok') : 'FAIL'}] ${r.id}`).join('\n') +
    `\n\nMerges into ${opts.integrationBranch}:\n` +
    merges.map((m) => `[${m.ok ? 'merged' : m.conflict ? 'CONFLICT' : 'skipped'}] ${m.id}`).join('\n') +
    `\n\n${dodChecklist(gatesFromJournal(conductor.journal.eventsAll))}`;
  await conductor.record('REPORT', { text: report }, 'REPORT');
  conductor.state.report = report;
  await conductor.complete();
}
