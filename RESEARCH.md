# Research — mining 7 existing multi-agent harnesses for m1m1r

**Status:** findings · **Date:** 2026-08-23 · **Sources:** `research/vendor/` (gitignored, not committed)

Companion to `PLAN.md`. All 6 clonable repos were pulled shallow into `research/vendor/`
and read (agent definitions, gate logic, worktree code, memory schema, orchestration
loops). #7 (Claude Code native Agent Teams) has no repo — API notes only. Findings
below are organized by which m1m1r module (per `PLAN.md` §5) each pattern feeds.

**Headline result across all 6:** every repo except claude-squad and (partially)
ruflo implements gates/reviews as **prompt trust** — an agent self-reports
PASS/FAIL/finalize and the harness believes the string. None of them independently
verify. m1m1r's existing design principle ("conductor reads artifacts, never
agent prose," PLAN.md §3.3.3) is already ahead of all 6 on this axis — that's the
one thing to *not* dilute while borrowing UI/structure ideas from these repos.

**Addendum — Cursor (closed-source, no clonable repo; docs/reporting only, added
after the initial 6-repo pass):** six features genuinely absent from all 6
researched harnesses, folded directly into `PLAN.md` rather than kept here since
each maps to an existing section: semantic embedding-based codebase index (§3.4,
alongside the tree+symbol map), `.m1m1rignore` (§3.4), MCP opened to any
read-only role not just gated ops roles (§3.4), user-definable hooks (§3.6),
`--background` detached execution with push notification (§3.1), checkpoint/rewind
distinct from crash-resume (§3.1), and an independently-sourced async PR reviewer
— `pr-watcher` (§3.2) — modeled on Cursor's BugBot catching defects the
diff-authoring tool's own review missed. That last one is the one worth flagging
loudest: same-provider self-review correlates blind spots; `pr-watcher` is
deliberately routed to a different provider than whatever produced the diff.
Cursor's Tab/inline-autocomplete is out of scope — m1m1r is an orchestrator
CLI, not an editor, no analogous surface exists to build it into.

---

## `src/agents/` — role definition format

**Adopt: wshobson/agents' template shape**, layered onto m1m1r's existing
`agents/*.md` + permission-tier plan (PLAN.md §3.2/§3.6).

- Frontmatter: `name`, `description` (dense/keyword-packed, used for routing),
  `model`, `tools` (explicit allowlist), optional `color`.
- Body template, consistent across all 202 agents: `## Purpose` → `## Capabilities`
  (bulleted, sub-headed by domain) → `## Behavioral Traits` → `## Knowledge Base` →
  `## Response Approach` (numbered workflow) → `## Example Interactions`.
- Reference files for security/QA/devops roles specifically:
  `research/vendor/agents/plugins/security-scanning/agents/security-auditor.md`,
  `research/vendor/agents/plugins/unit-testing/agents/test-automator.md`,
  `research/vendor/agents/plugins/cloud-infrastructure/agents/deployment-engineer.md`.

**Also fold in from great_cto** (`research/vendor/great_cto/agents/*.md`): the
`applies_to: [archetype, ...]` frontmatter field for archetype-conditional roles
(useful for m1m1r's `security-reviewer`/`devops` roles varying by project type),
and its `maxTurns`/`timeout`/`effort`/`memory` fields as precedent for per-role
runtime limits beyond just model tier.

**Skip:** wshobson has zero orchestration code — it's a prompt library to plug into
an orchestrator, not a source for `src/conductor/` logic. Confirmed via
`Makefile`/`tools/generate.py` — only real code in that repo is the per-harness
doc generator, irrelevant to m1m1r (single-harness, TypeScript-native via Agent SDK).

---

## `src/exec/` (new) — worktree manager

**Port directly: claude-squad's `session/git/` package.** This is the strongest,
cleanest match of all 6 — pure `os/exec` git-CLI wrapper, zero tmux/TUI coupling.

Files to translate (Go → TS, 1:1 logic):
- `research/vendor/claude-squad/session/git/worktree.go` — `GitWorktree` struct
  (repoPath, worktreePath, branchName, baseCommitSHA, isExistingBranch, sessionName);
  path scheme `<configDir>/worktrees/<sanitized-branch>_<unixnano>`.
- `research/vendor/claude-squad/session/git/worktree_ops.go` — lifecycle:
  `Setup()` (`git worktree add -b <branch> <path> <HEAD-sha>`, deletes stale
  same-named branch first), `Cleanup()` (`git worktree remove -f` → `git branch -D`
  → `git worktree prune`), `Remove()` (pause: drop worktree, keep branch),
  package-level `CleanupWorktrees()` (orphan scan via `git worktree list --porcelain`
  cross-referenced against `<configDir>/worktrees/`, force-cleans stragglers).
- `research/vendor/claude-squad/session/git/worktree_git.go` — `runGitCommand`
  wrapper, `IsDirty`, `CommitChanges`, `PushChanges`.
- State persistence pattern: `research/vendor/claude-squad/session/storage.go` —
  flat JSON array (`instances.json`), whole-file read/rewrite per save. m1m1r's
  journal (JSONL, append-only) is a better fit than claude-squad's rewrite-whole-file
  approach — use m1m1r's own journal pattern instead of copying this part.

**Explicit gap to fill ourselves:** claude-squad never auto-merges (confirmed —
no merge logic anywhere in the repo). m1m1r's `integrator` role (PLAN.md §3.2)
already specs conflict resolution + merge, which is new work regardless of source.

**Skip:** tmux session management (`session/tmux/tmux.go`) — m1m1r agents run
in-process via the Agent SDK, not as separate terminal sessions; no analog needed.

---

## `src/gates/` (new) — quality gate design

**Structural gate mechanics: adopt from great_cto**, the only repo with real
enforcement code (not just prompt trust) at the gate-selection layer:

- `research/vendor/great_cto/shared/pipeline.toml` — machine-readable
  agent→agent transition graph (`[transitions.architect]` with `on`, `gate`,
  `next`, `join`, `skip_next_when`). Model for m1m1r's phase-transition table.
- `research/vendor/great_cto/packages/cli/src/archetypes.ts` —
  `GATES_BY_ARCHETYPE`, `gatesFor(archetype, size)`, `effectiveGates(archetype,
  size, tier)` — gate set varies by project archetype + change-risk tier (T0/T1/T2
  from `scripts/lib/change-tier.mjs`). Useful pattern for m1m1r scaling its
  5 fixed gates (PLAN.md §3.5) by diff risk, e.g. skipping `security` gate reasoning
  depth on a docs-only change.
- `research/vendor/great_cto/scripts/lib/approval-level.mjs` — `REGULATED_FLOOR =
  ['security','compliance']`, a hardcoded floor that can't be downgraded even at
  low approval levels. Direct precedent for m1m1r's "elevated always requires
  approval, no exceptions" rule (PLAN.md §3.6) — extend it to "some gates can't be
  skipped even in `full` autonomy mode."

**Where great_cto still falls short (confirms m1m1r must NOT copy this part):**
its `pipeline-dispatcher.mjs` hook reads a self-reported verdict token
(APPROVED/BLOCKED/FAIL) from `.great_cto/verdicts/<agent>.log` — the gate *can't be
skipped* (structural), but the *content of the sign-off* is trusted, not
independently verified. Same flaw, worse, in OpenCastle
(`research/vendor/opencastle/src/orchestrator/skills/panel-majority-vote/SKILL.md`
— the "3 reviewers, ≥2 pass" tally is bash the *agent* is told to run on itself
mid-conversation, not a CI check; nothing in `src/` tallies votes or blocks a
merge). m1m1r's PLAN.md §3.3.3 ("gates check receipts... conductor parses
artifacts, never narrative") is the correct design already — this research
confirms it, it just needs building, not borrowing.

**Also useful:** OpenCastle's on-demand skill-loading manifest shape,
`research/vendor/opencastle/src/orchestrator/customizations/agents/skill-matrix.json`
(dependency graph + per-agent `slots` arrays) — reasonable format reference for
`src/context/` skill/capability loading, even though OpenCastle's own "lean
context" claim isn't mechanically enforced (no runtime loader, just a manifest
agents are told to consult).

---

## `src/conductor/` — task DAG + approval flow

**Task DAG scheduler — don't port, but validate approach against ruflo's:**
`research/vendor/ruflo/v3/@claude-flow/swarm/src/coordination/task-orchestrator.ts`
is a genuine, self-contained dependency-graph scheduler (two `Map<TaskId,
Set<TaskId>>` graphs, DFS cycle detection, priority ready-queue) — ~600 lines,
no swarm/consensus coupling. Confirms m1m1r's planned DAG scheduler (PLAN.md
§3.1) is the right shape; write m1m1r's own rather than port, since it's
small and ruflo's version carries dead imports from the swarm module it lives in.

**Skip entirely: ruflo's swarm/consensus/WASM stack.** Raft/Byzantine/Gossip
(`research/vendor/ruflo/v3/@claude-flow/swarm/src/consensus/{raft,byzantine,gossip}.ts`)
are real, non-trivial implementations — but `grep` across the repo shows
`proposeConsensus()` is called only in its own definition, one wrapper, and a unit
test. Instantiated on every agent spawn but never invoked in the default task-assign
path — decorative. Matches PLAN.md §8.1's existing stance (git-centric, local-first,
single-machine); no reason to import distributed-consensus complexity m1m1r has
no use for.

**Human-approval / lead-gate pattern — take the shape, rebuild the check:**
`research/vendor/AI-Agents-Orchestrator/agentic_team/engine.py:292-510`
implements a turn loop where `current_role` routes based on each agent's own
JSON `to_role` output, with a repeat-route counter forcing escalation to the lead
on loops (`engine.py:401-415`). But per `decision_parser.py:114-121`, the *only*
mechanical check is verifying **who** claims to finalize (must be the lead role by
loop-state identity) — **whether the work is actually done is pure prompt trust**,
identical failure mode to great_cto/OpenCastle above. Use the routing/escalation
*mechanism* (role-to-role handoff via structured output, loop-guard on repeated
routes) for m1m1r's `[HUMAN APPROVE]` state transitions, but m1m1r's gate
must replace "lead says finalize" with "gate parses evidence artifacts" per the
truth protocol already specified (PLAN.md §3.3).

**Also note:** none of AI-Agents-Orchestrator's loop state is persisted — pure
Python locals inside one `execute_task()` call, killed process loses everything.
Confirms m1m1r's journal-per-phase-transition design (PLAN.md §3.1 "Journal")
is a real differentiator, not a nice-to-have; build it early (already Phase 0
per PLAN.md §6).

---

## `src/providers/` — multi-harness / multi-CLI packaging

**Subprocess-CLI adapter pattern** (reference only — m1m1r already commits to
the Agent SDK, not shelling out): `research/vendor/AI-Agents-Orchestrator/agentic_team/adapters/{claude,codex,gemini,copilot}_adapter.py`
all funnel through `CLICommunicator` (`agentic_team/adapters/cli_communicator.py`),
which fakes a TTY via `script -q out.txt <cli-command>` and pipes stdin — every
provider treated as an opaque local binary, no SDK usage anywhere. This is the
"lowest common denominator" approach; m1m1r's `AgentRuntime` port (PLAN.md §3,
§4) is a better design already (SDK for Anthropic, real tool-use loop for
openai-compat) — no need to adopt subprocess-CLI shelling, but worth knowing
it's the fallback of last resort if a future provider genuinely has no API/SDK.

**Multi-harness generator pattern** (reference, not adoption — m1m1r is one
harness, not six): `research/vendor/agents/tools/generate.py` +
`research/vendor/agents/tools/adapters/{codex,cursor,opencode,copilot,antigravity}.py`
transpile one canonical `plugins/*/agents/*.md` source into per-harness formats.
Same idea, more real code, in `research/vendor/opencastle/src/cli/adapters/`
(`single-file-base.ts` strips frontmatter, copies into harness-specific layout).
Not relevant to m1m1r directly (single CLI, not a plugin marketplace), but if
m1m1r ever exports its role definitions for use in Claude Code/Cursor as a
plugin, this is the reference implementation to copy.

**Claude Code native Agent Teams** (no repo — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
shipped ~Feb 2026 alongside Opus 4.6): teammates read/write a **shared task list**
directly (claim work, post results, message each other) rather than routing all
communication through a central orchestrator — opposite of subagents, which can
only report back to the main session. This is closer to ruflo's shared-memory
idea than to m1m1r's conductor-centric design. **Decision point for m1m1r:**
PLAN.md's conductor is intentionally centralized (task DAG owned by one scheduler,
gates read artifacts centrally) — that's compatible with running on the Agent SDK
today, but if m1m1r's `implementer` agents are literally Claude Code sessions
under the hood, native Agent Teams' shared-task-list primitive could eventually
replace m1m1r's own DAG scheduler's *distribution* mechanism (not its gate/
truth-protocol layer, which has no native equivalent). Flag as a Phase 1+ research
spike, not a v1 dependency — the env var is still experimental/gated.

---

## Skip list — explicit, with reasons

| From | What | Why skip |
|---|---|---|
| ruflo | Swarm/consensus/WASM stack (`UnifiedSwarmCoordinator`, `SwarmHub`, Raft/Byzantine/Gossip, agent-registry's 15-agent topology) | Real code, but unused in default path (confirmed via grep — `proposeConsensus()` has no real caller); entangled with a distributed-process model m1m1r doesn't have (PLAN.md §8.3: git-centric, local-first) |
| ruflo | `SQLiteBackend.ts` (the fake one, `v3/src/memory/...`) | Explicitly a stub — comment admits "For now, using in-memory storage," `Map()` under the hood despite the name |
| OpenCastle | Gate/review/panel-vote *enforcement* logic | Confirmed pure prompt trust — no code tallies votes, parses verdicts, or blocks anything; the SKILL.md files are instructions the LLM is told to follow, not checks the harness runs |
| AI-Agents-Orchestrator | "Lead finalizes" gate | Same flaw as above — verifies *who* claims done, never *whether* it's actually done |
| AI-Agents-Orchestrator | Subprocess/TTY-faking CLI adapters | m1m1r already has a better-designed `AgentRuntime` port (SDK-based, not shell-out); only relevant as a last-resort fallback pattern |
| claude-squad | tmux session management | No analog — m1m1r agents run in-process, not as terminal sessions |
| wshobson/agents | Nothing to skip — it's pure prompt library with no orchestration code to accidentally over-adopt | — |
| great_cto | Verdict-token trust in `pipeline-dispatcher.mjs` | Gate-selection structure is good (adopted above); the sign-off content itself is self-reported, same flaw as OpenCastle/AI-Agents-Orchestrator — don't copy this part |

---

## Net effect on `PLAN.md`

No architecture changes required — this research validates PLAN.md's existing
design (evidence-over-assertion truth protocol, conductor-reads-artifacts gates,
git-worktree execution, journal-based resume) as already ahead of every repo
surveyed on the one dimension that matters most (gate enforcement is real vs.
trusted). Concrete additions to fold into implementation when each module is
built (PLAN.md §6 phases):

- **Phase 1** (`src/exec/`): build worktree manager as a TS port of
  `claude-squad/session/git/{worktree,worktree_ops,worktree_git}.go`.
- **Phase 1** (`src/agents/`): use wshobson's Purpose/Capabilities/Behavioral
  Traits/Response Approach template for `*.md` role bodies; adopt great_cto's
  `applies_to`/`maxTurns`/`effort` frontmatter fields.
- **Phase 3** (`src/gates/`): use great_cto's `pipeline.toml` transition-graph +
  `GATES_BY_ARCHETYPE`/`REGULATED_FLOOR` pattern for gate selection and
  non-skippable gates — but wire gate *evaluation* to m1m1r's own evidence
  store (PLAN.md §3.3), never a self-reported verdict string.
- **Phase 1** (`src/conductor/`): write a small DAG scheduler in the shape of
  ruflo's `task-orchestrator.ts` (Maps + cycle detection + unblock-on-complete),
  original implementation, no port.
- **Phase 5+ spike**: evaluate Claude Code native Agent Teams' shared-task-list
  primitive as a possible distribution mechanism under the conductor, once it's
  stable/non-experimental.
