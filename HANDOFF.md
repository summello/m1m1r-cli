# Handoff — after Phase 4

**Status:** Phases 0, 1, 4 shipped on `main` (commits `98a0339`, `867af66`, `7cda35c`).
Phase 4 is functionally complete per its own done-criteria (steer a running
engagement, statusline reflects a transition within 1s, reflows at 60/80/120
cols, renders mono under `NO_COLOR`) but **incomplete against PLAN.md §6's full
Phase 4 scope** — see the first item below before calling Phase 4 closed.

This doc has two parts: **UI fixes** (the cockpit looks bad right now, fix
before anything else — a broken-looking front door undermines confidence in
everything behind it) and **phase roadmap** (what's next per `PLAN.md` §6).

---

## Part 1 — UI fixes (do these first)

Screenshot reference: idle cockpit (`node dist/bin/m1m1r.js`, no active
engagement) showed a `MaxListenersExceededWarning` above the UI, every data
row rendered as a wall of `—`, a cramped/noisy logo, zero spacing between
panels, and raw shell text bleeding in below the box after `/exit`. Concrete
fixes, in priority order:

### 1. `MaxListenersExceededWarning` — real bug, not cosmetic

`src/ui/dimensions.ts:19` — `useTerminalSize()` calls `stdout.on('resize',
resize)` **per component instance**. Every leaf component that needs the
terminal width (`GalaxyLogo`, `StatusLine`, `WelcomePanel`, etc. — 11 in the
screenshot) mounts its own independent listener on the same shared
`process.stdout`, blowing past Node's default max of 10. Cleanup is correct
(`stdout.off` on unmount, `dimensions.ts:22`) — the problem is concurrent
listener *count*, not a leak that never unsubscribes.

**Fix:** centralize into one shared subscription. A module-level store (e.g.
`useSyncExternalStore` over a singleton that holds exactly one
`stdout.on('resize', ...)` regardless of how many components read from it)
is the right shape — same pattern `UiStore` already uses for conductor
events. Do not just raise `setMaxListeners()` as the real fix; that hides the
warning without fixing the one-listener-per-component design.

### 2. Idle state is a wall of dashes — looks broken, not "no data yet"

`src/ui/status-line.tsx:56-87` (the ≥110-col `COCKPIT` box) unconditionally
renders all three rows — ENGAGEMENT, SESSION, CONTROL — the moment the
cockpit opens, before any engagement has ever run. Every field falls back to
`—` (`tasksSeen`/`agentsSeen`/`budgetSeen`/`usageSeen` are all false at
launch), so the very first thing a user sees is a box that reads as empty or
malfunctioning, not "nothing has happened yet."

**Fix:** don't render the full 3-row cockpit at idle at all. Show the
welcome panel alone (or welcome panel + a single line: `no active engagement
— run `m1m1r "<requirement>"` or `/plan`) until the first real journal event
arrives for that session. Once an engagement starts, reveal each *row*
progressively based on the `*Seen` flags already in `store.ts` — e.g. don't
print the `SESSION` row header until `budgetSeen || usageSeen` is true, not
just individually blank the fields inside it. The infrastructure for this
already exists (`*Seen` booleans, "never render a fake zero" is already the
stated design principle in `PLAN.md` §3.7.5) — it's applied at the wrong
granularity (field-level dashes) instead of the right one (row/panel-level
reveal).

### 3. Galaxy logo looks like noise, not a galaxy

`src/ui/logo.ts`'s `GALAXY_FULL` art is Phase 0's placeholder — `PLAN.md`
§3.7.2 says outright "Final art tuned in Phase 4; structure fixed here."
Phase 4 wired the existing draft into `galaxy-logo.tsx` (line 19) without
ever redrawing it, so the "final tuning" never happened. It reads as
scattered specks, not a spiral.

**Fix:** this needs an actual design pass on the ASCII art itself (in
`src/ui/logo.ts`'s `GALAXY_FULL` array), not a code change — a real spiral
silhouette with intentional negative space, sized to read at a glance.
Separately, `galaxy-logo.tsx:18` sets `width={terminal.width}` (full
terminal width) when it should be constrained to the welcome panel's left
column width — the logo currently renders left-aligned in a box far wider
than the art itself, which is part of why it looks adrift/off-center.

### 4. Zero breathing room, one color dominates

Panels stack with no margin between them, and nearly everything reads
magenta/pink (the `nebula` token is used for phase text, borders, and bold
headers throughout `status-line.tsx`). `PLAN.md` §3.7.1's own stated rule —
"pink = session/cost domain, violet = workspace domain, `ok`/`warn`/`alert`
reserved strictly for health" — isn't being followed; violet/orchid barely
appear, flattening the intended visual hierarchy into one hue.

**Fix:** add `marginBottom`/`marginTop` between top-level panels (welcome,
statusline, REPL) in `cockpit.tsx`. Re-pass over `status-line.tsx` and
`welcome-panel.tsx` and actually apply the token-per-domain rule from
§3.7.1 instead of defaulting most text to `nebula`.

### 5. `/exit` leaves the box artifacts in scrollback

After `/exit`, raw shell text prints directly below the last rendered frame
rather than a clean terminal. `m1m1r.ts:212`/`304` call `instance.unmount()`,
which is correct Ink usage, but Ink's default (non-alt-screen) mode leaves
the last frame in scrollback by design — that's likely "working as intended"
for Ink rather than a bug, but it reads messy. **Investigate** (don't assume
a fix) whether an alternate-screen-buffer mode or an explicit clear on exit
is worth adding — check Ink's actual API surface before changing anything
here, the same way the Claude Agent SDK's hooks/permissionMode contract was
grounded against its shipped `.d.ts` before Phase 1's Anthropic adapter was
written (see `RESEARCH.md`/Phase 1 commit history for that precedent).

### Also missing from Phase 4's actual PLAN.md scope

The Phase 4 build was scoped (by my own handoff prompt to Codex) to §3.7.3–
3.7.7 only. `PLAN.md`'s own Phase 4 entry (§6) also includes **semantic
index + `.m1m1rignore` (§3.4)** and **project memory** — none of which
landed. Codex's own report flagged this exclusion explicitly rather than
silently dropping it, which is why it's called out here rather than
discovered later. Fold these into Phase 4 proper before considering it done,
or explicitly re-scope them into a later phase in `PLAN.md` §6 if that's the
call — right now the doc and reality disagree.

---

## Part 2 — Phase roadmap (`PLAN.md` §6)

Phases 0, 1, 4 done. Phases 2, 3, 5, 6 remain, in PLAN.md's stated order:

### Phase 2 — Truth layer
Evidence objects, `OPEN_QUESTION` protocol + batching UI, layman renderer
with examples, claim auditor, confidence tags.
*Done when:* a planted false claim gets struck by the auditor; a planted
ambiguity surfaces as an example-bearing question, not a guess.

This is the biggest conceptual gap right now: nothing in the shipped code
enforces "evidence over assertion" structurally yet for planner/implementer
prose — the conductor gates on artifacts (receipts, test exit codes)
already, but there's no `evidence/` store, no claim auditor, no
`OPEN_QUESTION` protocol at all. `clarifier` and `auditor` roles from
`PLAN.md`'s roster table (§3.2) still don't exist as role files.

### Phase 3 — Gates
Regression / security / review / integrate gates wired as conductor exit
criteria. `m1m1r rewind` (§3.1 checkpoint/rewind) and `.m1m1r/hooks/` (§3.6)
land here too.
*Done when:* a failing-security diff is blocked with findings; the DoD
checklist prints receipts for every line; a rewound engagement resumes from
a chosen checkpoint with an intact evidence trail; a `pre-gate` project hook
can fail a gate that would otherwise pass.

Depends on Phase 2's evidence store existing first (gates need something
structured to check). `security-reviewer` and `code-reviewer` roles
(§3.2) also still don't exist as role files — only `planner`/`implementer`
do (`src/agents/roles/`).

### Phase 5 — Ops seats
`devops` + `saas-ops` roles wired to real MCP servers (AWS, Cloudflare):
staging deploys, CI repair, incident runbooks, rollback drills. Read-only
MCP servers opened to any role, not just gated ops roles (§3.4's MCP split).
*Done when:* "ship feature X to staging including its infra change"
completes end-to-end with approvals and a rollback plan; a `researcher`
pulls live context from a read-only MCP server without an elevated-permission
prompt.

### Phase 6 — Independent verification + detached execution
`pr-watcher` role (§3.2) wired to the git host's PR/commit webhook,
cross-provider by default; `--background` execution mode (§3.1) with push
notification on approval-needed/completion.
*Done when:* a `pr-watcher` run on a different provider than the one that
authored a diff flags a real defect the authoring engagement's own
`code-reviewer` passed; a `--background` engagement survives the terminal
closing and notifies on the next blocking question.

### Cross-cutting gaps not tied to one phase
- **9 of 11 roster roles still don't exist** as `agents/roles/*.md` files —
  only `planner`/`implementer` do. `registry.ts` is generic over any role
  name (documented as intentional in its own header comment), so adding one
  is authoring a file, not touching code — but Phases 2/3/5/6 all depend on
  specific roles (`clarifier`, `auditor`, `security-reviewer`,
  `code-reviewer`, `devops`, `saas-ops`, `pr-watcher`) that need writing.
- **`m1m1r team`'s `integrator` is still pure TypeScript** (worktree merge +
  optional test command, no LLM judgment) by Phase 1's deliberate scope cut
  — worth revisiting once Phase 3's gates need conflict-resolution
  *reasoning*, not just conflict *detection*.
- Every phase so far has shipped with real bugs an independent review caught
  before commit (see commit messages for the full list per phase) — keep
  that review-before-commit step for Phases 2/3/5/6, it has caught something
  real every single time.
