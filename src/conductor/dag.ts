// Task DAG scheduler (PLAN §3.1 "Task DAG"). A small, self-contained
// dependency graph + concurrent ready-queue runner — the shape RESEARCH.md
// found worth building fresh rather than porting: ruflo's task-orchestrator.ts
// is the same idea (Maps + cycle detection + unblock-on-complete) but lives
// inside a swarm/consensus module we don't want; this is the same pattern
// with none of that baggage.

export interface TaskNode {
  id: string;
  role: string;
  /** Path prefixes this task may touch — the planner's conflict-avoidance
   * signal; the DAG scheduler itself doesn't enforce it (the worktree
   * manager gives each node its own branch, so overlapping scope is a merge
   * concern for the integrator, not a scheduling concern here). */
  scope: string[];
  acceptanceCriteria: string;
  dependsOn: string[];
  /** Role-specific input (e.g. the implementer's task brief). */
  input: string;
}

export interface TaskResult {
  id: string;
  ok: boolean;
  text: string;
}

/** Pure graph bookkeeping — no execution, no concurrency. Kept separate from
 * runDag() so the graph logic (cycle detection, unblock-on-complete) is
 * testable without mocking a runner. */
export class TaskDag {
  private nodes = new Map<string, TaskNode>();
  private remaining = new Map<string, Set<string>>();
  private dependents = new Map<string, Set<string>>();
  /** Nodes that have finished running, success or failure — excluded from
   * ready()/isComplete regardless of outcome. */
  private settled = new Set<string>();
  private inFlight = new Set<string>();

  constructor(nodes: TaskNode[]) {
    for (const n of nodes) {
      if (this.nodes.has(n.id)) throw new Error(`duplicate task id: ${n.id}`);
      this.nodes.set(n.id, n);
      this.dependents.set(n.id, new Set());
    }
    for (const n of nodes) {
      for (const dep of n.dependsOn) {
        if (!this.nodes.has(dep)) throw new Error(`task ${n.id} depends on unknown task ${dep}`);
      }
    }
    this.checkAcyclic();
    for (const n of nodes) {
      this.remaining.set(n.id, new Set(n.dependsOn));
      for (const dep of n.dependsOn) this.dependents.get(dep)!.add(n.id);
    }
  }

  private checkAcyclic(): void {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<string, number>();
    const visit = (id: string, path: string[]): void => {
      color.set(id, GRAY);
      for (const dep of this.nodes.get(id)!.dependsOn) {
        const c = color.get(dep) ?? WHITE;
        if (c === GRAY) throw new Error(`dependency cycle: ${[...path, id, dep].join(' -> ')}`);
        if (c === WHITE) visit(dep, [...path, id]);
      }
      color.set(id, BLACK);
    };
    for (const id of this.nodes.keys()) {
      if ((color.get(id) ?? WHITE) === WHITE) visit(id, []);
    }
  }

  get size(): number {
    return this.nodes.size;
  }

  get isComplete(): boolean {
    return this.settled.size === this.nodes.size;
  }

  /** Nodes with no unmet dependencies, not already running or settled. */
  ready(): TaskNode[] {
    return [...this.nodes.values()].filter(
      (n) => !this.settled.has(n.id) && !this.inFlight.has(n.id) && this.remaining.get(n.id)!.size === 0,
    );
  }

  markStarted(id: string): void {
    this.inFlight.add(id);
  }

  /** Marks a node successfully done and unblocks any dependents whose last
   * unmet dep this was. */
  markDone(id: string): void {
    this.inFlight.delete(id);
    this.settled.add(id);
    for (const dependent of this.dependents.get(id) ?? []) {
      this.remaining.get(dependent)!.delete(id);
    }
  }

  /** Marks a node failed — settled (won't be re-offered by ready()), but
   * deliberately does NOT clear it from dependents' remaining-deps: a
   * dependent should never start work built on a failed prerequisite.
   * Those dependents stay permanently blocked, which is why isComplete can
   * legitimately stay false even after every launchable node has settled —
   * that's the signal a caller uses to detect a stuck subgraph. */
  markFailed(id: string): void {
    this.inFlight.delete(id);
    this.settled.add(id);
  }
}

/** Runs a TaskDag to completion, launching all ready nodes concurrently up
 * to `concurrency`. A node that throws is recorded as a failed result via
 * markFailed — independent branches of the graph keep progressing; only
 * nodes that depend on the failure stay blocked forever, surfaced by the
 * caller checking `dag.isComplete` after this resolves.
 *
 * `shouldStop` is checked before launching each new batch — same pattern as
 * runToolLoop's per-turn check (providers/openai-compat.ts) — so a budget
 * hard-stop (conductor.state.phase becoming 'PARKED') stops new implementer
 * spend immediately rather than letting every already-ready node in the
 * graph launch regardless. Already-running nodes are allowed to finish
 * (matches runToolLoop: a turn already in flight isn't aborted mid-call);
 * only *new* launches are gated. */
export async function runDag(
  dag: TaskDag,
  runNode: (node: TaskNode) => Promise<TaskResult>,
  concurrency: number,
  shouldStop?: () => boolean,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  const running = new Map<string, Promise<void>>();

  const launch = (node: TaskNode): void => {
    dag.markStarted(node.id);
    const p = runNode(node).then(
      (result) => {
        results.push(result);
        dag.markDone(node.id);
        running.delete(node.id);
      },
      (e: unknown) => {
        results.push({ id: node.id, ok: false, text: e instanceof Error ? e.message : String(e) });
        dag.markFailed(node.id);
        running.delete(node.id);
      },
    );
    running.set(node.id, p);
  };

  while (!dag.isComplete) {
    if (!shouldStop?.()) {
      const ready = dag.ready();
      for (const node of ready) {
        if (running.size >= concurrency) break;
        launch(node);
      }
    }
    if (running.size === 0) {
      // Nothing running and either nothing left ready, or shouldStop fired —
      // a failed node's dependents can never unblock, and a stopped run
      // isn't going to start anything new either way. Stop here rather than
      // spin forever.
      break;
    }
    await Promise.race(running.values());
  }
  return results;
}
