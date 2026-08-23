import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { renderMiniStatusline } from './statusline.js';
import type { UiState } from './store.js';
import { useTerminalSize } from './dimensions.js';
import { GradientBox } from './gradient-box.js';
import { BudgetBar, Gauge } from './gauge.js';
import { PhasePipeline } from './phase-pipeline.js';
import { tokenColor } from './theme.js';

export interface StatusLineProps {
  state: UiState;
  width?: number;
  now?: number;
}

export function StatusLine({ state, width, now: fixedNow }: StatusLineProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const [clock, setClock] = useState(fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  const usageStale = state.lastUsageUpdate > 0 && now - state.lastUsageUpdate > 5000;
  const agentsStale = state.lastAgentUpdate > 0 && now - state.lastAgentUpdate > 5000;
  const tasks = state.tasksSeen ? `${state.tasksDone}/${state.tasksTotal}` : '—';
  const agents = state.agentsSeen ? `●${state.agentsActive} ○${state.agentsIdle}` : '—';
  const question = state.blockingQuestions ? ` ⚠${state.blockingQuestions}Q` : '';
  const engagementStarted =
    state.tasksSeen || state.agentsSeen || state.budgetSeen || state.usageSeen ||
    state.busy || state.phase !== 'INTAKE';

  if (!engagementStarted) {
    return <Text dimColor>{'no active engagement — run m1m1r "<requirement>" or /plan'}</Text>;
  }

  if (terminal.width < 70) {
    return <Text wrap="truncate-end">{renderMiniStatusline(state)}</Text>;
  }

  if (terminal.width < 110) {
    const budget = state.budgetSeen ? `$${state.budget.spentUsd.toFixed(2)}/${state.budget.ceilingUsd}` : `—/${state.budget.ceilingUsd}`;
    return (
      <GradientBox title="STATUS" width={terminal.width}>
        <Text wrap="truncate-end">
          <Text color={tokenColor('nebula')}>{state.paused ? 'Ⅱ' : '▶'}{state.phase}</Text>
          {` ${tasks} │ agents ${agents}`}
          <Text color={tokenColor('alert')}>{question}</Text>
        </Text>
        <Text wrap="truncate-end">
          {state.model ?? '—'} · {state.effort} │ {budget} │ ctx{state.ctxPct === null ? '—' : `${state.ctxPct}%`} │ {state.mode} · {state.provider} │ {state.branch ?? '—'}
          <Text color={tokenColor('alert')}>{question}</Text>
        </Text>
      </GradientBox>
    );
  }

  const contentWidth = Math.max(1, terminal.width - 4);
  const budgetWidth = Math.max(12, Math.floor(contentWidth * 0.36));
  const ctxWidth = Math.max(8, Math.floor(contentWidth * 0.15));
  return (
    <GradientBox title="COCKPIT" width={terminal.width}>
      <Box flexDirection="column">
        <Text color={tokenColor('violet')} bold>ENGAGEMENT <Text color={tokenColor('alert')}>{question}</Text></Text>
        <PhasePipeline phase={state.phase} width={contentWidth} paused={state.paused} failed={state.gateFailed} />
        {(state.tasksSeen || state.agentsSeen) && (
          <Text dimColor={agentsStale}>tasks {tasks} │ agents {agents}<Text color={tokenColor('alert')}>{question}</Text></Text>
        )}
      </Box>
      {(state.budgetSeen || state.usageSeen) && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={tokenColor('nebula')} bold>SESSION <Text color={tokenColor('alert')}>{question}</Text></Text>
          <Box>
            <Text wrap="truncate-end">{state.model ?? '—'} · {state.effort} │ </Text>
            <BudgetBar
              spent={state.budgetSeen ? state.budget.spentUsd : null}
              ceiling={state.budget.ceilingUsd}
              width={budgetWidth}
              stale={usageStale}
            />
            <Text dimColor={usageStale}> │ ↑{state.usageSeen ? formatTokens(state.usageTotals.promptTokens) : '—'} ↓{state.usageSeen ? formatTokens(state.usageTotals.completionTokens) : '—'} │ </Text>
            <Gauge value={state.ctxPct} label="ctx" width={ctxWidth} stale={usageStale} />
            <Text color={tokenColor('alert')}>{question}</Text>
          </Box>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text color={tokenColor('violet')} bold>CONTROL <Text color={tokenColor('alert')}>{question}</Text></Text>
        <Text wrap="truncate-end">
          {state.mode} │ {state.provider}·{state.account} │ {state.branch ?? '—'}{state.dirty ? '*' : ''} wt:{state.worktree} │ 5h {formatCost(state.fiveHourCost)} │ 7d {formatCost(state.sevenDayCost)}
          <Text color={tokenColor('alert')}>{question}</Text>
        </Text>
      </Box>
      <Text dimColor>»» /model · /questions · /budget · /agents · /pause · /redirect · ! shell</Text>
    </GradientBox>
  );
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatCost(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}
