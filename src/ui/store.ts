// Live UI state store — single source of truth for the statusline (PLAN §3.7.5).
// Conductor + agent events flow in; useSyncExternalStore reads out.

import type { BudgetLevel, JournalEvent, Phase, Usage } from '../conductor/conductor.js';

export interface UiState {
  phase: Phase;
  tasksDone: number;
  tasksTotal: number;
  agentsActive: number;
  agentsIdle: number;
  budget: BudgetLevel;
  usageTotals: { promptTokens: number; completionTokens: number };
  ctxPct: number | null; // null until first real usage event (never a fake zero)
  model: string | null;
  effort: string;
  mode: string;
  provider: string;
  branch: string | null;
  dirty: boolean;
  worktree: string;
  blockingQuestions: number;
  busy: boolean;
  lastUpdate: number;
}

export const INITIAL_UI_STATE: UiState = {
  phase: 'INTAKE',
  tasksDone: 0,
  tasksTotal: 0,
  agentsActive: 0,
  agentsIdle: 0,
  budget: { spentUsd: 0, ceilingUsd: 25, level: 'ok' },
  usageTotals: { promptTokens: 0, completionTokens: 0 },
  ctxPct: null,
  model: null,
  effort: 'high',
  mode: 'semi',
  provider: 'openrouter',
  branch: null,
  dirty: false,
  worktree: 'primary',
  blockingQuestions: 0,
  busy: false,
  lastUpdate: 0,
};

export class UiStore {
  private state: UiState = INITIAL_UI_STATE;
  private subs = new Set<() => void>();
  private ctxWindow = 128_000;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  getSnapshot = (): UiState => this.state;

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch, lastUpdate: Date.now() };
    for (const fn of this.subs) fn();
  }

  setCtxWindow(tokens: number): void {
    if (tokens > 0) this.ctxWindow = tokens;
  }

  /** Feed a journal event; statusline fields update from real events only. */
  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'PHASE':
      case 'SKIPPED':
        this.set({ phase: ev.phase });
        break;
      case 'PLAN': {
        const steps = (ev.payload as unknown[] | undefined)?.length ?? 0;
        this.set({ tasksTotal: steps, tasksDone: 0 });
        break;
      }
      case 'RECEIPTS': {
        const rs = (ev.payload as Array<{ exit: number | null }> | undefined) ?? [];
        this.set({ tasksDone: rs.filter((r) => r.exit === 0).length });
        break;
      }
      case 'GATE_RESULT':
        this.set({ phase: ev.phase });
        break;
      case 'USAGE': {
        const p = ev.payload as { usage: Usage; model?: string };
        const totals = {
          promptTokens: this.state.usageTotals.promptTokens + p.usage.prompt_tokens,
          completionTokens: this.state.usageTotals.completionTokens + p.usage.completion_tokens,
          prompt_tokens: 0,
          completion_tokens: 0,
        };
        const ctx = totals.promptTokens + totals.completionTokens;
        this.set({
          usageTotals: totals,
          ctxPct: Math.min(100, Math.round((ctx / this.ctxWindow) * 100)),
          model: p.model ?? this.state.model,
        });
        break;
      }
      case 'BUDGET_UPDATE':
        this.set({ budget: ev.payload as BudgetLevel });
        break;
      case 'QUESTION_RAISED':
        this.set({ blockingQuestions: this.state.blockingQuestions + 1 });
        break;
      case 'QUESTION_ANSWERED':
        this.set({ blockingQuestions: Math.max(0, this.state.blockingQuestions - 1) });
        break;
      case 'PARK':
      case 'COMPLETE':
        this.set({ busy: false, phase: ev.phase });
        break;
      default:
        break;
    }
  }
}
