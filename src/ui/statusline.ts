// Phase 0 single-line statusline, retained as Phase 4's <70-column fallback.

import { fg } from './theme.js';
import type { UiState } from './store.js';

export function renderMiniStatusline(s: UiState): string {
  const budgetColor = s.budget.level === 'stop' ? 'alert' : s.budget.level === 'warn' ? 'warn' : 'ok';
  const budget = s.budgetSeen
    ? `$${s.budget.spentUsd.toFixed(2)}/$${s.budget.ceilingUsd}`
    : `—/$${s.budget.ceilingUsd}`;
  const ctx = s.ctxPct === null ? '—' : `${s.ctxPct}%`;
  const task = s.tasksSeen ? ` ${s.tasksDone}/${s.tasksTotal}` : '';
  const q = s.blockingQuestions > 0 ? ` │ ${fg('alert', `⚠${s.blockingQuestions}Q`)}` : '';
  const marker = s.paused ? 'Ⅱ' : '▶';
  return `${marker}${fg('nebula', s.phase)}${task} │ ${fg(budgetColor, budget)} │ ctx${ctx}${q}`;
}

/** Redraw the statusline in place on the current terminal line. */
export function writeStatusline(s: UiState): void {
  process.stdout.write(`\r\x1b[K${renderMiniStatusline(s)}`);
}
