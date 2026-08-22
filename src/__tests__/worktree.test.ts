// Real git, no mocks — a temp bare-bones repo per test. This is the
// subsystem the Phase 1 done-criterion depends on most directly (concurrent
// implementer isolation + conflict-free merge), so it's worth exercising
// against actual `git worktree`/`git merge`, not a stub.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from '../exec/worktree.js';

const exec = promisify(execFile);

let repoRoot: string;
let worktreesRoot: string;
let wm: WorktreeManager;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'm1m1r-repo-'));
  worktreesRoot = await mkdtemp(join(tmpdir(), 'm1m1r-worktrees-'));
  await git(['init', '-q', '-b', 'main'], repoRoot);
  await git(['config', 'user.email', 'test@example.com'], repoRoot);
  await git(['config', 'user.name', 'Test'], repoRoot);
  await writeFile(join(repoRoot, 'README.md'), 'root\n');
  await git(['add', '-A'], repoRoot);
  await git(['commit', '-q', '-m', 'initial'], repoRoot);
  wm = new WorktreeManager(repoRoot, worktreesRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
  await rm(worktreesRoot, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('creates an isolated worktree on its own branch off HEAD', async () => {
    const w = await wm.create('task-a');
    expect(w.branch).toBe('m1m1r/task-a');
    await writeFile(join(w.path, 'a.txt'), 'from task a\n');
    expect(await readFile(join(w.path, 'a.txt'), 'utf8')).toBe('from task a\n');
    // Untouched in the main repo — genuine isolation, not a shared dir.
    await expect(readFile(join(repoRoot, 'a.txt'), 'utf8')).rejects.toThrow();
  });

  it('create() is safely re-runnable when git already cleanly registered the prior worktree', async () => {
    const w1 = await wm.create('task-b');
    await writeFile(join(w1.path, 'partial.txt'), 'x');
    // Simulate resume: create() called again for the same id, no prior cleanup.
    const w2 = await wm.create('task-b');
    expect(w2.path).toBe(w1.path);
    await expect(readFile(join(w2.path, 'partial.txt'), 'utf8')).rejects.toThrow();
  });

  it('create() is safely re-runnable after a TRULY interrupted prior attempt — a stray directory git never registered as a worktree', async () => {
    // This is the actually-risky case: a process killed mid `git worktree
    // add`, before git's own bookkeeping (.git/worktrees/<name>) exists, but
    // after the target directory was created on disk. `git worktree remove`
    // fails on a path git doesn't recognize as a worktree (silently, via the
    // best-effort .catch in create()), and `git worktree add` refuses to
    // target a pre-existing non-empty directory — so unless create() clears
    // the directory itself (not just asking git to), this reproduces the
    // exact "already exists" failure the resume-safety claim is about.
    const strayPath = join(worktreesRoot, 'task-e');
    await mkdir(strayPath, { recursive: true });
    await writeFile(join(strayPath, 'stray.txt'), 'never registered with git');

    const w = await wm.create('task-e');
    expect(w.path).toBe(strayPath);
    await expect(readFile(join(strayPath, 'stray.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(w.path, 'README.md'), 'utf8')).toBe('root\n'); // a real, working worktree
  });

  it('commit() is a no-op on a clean worktree, real on a dirty one', async () => {
    const w = await wm.create('task-c');
    expect(await wm.commit(w, 'nothing to commit')).toBe(false);
    await writeFile(join(w.path, 'c.txt'), 'change\n');
    expect(await wm.commit(w, 'add c.txt')).toBe(true);
    expect(await wm.isDirty(w)).toBe(false);
  });

  it('three concurrent implementers on disjoint files merge conflict-free', async () => {
    const ids = ['impl-1', 'impl-2', 'impl-3'];
    const handles = await Promise.all(ids.map((id) => wm.create(id)));
    await Promise.all(
      handles.map(async (h, i) => {
        await writeFile(join(h.path, `file-${i}.txt`), `from ${h.id}\n`);
        await wm.commit(h, `implement ${h.id}`);
      }),
    );

    await git(['branch', 'integration'], repoRoot);
    for (const h of handles) {
      const result = await wm.mergeInto('integration', h);
      expect(result).toEqual({ ok: true, conflict: false });
    }

    await git(['checkout', 'integration'], repoRoot);
    for (let i = 0; i < 3; i++) {
      expect(await readFile(join(repoRoot, `file-${i}.txt`), 'utf8')).toBe(`from impl-${i + 1}\n`);
    }
  });

  it('a real conflicting merge is detected, aborted, and reported — not silently resolved', async () => {
    const a = await wm.create('conflict-a');
    const b = await wm.create('conflict-b');
    await writeFile(join(a.path, 'shared.txt'), 'version A\n');
    await wm.commit(a, 'a writes shared.txt');
    await writeFile(join(b.path, 'shared.txt'), 'version B\n');
    await wm.commit(b, 'b writes shared.txt');

    await git(['branch', 'integration'], repoRoot);
    const first = await wm.mergeInto('integration', a);
    expect(first).toEqual({ ok: true, conflict: false });
    const second = await wm.mergeInto('integration', b);
    expect(second).toEqual({ ok: false, conflict: true });

    // Aborted cleanly — no lingering conflict markers, repo left in a sane state.
    const status = await git(['status', '--porcelain'], repoRoot);
    expect(status).toBe('');
    expect(await readFile(join(repoRoot, 'shared.txt'), 'utf8')).toBe('version A\n');
  });

  it('cleanup removes the worktree and its branch', async () => {
    const w = await wm.create('task-d');
    await wm.cleanup(w);
    await expect(readFile(join(w.path, 'README.md'), 'utf8')).rejects.toThrow();
    const branches = await git(['branch', '--list', w.branch], repoRoot);
    expect(branches).toBe('');
  });
});
