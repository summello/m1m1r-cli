import { describe, expect, it } from 'vitest';
import { TaskDag, runDag, type TaskNode } from '../conductor/dag.js';

function node(id: string, dependsOn: string[] = []): TaskNode {
  return { id, role: 'implementer', scope: [id], acceptanceCriteria: '', dependsOn, input: id };
}

describe('TaskDag', () => {
  it('detects a dependency cycle', () => {
    expect(() => new TaskDag([node('a', ['b']), node('b', ['a'])])).toThrow(/cycle/);
  });

  it('rejects a dependency on an unknown task', () => {
    expect(() => new TaskDag([node('a', ['ghost'])])).toThrow(/unknown task/);
  });

  it('rejects duplicate task ids', () => {
    expect(() => new TaskDag([node('a'), node('a')])).toThrow(/duplicate/);
  });

  it('nodes with no dependencies are ready immediately; dependents unblock only after markDone', () => {
    const dag = new TaskDag([node('a'), node('b', ['a'])]);
    expect(dag.ready().map((n) => n.id)).toEqual(['a']);
    dag.markStarted('a');
    expect(dag.ready()).toEqual([]); // in-flight, not re-offered
    dag.markDone('a');
    expect(dag.ready().map((n) => n.id)).toEqual(['b']);
  });
});

describe('runDag', () => {
  it('runs independent nodes concurrently up to the concurrency cap', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const dag = new TaskDag([node('a'), node('b'), node('c')]);
    const results = await runDag(
      dag,
      async (n) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return { id: n.id, ok: true, text: 'done' };
      },
      3,
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxConcurrent).toBeGreaterThan(1); // actually ran in parallel, not serially
  });

  it('respects dependency ordering: a dependent never starts before its dependency finishes', async () => {
    const order: string[] = [];
    const dag = new TaskDag([node('a'), node('b', ['a'])]);
    await runDag(
      dag,
      async (n) => {
        order.push(`start:${n.id}`);
        await new Promise((r) => setTimeout(r, n.id === 'a' ? 10 : 0));
        order.push(`end:${n.id}`);
        return { id: n.id, ok: true, text: '' };
      },
      3,
    );
    expect(order.indexOf('end:a')).toBeLessThan(order.indexOf('start:b'));
  });

  it('a failing node is recorded as failed; independent branches still complete', async () => {
    const dag = new TaskDag([node('a'), node('b')]);
    const results = await runDag(
      dag,
      async (n) => {
        if (n.id === 'a') throw new Error('boom');
        return { id: n.id, ok: true, text: 'fine' };
      },
      3,
    );
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.a?.ok).toBe(false);
    expect(byId.a?.text).toContain('boom');
    expect(byId.b?.ok).toBe(true);
    expect(dag.isComplete).toBe(true);
  });

  it("a dependent of a failed node never runs — it's still marked done by the caller checking isComplete", async () => {
    const ran: string[] = [];
    const dag = new TaskDag([node('a'), node('b', ['a'])]);
    const results = await runDag(
      dag,
      async (n) => {
        ran.push(n.id);
        if (n.id === 'a') throw new Error('boom');
        return { id: n.id, ok: true, text: '' };
      },
      3,
    );
    expect(ran).toEqual(['a']); // b never ran, its dependency never unblocked it
    expect(results.map((r) => r.id)).toEqual(['a']);
    expect(dag.isComplete).toBe(false); // caller can detect the stuck dependent
  });
});
