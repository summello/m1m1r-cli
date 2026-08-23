import React from 'react';
import { Text } from 'ink';
import type { UiState } from './store.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor } from './theme.js';

export interface ResumeStripProps {
  state: UiState;
  engagementId: string;
  width?: number;
}

export function ResumeStrip({ state, engagementId, width }: ResumeStripProps): React.JSX.Element {
  useTerminalSize(width);
  const tasks = state.tasksSeen ? `${state.tasksDone}/${state.tasksTotal} tasks` : 'tasks —';
  const agents = state.agentsSeen ? `agents ●${state.agentsActive}○${state.agentsIdle}` : 'agents —';
  const budget = state.budgetSeen ? `$${state.budget.spentUsd.toFixed(2)}/$${state.budget.ceilingUsd}` : `$—/$${state.budget.ceilingUsd}`;
  return (
    <Text wrap="truncate-end">
      <Text color={tokenColor('violet')}>↻ #{engagementId}</Text> · {state.phase} · {tasks} · {agents} · {budget}
      {state.blockingQuestions > 0 && <Text color={tokenColor('alert')}> · ⚠ {state.blockingQuestions} blocking Q</Text>}
    </Text>
  );
}
