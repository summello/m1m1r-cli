// Phase 0 single-line statusline (PLAN §6 Phase 0: `phase │ $ │ ctx%`). Full
// three-row responsive statusline (PLAN §3.7.4) is Phase 4 — Ink not needed
// for one line, so this stays a plain stdout rewrite until then.

import { fg } from './theme.js';
import type { UiState } from './store.js';

export function renderMiniStatusline(s: UiState): string {
  const budgetColor = s.budget.level === 'stop' ? 'alert' : s.budget.level === 'warn' ? 'warn' : 'ok';
  const budget = `$${s.budget.spentUsd.toFixed(2)}/$${s.budget.ceilingUsd}`;
  const ctx = s.ctxPct === null ? '—' : `${s.ctxPct}%`;
  const q = s.blockingQuestions > 0 ? ` │ ${fg('alert', `⚠ ${s.blockingQuestions}`)}` : '';
  return `${fg('nebula', s.phase)} │ ${fg(budgetColor, budget)} │ ctx ${ctx}${q}`;
}

/** Redraw the statusline in place on the current terminal line. */
export function writeStatusline(s: UiState): void {
  process.stdout.write(`\r\x1b[K${renderMiniStatusline(s)}`);
}
