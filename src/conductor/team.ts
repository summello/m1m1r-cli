// Team engagement (PLAN §6 Phase 1 done-criterion: "one requirement fans
// out to ≥3 concurrent implementers that merge conflict-free on a demo
// repo"). planner -> task DAG -> N implementers in parallel worktrees ->
// sequential merge into an integration branch -> optional test run -> report.
//
// Resume-aware the same coarse way as Phase 0's generic-agent.ts: each
// major step is guarded on whether its persisted output already exists.
// ponytail: EXECUTE resumes by re-running the whole DAG from scratch, same
// documented ceiling as Phase 0 — worktree creation is now idempotent-safe
// (WorktreeManager.create) so this is safe, just possibly redundant work.

import { mkdir } from 'node:fs/promises';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { runToolLoop, type OpenAiCompat } from '../providers/openai-compat.js';
import { WorktreeManager, type WorktreeHandle } from '../exec/worktree.js';
import { TaskDag, runDag, type TaskNode as DagNode } from './dag.js';
import type { Conductor, PlannedTeamNode } from './conductor.js';
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
  integrationBranch: string;
  testCommand?: string;
  runTestCommand?: (cwd: string, cmd: string) => Promise<{ ok: boolean; output: string }>;
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
    await conductor.journal.append('PLAN', 'TEAM_PLAN', nodes);
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
      const handle = await wm.create(dagNode.id);
      handles.set(dagNode.id, handle);
      const runtime = opts.pickImplementerRuntime(planned, [...handles.keys()].indexOf(dagNode.id));
      const result = await runtime.runTask({
        systemPrompt: implementerRole.systemPrompt,
        userPrompt: `Task: ${dagNode.input}\nScope: ${dagNode.scope.join(', ')}\nAcceptance criteria: ${dagNode.acceptanceCriteria}`,
        cwd: handle.path,
      });
      if (!result.isError) await wm.commit(handle, `implement ${dagNode.id}`);
      return { id: dagNode.id, ok: !result.isError, text: result.text };
    };

    results = await runDag(dag, runNode, opts.concurrency);
    await conductor.journal.append('EXECUTE', 'TEAM_RESULTS', results);
    conductor.state.teamResults = results;
  } else {
    // Resumed past EXECUTE — worktrees from that run are gone (or were never
    // recreated this process); re-derive handles for INTEGRATE below from
    // the ids we know succeeded, since mergeInto only needs id -> branch/path,
    // both deterministic from the WorktreeManager's naming scheme.
    for (const n of nodes) handles.set(n.id, { id: n.id, branch: `m1m1r/${n.id}`, path: `${opts.worktreesRoot}/${n.id}` });
  }

  await conductor.transition('VERIFY', 'PHASE');
  const failed = results.filter((r) => !r.ok);
  await conductor.journal.append('VERIFY', 'GATE_RESULT', {
    gate: 'team-regression-lite',
    pass: failed.length === 0,
    failures: failed.map((f) => f.id),
  });

  await conductor.transition('INTEGRATE', 'PHASE');
  const merges: Array<{ id: string; ok: boolean; conflict: boolean }> = [];
  for (const r of results) {
    if (!r.ok) continue;
    const handle = handles.get(r.id);
    if (!handle) continue;
    const merge = await wm.mergeInto(opts.integrationBranch, handle);
    merges.push({ id: r.id, ...merge });
    await wm.cleanup(handle);
  }
  let testOutput = '';
  if (opts.testCommand && opts.runTestCommand) {
    const test = await opts.runTestCommand(opts.repoRoot, opts.testCommand);
    testOutput = `\n\n${opts.testCommand}: ${test.ok ? 'PASS' : 'FAIL'}\n${test.output.slice(0, 1000)}`;
  }
  await conductor.journal.append('INTEGRATE', 'MERGE_RESULTS', merges);

  await conductor.transition('REPORT', 'PHASE');
  const report =
    `Fan-out: ${nodes.length} node(s), ${failed.length} failed\n` +
    results.map((r) => `[${r.ok ? 'ok' : 'FAIL'}] ${r.id}`).join('\n') +
    `\n\nMerges into ${opts.integrationBranch}:\n` +
    merges.map((m) => `[${m.ok ? 'merged' : m.conflict ? 'CONFLICT' : 'skipped'}] ${m.id}`).join('\n') +
    testOutput;
  await conductor.journal.append('REPORT', 'REPORT', { text: report });
  conductor.state.report = report;
  await conductor.complete();
}
