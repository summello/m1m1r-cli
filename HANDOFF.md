# Handoff — after Phase 3

**Status:** Phases 0, 1, 2, 3, 4 shipped on `main` (through commit `8718195`).
Phase 4's UI fixes (Part 1 of this doc, original version) landed via PR #1 and
were spot-checked, not just trusted from commit titles — the resize-listener
fix and alt-screen launch are confirmed in the actual code. Phases 5 and 6
remain.

---

## Part 1 — UI fixes: done

All five issues from the original handoff were addressed and merged
(`43d74dc`…`9681770`, PR #1 `worktree-cockpit-ui-fixes` → `main`):

1. **`MaxListenersExceededWarning`** — fixed correctly, not papered over.
   `src/ui/dimensions.ts` now uses `useSyncExternalStore` over a
   `WeakMap<stream, SizeStore>` with exactly one `stdout.on('resize', ...)`
   per stream regardless of how many components call `useTerminalSize()`.
   Verified by reading the file, not just the commit title.
2. **Wall-of-dashes idle state** — cockpit was rebuilt as a "transcript-first
   layout with a metadata rail" (`dbf6f50`) rather than always rendering the
   full 3-row box.
3. **Logo** — banner wordmark added (`fd240ea`) in place of the noisy
   placeholder art.
4. **Spacing/hierarchy** — panel partitions added (`fd240ea`), status/input
   bar pinned to the bottom (`6582895`).
5. **`/exit` scrollback artifact** — `src/ui/alt-screen.ts` +
   `enterAltScreen()` now wired into `m1m1r.ts`, using a real alternate
   screen buffer instead of leaving frames in scrollback.

**Not yet re-verified live** (worth a real terminal check before calling this
fully closed, the way Phase 4's original build was): items 2–4 above were
confirmed via commit presence and code reading, not by actually launching
the cockpit and looking at it. Do that before moving on if the UI is still a
live concern.

**Still outstanding from PLAN.md's actual Phase 4 scope** (§3.4's semantic
index, `.m1m1rignore`, project memory) — these were explicitly scoped out of
the original Phase 4 build (see prior HANDOFF.md revision / Codex's own
report) and still haven't landed. Either fold them in or formally re-scope
them in `PLAN.md` §6 — the doc and reality still disagree on this point.

---

## Part 2 — What Phase 2 and Phase 3 actually shipped

For context on what's now available to build on:

**Phase 2 (`03c8581`) — Truth layer.** Evidence objects, claim auditor,
`OPEN_QUESTION` protocol. `ConductorState.evidence`/`openQuestions` now
exist; `src/truth/evidence.ts` and `src/truth/auditor.ts` back them.

**Phase 3 (`8718195`) — Gates, hooks, rewind.**
- `src/gates/gates.ts` — four gates (security, review, regression,
  integrate) + a DoD checklist, wired into `team.ts`'s VERIFY/INTEGRATE as
  real exit criteria.
- `src/conductor/hooks.ts` — `HookRunner` for `.m1m1r/hooks/<event>.sh`,
  wired into `conductor.ts`'s phase transitions.
- `src/conductor/rewind.ts` — `listCheckpoints`/`rewindEngagement`, journal-
  sequence-based fork (PLAN §3.1's checkpoint/rewind).
- `src/agents/roles/security-reviewer.md` + `code-reviewer.md` — two more
  roster roles now exist as files (was 2 of 11, now 4 of 11).
- `src/security/redact.ts` — `SECRET_PATTERNS` exported so the security
  gate's scan and the journal scrubber share one definition, can't drift.
- `m1m1r rewind` CLI command, `/rewind` and `/gates` slash commands.
- This commit's own message documents six review-caught bugs already fixed
  before it landed (claim-text hardcoding, rewind seq desync, missing gate
  evidence, hook-firing-on-fail, a stale comment, a diff-parsing edge case)
  — the review-before-commit discipline held for this phase too.

I rebased this onto the post-Phase-2/UI-fixes `main` and re-verified before
pushing: `npm run typecheck` clean, `npm run build` clean, full suite
130/131 (one `ui.test.tsx` keyboard-selection test failed once under full-
suite load, passed in isolation and on a clean re-run — looks like
ink-testing-library timing flakiness, not a real regression; worth watching
if it recurs, not yet worth chasing).

Also added `.claude/worktrees/` to `.gitignore` — an embedded worktree
directory was getting accidentally tracked as a gitlink across a rebase.

---

## Part 3 — Remaining roadmap (`PLAN.md` §6)

### Phase 5 — Ops seats
`devops` + `saas-ops` roles wired to real MCP servers (AWS, Cloudflare):
staging deploys, CI repair, incident runbooks, rollback drills. Read-only
MCP servers opened to any role, not just gated ops roles (§3.4's MCP split).
*Done when:* "ship feature X to staging including its infra change"
completes end-to-end with approvals and a rollback plan; a `researcher`
pulls live context from a read-only MCP server without an elevated-permission
prompt.

Neither `devops` nor `saas-ops` role files exist yet.

### Phase 6 — Independent verification + detached execution
`pr-watcher` role (§3.2) wired to the git host's PR/commit webhook,
cross-provider by default; `--background` execution mode (§3.1) with push
notification on approval-needed/completion.
*Done when:* a `pr-watcher` run on a different provider than the one that
authored a diff flags a real defect the authoring engagement's own
`code-reviewer` passed; a `--background` engagement survives the terminal
closing and notifies on the next blocking question.

`pr-watcher` role file doesn't exist yet either.

### Cross-cutting gaps not tied to one phase
- **7 of 11 roster roles still don't exist** as `agents/roles/*.md` files —
  `clarifier`, `auditor`, `devops`, `saas-ops`, `pr-watcher` are the
  remaining gap (`planner`/`implementer` from Phase 1, `security-reviewer`/
  `code-reviewer` from Phase 3 now exist). `registry.ts` is generic over any
  role name, so each remaining one is authoring a file, not touching code.
- **`m1m1r team`'s `integrator` is still pure TypeScript** (worktree merge +
  gates, no LLM judgment) by Phase 1's deliberate scope cut — worth
  revisiting once conflict-resolution *reasoning* (not just detection) is
  needed.
- Every phase so far has shipped with real bugs an independent review caught
  before commit, including this rebase's own predecessor commit. Keep that
  step for Phases 5/6.
