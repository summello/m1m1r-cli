// Git worktree manager (PLAN §3.1 "Small blast radius": every mutation
// happens in an isolated git worktree). Ported from claude-squad's
// session/git/{worktree,worktree_ops,worktree_git}.go — same lifecycle
// (create off HEAD with a fresh branch, remove + delete branch on cleanup,
// prune orphans) — see RESEARCH.md `src/exec/` section for the source. This
// is the plain git-CLI wrapper half of that design; claude-squad's tmux
// session management has no analog here (m1m1r agents run in-process).

import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface WorktreeHandle {
  id: string;
  branch: string;
  path: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

export class WorktreeManager {
  constructor(
    private repoRoot: string,
    private worktreesRoot: string,
    private branchPrefix = 'm1m1r/',
  ) {}

  /** Create a fresh worktree off `baseRef` (default HEAD) on a new branch
   * named `<branchPrefix><id>`. Clears any leftover worktree registration
   * and stale same-named branch first — a resumed engagement re-running this
   * phase from scratch (PLAN §6 Phase 0/1's documented resume ceiling: a
   * killed EXECUTE phase restarts, it doesn't resume mid-phase) must be able
   * to recreate the same id's worktree without "already exists" errors.
   *
   * `git worktree remove` only works if git still recognizes the path as a
   * registered worktree — a process killed mid `git worktree add` can leave
   * a directory git *doesn't* recognize yet, which `remove` then fails on
   * (silently, via the caught `.catch`), and `git worktree add` refuses to
   * target a pre-existing non-empty directory regardless. `prune` plus an
   * explicit `rm -rf` of the target path make the directory's actual
   * presence — not git's bookkeeping about it — the thing this method
   * guarantees is clear before `add` runs. */
  async create(id: string, baseRef = 'HEAD'): Promise<WorktreeHandle> {
    const branch = `${this.branchPrefix}${id}`;
    const path = join(this.worktreesRoot, id);
    await git(['worktree', 'remove', '-f', path], this.repoRoot).catch(() => {});
    await git(['worktree', 'prune'], this.repoRoot).catch(() => {});
    await rm(path, { recursive: true, force: true });
    await git(['branch', '-D', branch], this.repoRoot).catch(() => {});
    const baseSha = await git(['rev-parse', baseRef], this.repoRoot);
    await git(['worktree', 'add', '-b', branch, path, baseSha], this.repoRoot);
    return { id, branch, path };
  }

  async isDirty(w: WorktreeHandle): Promise<boolean> {
    const status = await git(['status', '--porcelain'], w.path);
    return status.length > 0;
  }

  /** Stage everything and commit inside the worktree. No-op (returns false)
   * if there's nothing to commit — a task that made no changes shouldn't
   * fail here, that's the integrator's/gate's call to make. */
  async commit(w: WorktreeHandle, message: string): Promise<boolean> {
    if (!(await this.isDirty(w))) return false;
    await git(['add', '-A'], w.path);
    await git(['commit', '-m', message], w.path);
    return true;
  }

  /** Remove the worktree and delete its branch. */
  async cleanup(w: WorktreeHandle): Promise<void> {
    await git(['worktree', 'remove', '-f', w.path], this.repoRoot).catch(() => {});
    await git(['branch', '-D', w.branch], this.repoRoot).catch(() => {});
    await git(['worktree', 'prune'], this.repoRoot).catch(() => {});
  }

  /** Merge a worktree's branch into `targetBranch` (checked out in the main
   * repo, not a worktree — Phase 1 does sequential merges into one
   * integration branch). No auto-conflict-resolution: a conflicting merge is
   * aborted and reported, left for a human or a later phase's smarter
   * integrator — silently picking a side would violate "evidence over
   * assertion." */
  async mergeInto(targetBranch: string, w: WorktreeHandle): Promise<{ ok: boolean; conflict: boolean }> {
    await git(['checkout', targetBranch], this.repoRoot);
    try {
      await git(['merge', '--no-ff', '-m', `merge ${w.branch}`, w.branch], this.repoRoot);
      return { ok: true, conflict: false };
    } catch {
      await git(['merge', '--abort'], this.repoRoot).catch(() => {});
      return { ok: false, conflict: true };
    }
  }
}
