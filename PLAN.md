# m1m1r — Autonomous Engineering Team Harness

**Status:** proposal · **Date:** 2026-08-23 · **Repo:** fresh, empty

## 1. What this is

A terminal-native orchestrator that runs an entire software organization — architect, researchers, implementers, QA, security, reviewers, DevOps, SaaS-ops — as AI agents. Input: a requirement in plain English. Output: a merged, tested, reviewed change (or a deployed staging service), with every claim backed by captured evidence and every genuine unknown surfaced as a question *before* work proceeds.

**Non-goals (v1):** IDE GUI, cross-org multi-repo refactors, self-driving production deploys.

## 2. Design principles

1. **Evidence over assertion.** An agent may not claim "tests pass" — it attaches the command, exit code, and captured output. Claims without receipts are discarded.
2. **Ask, don't guess.** Ambiguity becomes a structured `OPEN_QUESTION` rendered in plain language with a concrete example. Blocking questions halt the pipeline; assumable ones carry a visible default.
3. **Human approves risk, machine absorbs volume.** One approval covers a batch of low-risk actions. Destructive, irreversible, or production actions always stop for a human.
4. **Small blast radius.** Every mutation happens in an isolated git worktree, by an agent whose tool access is scoped by role and path. Nothing touches `main` until gates pass.
5. **Resumable everything.** Every phase transition, task result, question, and approval is appended to a journal. Kill the process anywhere; `m1m1r resume` continues exactly where it stopped.

## 3. Architecture

```
┌────────────────────────────── m1m1r (CLI / TUI) ──────────────────────────────┐
│                                                                                  │
│  Requirement ──► CONDUCTOR ──► phase state machine + task DAG scheduler          │
│                     │                                                            │
│      ┌──────────────┼────────────────┬─────────────────┬──────────────┐         │
│      ▼              ▼                ▼                 ▼              ▼         │
│   Clarifier     Researchers       Planner          Executors        Gates       │
│   (questions)   (read-only)       (task DAG)       (worktrees)      test/sec/   │
│                                                                     review       │
│      └──────────────┴────────┬───────┴─────────────────┴──────────────┘         │
│                              ▼                                                   │
│                  EVIDENCE STORE ◄── JOURNAL (append-only JSONL, resume point)    │
│                              ▲                                                   │
│                   CLAIM AUDITOR ──► final report to user                         │
└──────────────────────────────────────────────────────────────────────────────────┘
         │
         └──► AgentRuntime port ──► provider adapters
              • anthropic     : Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
              • openai-compat : own minimal tool-use loop (OpenRouter, OpenAI, Codex)
```

### 3.1 Conductor (orchestrator)

One requirement = one **engagement**, driven by a state machine:

```
INTAKE → CLARIFY → RESEARCH → PLAN → [HUMAN APPROVE] → EXECUTE ⇄ VERIFY → INTEGRATE → REPORT
   \__________ any phase can emit OPEN_QUESTIONS ──────────────► BLOCKED(user) ──┘
```

Responsibilities:

- **Task DAG.** Planner emits nodes `{id, role, inputs: evidence-refs, scope: paths, acceptance_criteria, depends_on}`. Scheduler runs all ready nodes concurrently up to a configurable limit.
- **Phase exit gates** (§3.5). The conductor reads artifacts, never agent prose.
- **Autonomy dial.** Three presets: `supervised` (approve plan + every gate), `semi` (auto-execute non-risky tasks, stop at gates and prod actions), `full` (auto through staging; prod still human). Default `semi`.
- **Execution location — local vs background** (from Cursor's Background/Cloud Agents; not present in any of the 6 harnesses researched, see `RESEARCH.md`). Default `local`: engagement runs in the foreground terminal, ties up the machine. `--background` detaches the engagement to run unattended (same conductor/gates/journal — no separate code path) and pushes a notification (configurable: desktop, `PushNotification`, webhook) on phase transitions that need approval or on completion. This is a transport concern, not a new autonomy tier — a `background` run still honors whatever autonomy preset it was launched with, still stops for elevated actions.
- **Budget governor.** Per-engagement token/$ ceiling. Soft warning at 70%, hard stop parks the engagement cleanly for resume.
- **Journal.** `{ts, engagement, phase, event, payload}` JSONL under `.m1m1r/engagements/<id>/`. Also the trace log (per-agent tokens, duration) for the dashboard.
- **Checkpoint/rewind** (from Cursor's per-step checkpoints; distinct from crash-resume above — not present in any of the 6 harnesses researched). Journal is append-only by design (§3.1), so rewind never mutates history — `m1m1r rewind <engagement> <journal-seq>` forks a *new* engagement id whose journal is seeded by replaying entries `0..seq` from the source, then resumes normally from there. Lets a human back out of a bad plan/implementer choice mid-engagement and retry from an earlier phase with a different answer to an `OPEN_QUESTION`, without losing the original run's evidence trail (it's still on disk, just abandoned rather than overwritten). `/rewind` in the REPL lists checkpointable journal positions (phase transitions, gate passes, question answers) rather than every raw event.

### 3.2 Agent roster

Roles are declarative files (`agents/*.md`: system prompt, allowed tools, writable paths, model tier, output contract) — same pattern as Claude Code custom subagents, so they're diffable and versioned in-repo.

| Role | Purpose | Tools | Writes | Model |
|---|---|---|---|---|
| `clarifier` | Extract ambiguity from requirement + research; draft questions | read-only | no | `claude-opus-5` |
| `researcher` ×N | Repo map, prior art, dependency/doc/web research | read-only + web | no | `claude-sonnet-5` |
| `planner` | Task DAG + acceptance criteria + risk register | read-only | plan file only | `claude-opus-5` |
| `implementer` ×N | Execute one task node in its own worktree | edit/write/shell (scoped) | yes, scoped paths | `claude-sonnet-5` |
| `test-engineer` | Regression tests for the diff; run suites; flake-check | shell + test-path writes | tests only | `claude-sonnet-5` |
| `security-reviewer` | Threat-model the diff; secret scan; dep audit; OWASP checks | read-only + scanners | no | `claude-opus-5` |
| `code-reviewer` | Adversarial review: try to *refute* the diff's correctness | read-only | no | `claude-opus-5` |
| `integrator` | Merge worktrees, resolve conflicts, run full suite | git + shell | yes | `claude-sonnet-5` |
| `auditor` | Final claim-vs-evidence audit of the report | evidence store only | no | `claude-opus-5` |
| `devops` | Infra, CI repair, deploy pipelines (staging) | cloud CLIs/MCP (gated) | gated | `claude-sonnet-5` |
| `saas-ops` | Incident runbooks, billing webhooks, support triage drafts, docs | read + drafts | drafts only | `claude-haiku-4-5` |
| `pr-watcher` | Async, out-of-engagement: re-reviews any pushed commit/PR (from this harness or a human) for bugs the original author's tooling missed | read-only + PR comment | PR comments only | different provider than the engagement that produced the diff (see below) |

**Why `pr-watcher` is a distinct role, not just re-running `code-reviewer`** — prompted directly by watching Cursor's BugBot catch things Claude Code/Codex miss on their own diffs: a reviewer sharing the same model, provider, and context as the implementer inherits the implementer's blind spots (same training biases, same tendency to rationalize its own prior output as correct). `code-reviewer` (§3.2) runs *inside* the engagement, same provider family, adversarial by prompt but not by construction. `pr-watcher` runs *after* the engagement closes, on the merged diff alone (no access to the engagement's plan/evidence/reasoning — it only sees what a human reviewer would see: the diff and the repo), and is routed to a **different model tier/provider than whatever produced the diff** (config default: if the engagement ran on Anthropic, `pr-watcher` runs on the OpenAI-compat tier, and vice versa — enforced at the tier-binding layer in §4.1, not left to chance). Independence is the point, not thoroughness — two similar reviewers correlate their misses, two differently-sourced ones don't.

Model tiering is the cost lever: mechanical/search work lands on Haiku ($1/$5 per MTok), judgment work on Opus ($5/$25). Per-role override in config.

### 3.2.1 Shared agent constitution

Every role's system prompt is `agents/_shared/constitution.md` + the role's own
file, in that order (same "shared preamble, role-specific specialization" pattern
found in great_cto's `agents/_shared/phase-task.md` — see `RESEARCH.md`). The
constitution encodes the operating discipline this harness is itself built under
(this Claude Code session's own governing instructions), so the tool building
m1m1r behaves the way the assistant building the tool behaves. One inheritance
chain, no drift between "how I code" and "how the agents I spawn code."

Clauses, each with which role(s) it binds hardest and how it's enforced:

| Clause | Binds | Enforcement |
|---|---|---|
| **No premature abstraction.** No interface for one implementation, no config for a value that never changes, no speculative future-proofing. Three similar lines beat a premature helper. | `implementer` | `code-reviewer` gate flags unrequested abstraction as a finding, same severity class as a correctness bug |
| **Root cause, not symptom.** Before editing a shared function, grep every caller; fix once at the shared point, not per-caller patches. | `implementer`, `planner` | Planner's task nodes must name the shared function + caller list when a bug task touches one; `code-reviewer` checks the diff addresses all call sites, not just the reported one |
| **No comments unless the WHY is non-obvious.** Never restate what the code does; never reference the current task/ticket in a comment. | `implementer` | `code-reviewer` strikes comments that fail this test |
| **Minimal diff for the stated task.** No drive-by refactors, no "while I'm here" cleanups bundled into a bug-fix task. | `implementer` | Task node's `scope: paths` + `acceptance_criteria` (PLAN.md §3.1) is the literal diff boundary; out-of-scope edits are a plan-gate violation, not a style nit |
| **Evidence over assertion; no claim without a citation.** Already the harness's core truth protocol (§3.3) — the constitution is where it's stated as a *behavioral* rule for every agent, not just a data-format rule for the evidence store. | all | §3.3 mechanics (structural, not prompted) |
| **Ask, don't guess.** Ambiguity becomes an `OPEN_QUESTION`, never a silent assumption. | `clarifier`, `planner`, `implementer` | §3.3 `OPEN_QUESTION` protocol |
| **Verify before claiming done — including UI/behavior, not just green tests.** A passing type-check or test suite verifies correctness, not that the feature works; for anything user-facing, `test-engineer` must include a captured runtime demonstration (command run + output, or a screenshot artifact), not just `exit 0`. | `test-engineer`, `implementer` | Regression gate (§3.5) rejects a "done" claim backed only by static checks when the task touches user-facing behavior |
| **Trust but verify subagent/tool output.** A prior agent's summary describes intent, not necessarily result — the next agent in the DAG re-checks the actual diff/output before building on it, doesn't take the handoff message at face value. | every consumer of another agent's output | `auditor` role (§3.2) generalizes this to the whole engagement; individual agents apply it locally per PLAN.md §3.3.3 ("conductor reads artifacts, never agent prose") |
| **Git safety protocol.** Never `--force`, `--no-verify`, `reset --hard`, or skip hooks unless the human explicitly asked for that specific action in that turn. Prior approval doesn't carry forward to a new destructive action. Always `git status` before anything that can discard uncommitted work. | `implementer`, `integrator`, `devops` | Shell policy denylist (§3.6) enforces the hard cases structurally; the constitution states the softer "don't re-use an old approval" rule that can't be a regex |
| **Match the blast radius to the ask.** Reversible/local actions proceed freely; hard-to-reverse or shared-state actions (force-push, prod deploy, external messages) stop for human approval — a scope the human granted once isn't standing authorization for a bigger action later. | `devops`, `saas-ops`, `integrator` | §3.6 permission tiers; elevated tier is the mechanical backstop, this clause is the judgment call for what counts as elevated when it's ambiguous |
| **No secrets, ever, in any output.** Redact before it reaches a journal entry, transcript, or report — not after. | all | `src/security/redact.ts` runs on every journal write, not just at report time |

The constitution is a living file — when a gate rejects an agent's output for a
reason not yet covered above, the fix belongs in the constitution (so every future
agent inherits the correction), not just in that one role's prompt. Same principle
this session applies to its own memory system: corrections generalize upward
instead of getting patched locally and forgotten.

### 3.3 Truth protocol (the anti-hallucination core)

Everything passed between agents — or to you — is an **Evidence object**, not prose:

```jsonc
{
  "claim": "auth middleware rejects expired tokens",
  "source": { "kind": "cmd_output", "ref": "journal#evt-142",
              "cmd": "npm test -- auth", "exit": 0 },
  "confidence": "verified"        // verified | inferred | unverified
}
```

Rules enforced structurally, not just by prompting:

1. **Grounding.** Claims about code must cite `file:line`; claims about behavior must cite a command run or test; claims about the world must cite a fetched URL. No citation ⇒ `unverified`, and unverified claims cannot be a basis for further work.
2. **No silent assumptions.** Missing information ⇒ emit `OPEN_QUESTION {id, blocking?, question_layman, example, proposed_default}` — never invent a value.
3. **Gates check receipts.** "Execute done" requires diffs to exist; "Verify passed" requires captured green output. The conductor parses artifacts, never narrative.
4. **Claim audit.** Before any final report reaches you, the `auditor` replays every factual sentence against the evidence store and strikes or downgrades unsupported ones. The report shows `[verified]` / `[assumed]` inline.
5. **Questions render for humans.** Example:

> **Q: When someone deletes their account, should we erase their data right away?**
> Today nothing happens on delete — the rows stay forever. Two common patterns:
> • **Hard delete now** — gone within minutes. Simple, satisfies strictest privacy rules, unrecoverable.
> • **30-day soft delete** — account deactivates instantly, data purged after 30 days. Recoverable; needs a purge job.
> Proposed default: **30-day soft delete** (industry standard). Reply `ok` to accept, or say what you want.

Questions batch into one review screen (no drip-interruption). Answers persist to project memory — the same question is never asked twice.

### 3.4 Context & memory engine

- **Repo map** — tree + symbol index, cached in `.m1m1r/cache`, invalidated by content hash. Researchers consume the map, not raw trees.
- **Semantic index** (from Cursor's `@codebase` — not present in any of the 6 harnesses researched, see `RESEARCH.md`) — embeddings over file chunks, cached in `.m1m1r/cache/embeddings.db`, same content-hash invalidation as the repo map. Lets `researcher` retrieve by meaning ("where do we validate webhook signatures") instead of only by symbol name — a strict superset of the tree+symbol map, not a replacement: symbol index for "who calls X," semantic index for "who does something like X." Local embedding model by default (no data leaves the machine); opt-in remote model per `/model` config.
- **`.m1m1rignore`** — `.gitignore`-syntax file at repo root, layered on top of `.gitignore` (same precedence Cursor's `.cursorignore` uses), excluding paths from both indexes and from any agent's read scope regardless of role permission tier. For secrets-adjacent directories a project wants agents to never see, even read-only.
- **Engagement scratchpad** — `.m1m1r/engagements/<id>/`: journal, `plan.md`, `evidence/`, worktree refs, transcripts.
- **Project memory** — `.m1m1r/memory/`: conventions, answered questions, gotchas. Auto-loaded each session.
- **Compaction** — between phases, a summarizer compresses the transcript into a handoff brief (decisions, evidence refs, open threads) so long engagements don't blow context.
- **MCP as a general context source, not just a gated devops tool.** PLAN.md's roster already gates MCP for `devops`/`saas-ops` (cloud CLIs, staging deploys — correctly elevated-permission). Cursor's broader pattern is MCP as read-only context enrichment available to *any* role — a `researcher` querying a live DB schema or an internal docs server mid-investigation, no elevated permission needed since it's read-only. Split the concept: **read-only MCP servers** (docs, schema introspection, ticket trackers) are available to any role per its existing tool allowlist; **mutating MCP servers** (deploy, billing, infra) stay behind the elevated-tier gate already specified in §3.6.

### 3.5 Quality gates (Definition of Done, enforced mechanically)

| Gate | Passes when |
|---|---|
| **Plan** | Every task has acceptance criteria + path scope; zero unresolved blocking questions |
| **Regression** | Full existing suite green (captured output); new/changed behavior covered by new tests; flakes re-run ×3 |
| **Security** | Diff-level threat review clean; secret scan clean; dependency audit below threshold; no new dangerous APIs |
| **Review** | Adversarial reviewer reports no unresolved critical/major findings |
| **Integrate** | Merged tree builds; full suite green post-merge; docs/changelog touched if public behavior changed |

### 3.6 Safety & permissions

- **Permission tiers per role** (mirrors Claude Code permission modes): read-only / scoped-write / elevated. Elevated (prod, irreversible, network mutations, money) always requires interactive approval — no exceptions, including "you told it once before".
- **Shell policy** — allowlist by default; hard denylist for `rm -rf`, force-push, prod URLs, credential paths.
- **Secrets** — injected via env at runtime; redacted in all journals and transcripts.
- **Sandbox** — optional container/OS-sandbox mode behind a flag for untrusted repos.
- **User-defined hooks** (from Cursor's Hooks; not present in any of the 6 harnesses researched, see `RESEARCH.md`). `.m1m1r/hooks/<event>.sh` — project-authored shell scripts firing on conductor events (`pre-gate`, `post-gate`, `pre-elevated-action`, `phase-transition`). Distinct from the shell allowlist/denylist above: the denylist is the harness's own hard floor (can't be relaxed by a hook), hooks are the project's *extension* point for things the harness can't anticipate (e.g. a project-specific linter as an extra `pre-gate` check, or pinging a team Slack channel on `pre-elevated-action`). A hook can block (non-zero exit halts the transition, same as a failed gate) but never silently auto-approve — it's additive friction, not a bypass.

### 3.7 UI — theme system, welcome panel, statusline, REPL

**Sessions grouped by project, launch-location independent.** Every session belongs to a project (git repo root, else cwd). Sessions live in `~/.m1m1r/projects/<project-slug>/<session-id>/` — start a session anywhere, resume it from anywhere. `m1m1r` with no args opens the most recent session for the current project; `m1m1r sessions` (or `/sessions`) lists all projects with their sessions — resume, rename, delete. The per-repo `.m1m1r/` keeps only caches and memory.

#### 3.7.1 Theme — "Nebula"

Dark-first, pink↔purple gradients, semantic status colors. Every color is a named token; components never hardcode hex.

| Token | Hex | Use |
|---|---|---|
| `void` | `#0d0a14` | background |
| `chrome` | `#6d28d9` | panel borders, dividers |
| `violet` | `#8b5cf6` | workspace/repo fields |
| `nebula` | `#ff6ec7` | session/model/live-activity fields |
| `orchid` | `#c084fc` | secondary text, labels |
| `core` | `#fef3ff` | logo center, key numbers |
| `ok` | `#34d399` | passed gates, completed phases |
| `warn` | `#fbbf24` | ≥70% budget, flaky tests, soft limits |
| `alert` | `#f87171` | blocking questions, failed gates, hard stop |
| `dim` | `#6b7280` | pending phases, inactive items |

**Color is semantic before decorative:** pink = session/cost domain, violet = workspace domain, and `ok`/`warn`/`alert` are reserved strictly for health — a red pixel anywhere on screen means "look now". Gradients interpolate `nebula→violet` per cell (logo fill, panel top borders, phase-pipeline progress) using 24-bit ANSI. Fallback ladder: `COLORTERM=truecolor` → 256-color nearest match → plain mono under `NO_COLOR` or `TERM=dumb`.

#### 3.7.2 Logo — spiral galaxy

Detailed multi-row ASCII mark, gradient-filled per row band (rim violet, arms orchid, starfield dim, core white-hot). Draft:

```
       *    .       ✧        .    *
    .          _.-=-._
         ✧  ,-'  ✦  '-,         .
    .      ,'  ,-'''-,  ',
          /  ,'  (✷)  ',  \      *
    -    |  |  ,'     ',  |  -
         |  |  ',     ,'  |
    .     \  ',  '-...-'  ,'        .
     ✧     ',  '-.......-'  ✧
    .    *   '-,_     _,-'   .    *
           .     '''''''      .
       *     .    ✧    .      *
```

Renders large in the welcome panel at ≥100 cols; degrades to a single-line glyph (`✷`) for narrow layouts and inline headers. Final art tuned in Phase 4; structure fixed here.

#### 3.7.3 Welcome panel

Boxed, two columns wide, stacks to one column under 90 cols. Three zones — the third is an improvement over the reference layout, which spends its left column entirely on a mascot:

```
╭─ m1m1r v0.1 ─────────────────────────────────────────────────────────────╮
│                                                                             │
│    [galaxy logo]                Tips for getting started                    │
│                                Run /init to write M1M1R.md — project     │
│    Welcome back,            conventions the whole team reads.               │
│    Sonam!                                  ─────────                       │
│                                 What's new                                  │
│    ox-alpha · high ·        Budget governor shows live $ burn …             │
│    OpenRouter (key)                         ─────────                       │
│    ~/Workbench/m1m1r-cli     Quick commands                              │
│    master*                      /model /plan /questions /push               │
│ ─────────────────────────────────────────────────────────────────────────── │
│ ↻ #42 · EXECUTE · 12/18 tasks · agents ●3○2 · $14.20/$25 · ⚠ 1 blocking Q   │
╰─────────────────────────────────────────────────────────────────────────────╯
```

- **Left:** galaxy logo, greeting, identity block (`model · effort · provider/account-type`), project path + branch + dirty marker.
- **Right:** rotating tips, what's-new, context-aware quick commands.
- **Resume strip (new):** when the session resumes an engagement, one line snapshotting phase, task progress, agent counts, $ spent, open questions — resume is informed without scrolling the transcript. Absent on fresh sessions.

#### 3.7.4 Statusline

Persistent above the input box. Redesigned against the reference layout — deliberate divergences:

1. **Row 1 is ENGAGEMENT, not workspace.** Conductor state (phase, DAG progress, gate status) is the highest-value, fastest-changing data in an orchestrator; git branch is low-churn trivia and moves down. The reference buries pipeline state behind static fields.
2. **Phase pipeline as chips**, each colored by state — position in the state machine readable at a glance, no interpretation needed.
3. **Emoji dropped from gauges.** Emoji are double-width and break column alignment across terminals; replaced by colored ASCII glyphs.
4. **Budget bar shifts hue** (`ok→warn@70%→alert@90%`) instead of staying one color while approaching the ceiling.
5. **Blocking-question badge repeats on every row** until answered — cannot be missed mid-flow.
6. **Staleness is visible.** Any gauge not refreshed within 5s renders dimmed — you always know if you're looking at live data.

Wide layout (≥110 cols), three labeled rows + hint row:

```
┌─ ENGAGEMENT ────────────────────────────────────────────────────────────────┐
│ ✓INTAKE ✓CLARIFY ✓RESEARCH ◆PLAN▸approve ▶EXECUTE 12/18 ⋯VERIFY ⋯INTEGRATE │
│ agents ●3 active ○2 idle │ ⚠ 1 blocking question                             │
├─ SESSION ───────────────────────────────────────────────────────────────────┤
│ ox-alpha ⚡high │ $14.20 ▓▓▓▓▓░░░░░░ 57% of $25 │ ↑48.1k ↓12.4k │ ctx ▓▓▓░ 34%│
├─ CONTROL ───────────────────────────────────────────────────────────────────┤
│ semi │ openrouter·key │ master* wt:task-auth │ 5h $4.10 │ 7d $61.80          │
├─────────────────────────────────────────────────────────────────────────────┤
│ »» /model · /questions · /budget · /agents · shift+tab cycle mode · ! shell │
└─────────────────────────────────────────────────────────────────────────────┘
```

Phase-chip states: `✓` done (`ok`), `▶` running (`nebula` + spinner), `◆` awaiting human approval (`warn`, pulsing), `⋯` pending (`dim`). A failed gate renders its chip `✗FAIL` (`alert`).

Responsive degradation:

| Width | Layout |
|---|---|
| ≥110 cols | Full: 3 labeled rows + hint row, all fields |
| 70–109 cols | 2 rows: engagement essentials + merged session/control; paths abbreviated, 5h/7d dropped |
| <70 cols | Single line: `▶EXECUTE 12/18 │ $14.20/25 │ ctx34% │ ⚠1Q` |

Height-constrained terminals (<12 rows) drop the welcome panel after first render regardless of width.

#### 3.7.5 Data-binding contract (accuracy)

Every statusline field names its source; nothing is derived by approximation:

| Field | Source | Refresh |
|---|---|---|
| phase chips | conductor state-machine events | on transition |
| tasks n/m | scheduler registry (DAG nodes settled/total) | on node settle |
| agents ●n ○m | runtime agent registry | 1s tick |
| tokens ↑↓ | provider usage events appended to journal | per response |
| $ spend | Σ(tokens × tier price table at call time) | per response |
| ctx % | last usage (input + cache reads) / model window | per response |
| 5h / 7d rollups | journal aggregation | 30s |
| branch / dirty / worktree | git query via fs-watcher | on change |
| budget ceiling | config | config load |

Numbers never render before their first real event arrives — the field shows `—`, not a plausible zero.

#### 3.7.6 REPL area

Streamed responses, agent tree while executing (spinner per role), batched question cards with selectable options, diff/test receipts inline. Interruptible at any point; `!` runs raw shell; slash commands autocomplete from the input box. Question cards and gate failures use `alert`; approval prompts invert to `chrome` background for emphasis.

#### 3.7.7 Component inventory (Ink)

All components take terminal `width` from Ink's `useStdout`; zero hardcoded column counts.

`<GalaxyLogo size>` · `<GradientBox>` (gradient top border + theme border) · `<PhasePipeline>` · `<Gauge>` (bar + % from one value — never two sources of truth) · `<BudgetBar>` (hue-shifts at thresholds) · `<StatusLine>` · `<WelcomePanel>` · `<ResumeStrip>` · `<QuestionCard>` · `<AgentTree>` · `<DiffReceipt>`.

## 4. Tech stack

- **Runtime:** TypeScript, Node ≥ 22.
- **Agent substrate:** **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — Claude Code packaged as a library: tool-use loop, built-in file/bash/grep/web tools, subagents, hooks, permission plumbing, MCP client. We build conductor, gates, evidence, and UX on top. The SDK hides behind a thin `AgentRuntime` port so the upper layers never import SDK types directly.
- **Models:** multi-provider via tier aliases — see §4.1.
- **TUI:** Ink (React-for-terminals) — same class of stack as Claude Code.
- **Storage:** filesystem-first (JSONL journal + JSON snapshots). SQLite later only if query needs demand it.

### 4.1 Model routing & multi-provider

Any role can run on any provider. Model sources:

| Source | Auth | Transport |
|---|---|---|
| Anthropic — Claude subscription | Claude Code OAuth login | Agent SDK adapter |
| Anthropic — API | `ANTHROPIC_API_KEY` | Agent SDK adapter |
| OpenRouter | `OPENROUTER_API_KEY` | OpenAI-compat loop |
| OpenAI — API | `OPENAI_API_KEY` | OpenAI-compat loop |
| Codex — ChatGPT subscription | Codex CLI login | OpenAI-compat loop |

**Secrets live in macOS Keychain, never in dotfiles.** `m1m1r secret set OPENROUTER_API_KEY` wraps `security add-generic-password`; runtime resolves via `security find-generic-password`. Same-named env var overrides (for CI/headless).

**Tier aliases** decouple the 11 roles from vendors. Your defaults:

| Tier | Default roles on tier | Default model |
|---|---|---|
| `opus` | clarifier, planner, security-reviewer, code-reviewer, auditor | `deepseek/deepseek-v4-pro` |
| `sonnet` | researcher, implementer, test-engineer, integrator, devops | `ox-alpha` |
| `haiku` | saas-ops, triage, mechanical search | `qwen/qwen3-coder-30b-a3b-instruct` |

Every binding overridable per role; model strings are opaque slugs — harness never interprets them.

**Precedence (high → low):** `--model` flag / `/model` pick → `M1M1R_TIER_*` env vars (set per environment/project in `~/.zshenv`) → project `.m1m1r/config.json` → global `~/.m1m1r/config.toml`.

**`/model`** lists every configured provider, account type (subscription vs API key), and model with current tier bindings; select to rebind a tier or switch mid-engagement. Non-interactive twin: `m1m1r model ls|use <tier>=<provider/model>`.

**Capability caveat:** routing judgment roles (planning, review) to third-party models may drop quality — evals catch this; pin those roles back per-role if so. Truth protocol, gates, and conductor are model-independent by design.

## 5. Repository layout

```
src/
  bin/          # CLI entry, command parsing, slash commands
  conductor/    # state machine, DAG scheduler, budget governor, journal
  runtime/      # AgentRuntime port
  providers/    # anthropic (Agent SDK) + openai-compat adapters, keychain secret store
  agents/       # role definitions (*.md) + loader + permission tiers
  agents/_shared/constitution.md  # §3.2.1 — prepended to every role's system prompt
  evidence/     # evidence store, claim validator, auditor
  clarify/      # question extraction, batching, layman renderer
  context/      # repo map, semantic index (§3.4), memory, compaction
  exec/         # worktree manager, shell policy, sandbox
  gates/        # regression, security, review, integrate gates
  watch/        # pr-watcher role runtime (§3.2) — async, out-of-engagement PR review
  ui/           # theme engine + Ink components (§3.7): statusline, welcome panel, REPL
  eval/         # golden tasks + harness regression evals
.m1m1r/      # runtime data (journal, cache, engagements; memory/ committed)
.m1m1r/hooks/       # user-defined hooks (§3.6)
.m1m1rignore        # index/read exclusions, layered on .gitignore (§3.4)
```

## 6. Build order

**Phase 0 — Skeleton that walks.** CLI boots; one engagement runs end-to-end on the SDK with a single generic agent: intake → naive plan → edit → run tests → report. Journal + resume working. Single-line mini statusline (`phase │ $ │ ctx%`) + theme tokens as constants — budget governor needs visible output from day one. `agents/_shared/constitution.md` (§3.2.1) written and prepended to the generic agent's prompt from the first commit, not bolted on later — the discipline it encodes (small diffs, no premature abstraction, evidence-over-assertion) should shape every subsequent phase's own code, including the harness's own source.
*Done when:* `kill -9` mid-run, `m1m1r resume` completes the engagement; statusline $ matches journal Σ within rounding.

**Phase 1 — The team + multi-provider.** Role registry, task DAG scheduler, worktree-per-implementer, integrator merge; OpenAI-compat adapter (OpenRouter/OpenAI/Codex), keychain secret store, `/model` listing + tier rebinding.
*Done when:* one requirement fans out to ≥3 concurrent implementers that merge conflict-free on a demo repo — twice: once all-Anthropic, once mixed-provider per §4.1 defaults.

**Phase 2 — Truth layer.** Evidence objects, `OPEN_QUESTION` protocol + batching UI, layman renderer with examples, claim auditor, confidence tags.
*Done when:* a planted false claim gets struck by the auditor; a planted ambiguity surfaces as an example-bearing question, not a guess.

**Phase 3 — Gates.** Regression / security / review / integrate gates wired as conductor exit criteria. `m1m1r rewind` (§3.1 checkpoint/rewind) and `.m1m1r/hooks/` (§3.6) land here too — both are gate-adjacent (they intercept the same phase-transition points gates already own).
*Done when:* a failing-security diff is blocked with findings; the DoD checklist prints receipts for every line; a rewound engagement resumes from a chosen checkpoint with an intact evidence trail; a `pre-gate` project hook can fail a gate that would otherwise pass.

**Phase 4 — Cockpit.** Full §3.7 UI: theme engine (gradient renderer + fallback ladder), galaxy logo, welcome panel + resume strip, three-row responsive statusline (§3.7.4), agent tree, question inbox, contextual hint row. Slash commands, autonomy dial, project memory. Semantic index + `.m1m1rignore` (§3.4) also land here — both are context-quality work, same phase as project memory.
*Done when:* user steers a running engagement — pause, answer a question, redirect one task — without killing it; statusline reflects a phase transition within 1s; layout reflows correctly at 60/80/120 cols; renders mono under `NO_COLOR`; a `researcher` finds relevant code via semantic query that the symbol index alone would've missed; a path under `.m1m1rignore` never appears in any agent's context regardless of role.

**Phase 5 — Ops seats.** `devops` + `saas-ops` roles wired to real MCP servers (AWS, Cloudflare): staging deploys, CI repair, incident runbooks, rollback drills. Read-only MCP servers (docs, schema introspection) opened up to any role per §3.4's MCP split, not just the gated ops roles.
*Done when:* "ship feature X to staging including its infra change" completes end-to-end with approvals and a rollback plan; a `researcher` pulls live context from a read-only MCP server without triggering an elevated-permission prompt.

**Phase 6 — Independent verification + detached execution.** `pr-watcher` role (§3.2) wired to the git host's PR/commit webhook, cross-provider by default; `--background` execution mode (§3.1) with push notification on approval-needed/completion.
*Done when:* a `pr-watcher` run on a different provider than the one that authored a diff flags a real defect the authoring engagement's own `code-reviewer` passed; a `--background` engagement survives the terminal closing and notifies on the next blocking question.

**Parallel track from day 1 — evals.** `eval/` holds ~10 golden tasks (bugfix, feature, refactor, migration, security fix) with expected outcomes; every phase keeps them green. Track **hallucination rate**: % of final-report sentences surviving the claim audit, per release.

## 7. Key risks

| Risk | Mitigation |
|---|---|
| Cost runaway from fan-out | Budget governor, Haiku-first triage, concurrency caps, per-phase spend in dashboard |
| Parallel implementers collide | Path-scoped task partitioning at plan time; integrator owns conflicts; planner penalizes overlapping scopes |
| Flaky CI blocks pipeline | Flake detector (re-run ×3, quarantine tag); gate distinguishes flaky from broken |
| Question fatigue | Assumable-vs-blocking taxonomy, visible defaults, project memory prevents repeats; questions-per-engagement tracked in evals |
| Over-trusting agent prose | Structural: conductor reads artifacts only; auditor re-verifies every report sentence |
| SDK lock-in | `AgentRuntime` port; upper layers SDK-agnostic |

## 8. Decisions taken by default — flag if wrong

1. **Build on the Claude Agent SDK in TypeScript** rather than a from-scratch model loop. From-scratch buys control, costs months; the port layer keeps the door open. *(Biggest fork in the road — say the word for raw-API.)*
2. **Never auto-deploys to production.** Staging is the ceiling; prod is always a human click.
3. **Git-centric:** assumes a repo + worktrees. PR creation is an optional flag (needs GitHub token).
4. **Local-first:** no server, no database in v1.

## 9. Questions for you

1. Should finished work be pushed as branches + PRs automatically, or left on disk for you to review first? *(Default: leave on disk; `/push` when you say so.)*
2. Budget ceiling per engagement? *(Default: soft-warn $10, hard-stop $25 — configurable.)*
3. Which real repo should be the first eval target? *(Ideal: a small project of yours with existing tests.)*
