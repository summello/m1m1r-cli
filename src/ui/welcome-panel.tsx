import React from 'react';
import { Box, Text } from 'ink';
import type { UiState } from './store.js';
import { GalaxyLogo } from './galaxy-logo.js';
import { GradientBox } from './gradient-box.js';
import { ResumeStrip } from './resume-strip.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor } from './theme.js';

export interface WelcomePanelProps {
  state: UiState;
  width?: number;
  version?: string;
  userName?: string;
  projectPath?: string;
  resumedEngagementId?: string;
}

export function WelcomePanel({
  state,
  width,
  version = '0.1.0',
  userName = 'engineer',
  projectPath = process.cwd(),
  resumedEngagementId,
}: WelcomePanelProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const stacked = terminal.width < 90;
  const contentWidth = Math.max(1, terminal.width - 4);
  const columnWidth = stacked ? contentWidth : Math.floor((contentWidth - 3) / 2);
  const identity = (
    <Box flexDirection="column" width={columnWidth}>
      <GalaxyLogo size={stacked ? 'compact' : 'full'} width={columnWidth} />
      <Text bold>Welcome back, <Text color={tokenColor('nebula')}>{userName}</Text>.</Text>
      <Text color={tokenColor('nebula')}>{state.model ?? 'model —'} · {state.effort} · {state.provider} ({state.account})</Text>
      <Text color={tokenColor('violet')} wrap="truncate-end">{projectPath}</Text>
      <Text>{state.branch ?? 'branch —'}{state.dirty ? '*' : ''}</Text>
    </Box>
  );
  const guide = (
    <Box flexDirection="column" width={columnWidth} marginTop={stacked ? 1 : 0}>
      <Text color={tokenColor('orchid')} bold>Tips for getting started</Text>
      <Text>Run /init to write M1M1R.md — conventions the whole team reads.</Text>
      <Text dimColor>{'─'.repeat(Math.max(1, columnWidth))}</Text>
      <Text color={tokenColor('orchid')} bold>What’s new</Text>
      <Text>Live agent steering, receipts, and a budget-aware cockpit.</Text>
      <Text dimColor>{'─'.repeat(Math.max(1, columnWidth))}</Text>
      <Text color={tokenColor('orchid')} bold>Quick commands</Text>
      <Text>/model  /plan  /questions  /agents  /pause  /redirect</Text>
    </Box>
  );
  return (
    <GradientBox title={`m1m1r v${version}`} width={terminal.width}>
      <Box flexDirection={stacked ? 'column' : 'row'} justifyContent="space-between">
        {identity}{guide}
      </Box>
      {resumedEngagementId && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(contentWidth)}</Text>
          <ResumeStrip state={state} engagementId={resumedEngagementId} width={contentWidth} />
        </Box>
      )}
    </GradientBox>
  );
}
