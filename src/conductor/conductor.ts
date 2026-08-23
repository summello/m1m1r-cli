// Conductor core (PLAN §3.1, §3.3, §3.4): phase state machine + append-only
// JSONL journal with resume + budget governor. Every transition is journaled;
// state rebuilds by replay.

import { randomUUID } from 'node:crypto';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Redactor } from '../security/redact.js';
import { makeEvidence, type Evidence, type EvidenceSource } from '../truth/evidence.js';
import { auditReport, survivalRate, type AuditResult } from '../truth/auditor.js';

export type Phase =
  | 'INTAKE'
  | 'CLARIFY'
  | 'RESEARCH'
  | 'PLAN'
  | 'APPROVE'
  | 'EXECUTE'
  | 'VERIFY'
  | 'INTEGRATE'
  | 'REPORT'
  | 'PARKED'
  | 'DONE';

export interface JournalEvent {
  ts: number;
  id: string;
  phase: Phase;
  event: string;
  payload?: unknown;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface BudgetLevel {
  spentUsd: number;
  ceilingUsd: number;
  level: 'ok' | 'warn' | 'stop';
}

export type Subscriber = (ev: JournalEvent) => void;

/** Append-only JSONL journal. Replays into a snapshot on load.
 * Every line written to disk is redacted (constitution.md: "Redact before a
 * value reaches a journal entry... not after") — the in-memory copy used by
 * the rest of this process for the current run keeps the real values; only
 * the on-disk copy, and therefore anything read back on a future resume, is
 * scrubbed. A default `new Redactor()` still applies the static secret
 * patterns even when the caller doesn't register a runtime secret. */
export class Journal {
  readonly path: string;
  private events: JournalEvent[] = [];

  private constructor(
    path: string,
    private redactor: Redactor,
  ) {
    this.path = path;
  }

  static async open(path: string, redactor: Redactor = new Redactor()): Promise<Journal> {
    const j = new Journal(path, redactor);
    try {
      const raw = await readFile(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          j.events.push(JSON.parse(line) as JournalEvent);
        } catch {
          // A kill -9 mid-append leaves a torn trailing line — skip it and
          // keep resuming from everything that did flush, don't crash resume
          // on exactly the failure mode journaling exists to survive.
          console.error(`m1m1r: skipping malformed journal line in ${path}`);
        }
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return j;
  }

  get eventsAll(): readonly JournalEvent[] {
    return this.events;
  }

  async append(phase: Phase, event: string, payload?: unknown): Promise<JournalEvent> {
    const ev: JournalEvent = { ts: Date.now(), id: randomUUID(), phase, event, payload };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, this.redactor.scrub(JSON.stringify(ev)) + '\n');
    this.events.push(ev);
    return ev;
  }
}

export interface TierBinding {
  provider: string;
  model: string;
}

export interface Config {
  budgetSoftWarnUsd: number;
  budgetHardStopUsd: number;
  prices: Record<string, { inPerM: number; outPerM: number }>;
  /** Tier alias (opus/sonnet/haiku, PLAN §4.1) -> provider/model. Read/written
   * by `m1m1r model ls|use` (§4.1's non-interactive twin to `/model`). */
  tiers?: Record<string, TierBinding>;
}

const DEFAULT_CONFIG: Config = {
  // Plan §8/Q2 defaults: soft-warn $10, hard-stop $25 per engagement.
  budgetSoftWarnUsd: 10,
  budgetHardStopUsd: 25,
  prices: {},
};

export async function loadConfig(path?: string): Promise<Config> {
  let cfg = { ...DEFAULT_CONFIG };
  if (!path) return cfg;
  try {
    cfg = { ...cfg, ...JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    /* missing config -> defaults */
  }
  return cfg;
}

/** Budget governor (PLAN §3.1). Warn at threshold, hard stop parks the engagement.
 * Pure math only — journaling/emitting BUDGET_UPDATE is Conductor.charge()'s job,
 * so every state change is emitted, not just the ones a phase transition happens
 * to follow (PLAN §3.7.4 "numbers never render before their first real event"). */
export class BudgetGovernor {
  spentUsd = 0;
  level: 'ok' | 'warn' | 'stop' = 'ok';
  constructor(private cfg: Config) {}

  charge(usage: Usage | undefined, model: string | undefined): BudgetLevel {
    if (!usage || !model) return { ...this.snapshot() };
    const price = this.cfg.prices[model];
    if (!price) return { ...this.snapshot() }; // unknown price -> no invented dollars
    const usd =
      (usage.prompt_tokens * price.inPerM + usage.completion_tokens * price.outPerM) / 1e6;
    return this.applyUsd(usd);
  }

  /** Charge a provider-billed dollar amount directly (e.g. the Claude Agent
   * SDK's `total_cost_usd`) — real cost, not a token×price estimate, so no
   * price-table entry is needed for that model at all. */
  chargeExact(usd: number): BudgetLevel {
    return this.applyUsd(usd);
  }

  private applyUsd(usd: number): BudgetLevel {
    this.spentUsd += usd;
    const ratio = this.spentUsd / this.cfg.budgetHardStopUsd;
    const next: 'ok' | 'warn' | 'stop' =
      ratio >= 1 ? 'stop' : this.spentUsd >= this.cfg.budgetSoftWarnUsd ? 'warn' : 'ok';
    if (next !== this.level) this.level = next;
    return { ...this.snapshot() };
  }

  snapshot(): BudgetLevel {
    return {
      spentUsd: round6(this.spentUsd),
      ceilingUsd: this.cfg.budgetHardStopUsd,
      level: this.level,
    };
  }

  shouldPark(): boolean {
    return this.level === 'stop';
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface PlannedTeamNode {
  id: string;
  scope: string[];
  acceptanceCriteria: string;
  dependsOn: string[];
  input: string;
}

export interface TeamNodeResult {
  id: string;
  ok: boolean;
  text: string;
}

export interface OpenQuestion {
  id: string;
  blocking: boolean;
  questionLayman: string;
  example?: string;
  proposedDefault?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

export type ConductorState = {
  id: string;
  phase: Phase;
  requirement?: string;
  planSteps?: Array<{ desc: string; file?: string; content?: string; shell?: string }>;
  receipts?: Array<{ cmd: string; exit: number | null; outputRef: string }>;
  report?: string;
  budget: BudgetLevel;
  usageTotals: { promptTokens: number; completionTokens: number };
  blockingQuestion?: unknown;
  openQuestions: OpenQuestion[];
  paused: boolean;
  taskRedirects: Record<string, string>;
  // Team/DAG engagement state (PLAN §6 Phase 1) — kept separate from
  // planSteps/receipts above (Phase 0's single-agent shape) rather than
  // reusing those fields for a structurally different flow.
  teamNodes?: PlannedTeamNode[];
  teamResults?: TeamNodeResult[];
  // ponytail: the journal is the evidence store. PLAN §3.4 sketches a separate
  // `evidence/` directory, but a second on-disk copy of what the journal
  // already holds buys nothing and can disagree with it. Replayed below, so
  // evidence survives resume for free. Split it out if evidence ever needs
  // indexing the journal can't serve.
  evidence: Evidence[];
};

/** Phase state machine over an append-only journal. */
export class Conductor {
  state: ConductorState;
  readonly journal: Journal;
  private subs = new Set<Subscriber>();
  private governor: BudgetGovernor;
  private resumeWaiters = new Set<() => void>();

  private constructor(
    public readonly dir: string,
    journal: Journal,
    state: ConductorState,
    cfg: Config,
  ) {
    this.journal = journal;
    this.state = state;
    this.governor = new BudgetGovernor(cfg);
    this.state.budget = this.governor.snapshot();
  }

  /** Open existing engagement dir or create fresh one. Pass the process's own
   * Redactor (with runtime secrets like the API key registered) so journaled
   * events get exact-match scrubbing too, not just the static patterns. */
  static async open(dir: string, cfg?: Config, redactor?: Redactor): Promise<Conductor> {
    const journal = await Journal.open(`${dir}/journal.jsonl`, redactor);
    const config = cfg ?? (await loadConfig());
    const c = new Conductor(dir, journal, replay(journal), config);
    // Replay past usage through the governor so budget survives resume.
    for (const ev of journal.eventsAll) {
      if (ev.event === 'USAGE') {
        const p = ev.payload as { usage: Usage; model?: string; budgetExempt?: boolean };
        if (!p.budgetExempt) c.governor.charge(p.usage, p.model);
      } else if (ev.event === 'USAGE_USD') {
        c.governor.chargeExact((ev.payload as { usd: number }).usd);
      }
    }
    c.state.budget = c.governor.snapshot();
    return c;
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(ev: JournalEvent): void {
    for (const fn of this.subs) fn(ev);
  }

  /** Persist an engagement fact and publish the exact same event to live UI
   * subscribers. Artifact writers use this instead of calling Journal.append
   * directly so the journal remains the single source of truth without
   * making the cockpit poll the filesystem. */
  async record(event: string, payload?: unknown, phase: Phase = this.state.phase): Promise<JournalEvent> {
    const ev = await this.journal.append(phase, event, payload);
    this.emit(ev);
    return ev;
  }

  async transition(phase: Phase, event: string, payload?: unknown): Promise<void> {
    if (this.state.phase === 'PARKED' || this.state.phase === 'DONE') return;
    this.state.phase = phase;
    await this.record(event, payload, phase);
  }

  async pause(): Promise<void> {
    if (this.state.paused || this.state.phase === 'DONE') return;
    this.state.paused = true;
    await this.record('CONTROL_PAUSED');
  }

  async resumeRun(): Promise<void> {
    if (!this.state.paused) return;
    this.state.paused = false;
    await this.record('CONTROL_RESUMED');
    for (const resolve of this.resumeWaiters) resolve();
    this.resumeWaiters.clear();
  }

  async waitWhilePaused(): Promise<void> {
    while (this.state.paused) {
      await new Promise<void>((resolve) => this.resumeWaiters.add(resolve));
    }
  }

  async answerQuestion(id: string, answer: string): Promise<void> {
    const question = this.state.openQuestions.find((item) => item.id === id);
    if (!question) throw new Error(`unknown open question: ${id}`);
    this.state.openQuestions = this.state.openQuestions.filter((item) => item.id !== id);
    this.state.blockingQuestion = this.state.openQuestions.find((item) => item.blocking);
    await this.record('QUESTION_ANSWERED', { id, answer });
  }

  /** Record one Evidence object. Confidence is re-derived from the source here
   * rather than trusted from the caller — an agent that hands over
   * `confidence: "verified"` with no citation is the case this exists for. */
  async recordEvidence(id: string, claim: string, source?: EvidenceSource): Promise<Evidence> {
    const evidence = makeEvidence(id, claim, source);
    this.state.evidence.push(evidence);
    await this.record('EVIDENCE', evidence);
    return evidence;
  }

  /** Audit a report against everything recorded this engagement, journal the
   * audited text, and return it. Nothing reaches the human un-audited. */
  async auditAndRecordReport(report: string): Promise<AuditResult> {
    const result = auditReport(report, this.state.evidence);
    this.state.report = result.text;
    await this.record('REPORT', {
      text: result.text,
      struck: result.struckCount,
      survival: survivalRate(result),
    });
    return result;
  }

  async raiseQuestion(question: OpenQuestion): Promise<void> {
    if (this.state.openQuestions.some((item) => item.id === question.id)) return;
    this.state.openQuestions.push(question);
    if (question.blocking) this.state.blockingQuestion = question;
    await this.record('QUESTION_RAISED', question);
  }

  async redirectTask(id: string, instruction: string): Promise<void> {
    const known = this.state.teamNodes?.some((node) => node.id === id) ?? false;
    if (!known) throw new Error(`unknown task: ${id}`);
    this.state.taskRedirects[id] = instruction;
    await this.record('TASK_REDIRECTED', { id, instruction });
  }

  taskInput(id: string, original: string): string {
    const redirect = this.state.taskRedirects[id];
    return redirect ? `${original}\n\nHuman redirect: ${redirect}` : original;
  }

  // Awaited end to end, not fire-and-forget: a `kill -9` landing between
  // charge() returning and an un-awaited fs write finishing would lose that
  // USAGE event, so resume's budget total would silently undercount spend.
  async charge(usage: Usage, model?: string): Promise<BudgetLevel> {
    this.emit(await this.journal.append(this.state.phase, 'USAGE', { usage, model }));
    const lvl = this.governor.charge(usage, model);
    this.state.usageTotals.promptTokens += usage.prompt_tokens;
    this.state.usageTotals.completionTokens += usage.completion_tokens;
    this.state.budget = lvl;
    this.emit(await this.journal.append(this.state.phase, 'BUDGET_UPDATE', lvl));
    if (this.governor.shouldPark()) await this.park('budget hard stop');
    return lvl;
  }

  /** Records token counts for display/ctx% only — structurally never touches
   * budget, on write or on replay (the `budgetExempt` flag on the journaled
   * event, not an assumption about whether `cfg.prices` happens to lack an
   * entry for `model`). Use this alongside chargeUsd() for a provider that
   * bills an exact dollar amount per call (e.g. Anthropic's
   * `total_cost_usd`) — calling charge() for the same turn would double-bill
   * the moment someone populates a price-table entry for that model. */
  async recordUsage(usage: Usage, model?: string): Promise<void> {
    this.emit(await this.journal.append(this.state.phase, 'USAGE', { usage, model, budgetExempt: true }));
    this.state.usageTotals.promptTokens += usage.prompt_tokens;
    this.state.usageTotals.completionTokens += usage.completion_tokens;
  }

  /** Charge a provider-billed dollar amount directly, bypassing the
   * token×price estimate (e.g. Claude Agent SDK's `total_cost_usd`). Pair
   * with recordUsage() (not charge()) for token/display bookkeeping on the
   * same call — see recordUsage()'s doc for why. */
  async chargeUsd(usd: number): Promise<BudgetLevel> {
    const lvl = this.governor.chargeExact(usd);
    this.state.budget = lvl;
    this.emit(await this.journal.append(this.state.phase, 'USAGE_USD', { usd }));
    this.emit(await this.journal.append(this.state.phase, 'BUDGET_UPDATE', lvl));
    if (this.governor.shouldPark()) await this.park('budget hard stop');
    return lvl;
  }

  async park(reason: string): Promise<void> {
    await this.transition('PARKED', 'PARK', { reason });
  }

  async complete(): Promise<void> {
    await this.transition('DONE', 'COMPLETE');
  }
}

function replay(j: Journal): ConductorState {
  const s: ConductorState = {
    id: '',
    phase: 'INTAKE',
    budget: { spentUsd: 0, ceilingUsd: 25, level: 'ok' },
    usageTotals: { promptTokens: 0, completionTokens: 0 },
    openQuestions: [],
    paused: false,
    taskRedirects: {},
    evidence: [],
  };
  for (const ev of j.eventsAll) {
    if (!s.id) s.id = ev.id.slice(0, 8); // stable display id from first event
    // Every event's own `.phase` field already reflects the phase active
    // when it was journaled (transition() and every direct journal.append
    // call set it), so this alone tracks state correctly across ALL event
    // names — a switch keyed on event name here previously missed 'SKIPPED'
    // and 'AUTO_APPROVED', desyncing state.phase from what actually happened
    // and making resume re-run the intake block on every restart.
    s.phase = ev.phase;
    switch (ev.event) {
      case 'START':
        s.requirement = (ev.payload as { requirement: string }).requirement;
        break;
      case 'PLAN':
        s.planSteps = ev.payload as ConductorState['planSteps'];
        break;
      case 'RECEIPTS':
        s.receipts = ev.payload as ConductorState['receipts'];
        break;
      case 'TEAM_PLAN':
        s.teamNodes = ev.payload as ConductorState['teamNodes'];
        break;
      case 'TEAM_RESULTS':
        s.teamResults = ev.payload as ConductorState['teamResults'];
        break;
      case 'REPORT':
        s.report = (ev.payload as { text: string }).text;
        break;
      case 'EVIDENCE':
        s.evidence.push(ev.payload as Evidence);
        break;
      case 'QUESTION_RAISED':
        s.openQuestions.push(ev.payload as OpenQuestion);
        if ((ev.payload as OpenQuestion).blocking) s.blockingQuestion = ev.payload;
        break;
      case 'QUESTION_ANSWERED':
        s.openQuestions = s.openQuestions.filter(
          (question) => question.id !== (ev.payload as { id: string }).id,
        );
        s.blockingQuestion = s.openQuestions.find((question) => question.blocking);
        break;
      case 'CONTROL_PAUSED':
        s.paused = true;
        break;
      case 'CONTROL_RESUMED':
        s.paused = false;
        break;
      case 'TASK_REDIRECTED': {
        const redirect = ev.payload as { id: string; instruction: string };
        s.taskRedirects[redirect.id] = redirect.instruction;
        break;
      }
      default:
        break;
    }
  }
  return s;
}

export function newEngagementId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8);
}
