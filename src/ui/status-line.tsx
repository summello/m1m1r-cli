import React from 'react';
import { Box, Text } from 'ink';
import { renderMiniStatusline } from './statusline.js';
import type { UiState } from './store.js';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

export interface StatusLineProps {
  state: UiState;
  width?: number;
  projectPath?: string;
  now?: number;
}

function shortenPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

export function StatusLine({ state, width, projectPath = process.cwd() }: StatusLineProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const engagementStarted =
    state.tasksSeen || state.agentsSeen || state.budgetSeen || state.usageSeen ||
    state.busy || state.phase !== 'INTAKE';

  if (terminal.width < 70) {
    return <Text wrap="truncate-end">{renderMiniStatusline(state)}</Text>;
  }

  const contextTokens = state.usageTotals.promptTokens + state.usageTotals.completionTokens;
  const left: string[] = [shortenPath(projectPath)];
  if (state.branch) left.push(`${state.branch}${state.dirty ? '*' : ''}`);

  const right: string[] = [];
  if (engagementStarted) {
    right.push(`${state.paused ? 'Ⅱ' : '▶'}${state.phase}`);
    if (state.tasksSeen) right.push(`${state.tasksDone}/${state.tasksTotal}`);
    if (state.usageSeen) {
      right.push(state.ctxPct === null
        ? formatTokens(contextTokens)
        : `${formatTokens(contextTokens)} (${state.ctxPct}%)`);
    }
    if (state.budgetSeen) right.push(`$${state.budget.spentUsd.toFixed(2)}`);
  }
  right.push(`${state.mode} · ${state.provider}`);

  const flags =
    (state.blockingQuestions > 0 ? `⚠${state.blockingQuestions}Q  ` : '') +
    (state.gateFailed ? 'gate failed  ' : '');
  const rightText = right.join('  ');
  // Fit by construction: flexbox alone lets both sides overflow the row.
  const available = Math.max(0, terminal.width - flags.length - rightText.length - 2);
  const leftText = left.join('  ').slice(-available);
  const gap = ' '.repeat(Math.max(1, available - leftText.length + 2));

  return (
    <Box width={terminal.width}>
      <Text dimColor={dimmable()}>{leftText}</Text>
      <Text>{gap}</Text>
      {flags && <Text color={tokenColor('alert')}>{flags}</Text>}
      <Text dimColor={dimmable()}>{rightText}</Text>
    </Box>
  );
}
