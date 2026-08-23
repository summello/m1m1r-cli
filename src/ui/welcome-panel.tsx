import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { UiState } from './store.js';
import { galaxyFull, galaxyGlyph, GALAXY_WIDTH } from './logo.js';
import { wordmark, wordmarkWidth } from './wordmark.js';
import { ResumeStrip } from './resume-strip.js';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

const QUICK_COMMANDS = '/model  /plan  /questions  /agents  /pause  /redirect';

const STARTERS: Array<[string, string]> = [
  ['m1m1r "<requirement>"', 'start an engagement'],
  ['/plan', 'plan without executing'],
  ['/init', 'write M1M1R.md conventions'],
  ['/help', 'all commands'],
];

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
  const markFits = terminal.width >= GALAXY_WIDTH + wordmarkWidth() + 6;
  const stacked = terminal.width < 78;
  const commandWidth = Math.max(...STARTERS.map(([command]) => command.length)) + 3;
  const columnWidth = stacked ? terminal.width : Math.floor(terminal.width / 2) - 2;

  const identity = (
    <Box flexDirection="column" width={columnWidth}>
      <Text>Welcome back, <Text color={tokenColor('nebula')}>{userName}</Text>.</Text>
      <Text dimColor={dimmable()} wrap="truncate-end">
        {state.model ?? 'no model'} · {state.effort} · {state.provider} ({state.account})
      </Text>
      <Text color={tokenColor('violet')} wrap="truncate-start">{projectPath}</Text>
      <Text dimColor={dimmable()} wrap="truncate-end">
        {basename(projectPath)} · {state.branch ?? 'no branch'}{state.dirty ? '*' : ''} · wt:{state.worktree}
      </Text>
    </Box>
  );

  const guide = (
    <Box flexDirection="column" width={columnWidth} marginTop={stacked ? 1 : 0}>
      <Text color={tokenColor('orchid')}>Get started</Text>
      {STARTERS.map(([command, description]) => (
        <Text key={command} wrap="truncate-end">
          {'  '}{command.padEnd(commandWidth)}<Text dimColor={dimmable()}>{description}</Text>
        </Text>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text color={tokenColor('orchid')}>What’s new</Text>
        <Text dimColor={dimmable()} wrap="truncate-end">
          Live agent steering, receipts, and a budget-aware cockpit.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={tokenColor('orchid')}>Quick commands</Text>
        <Text dimColor={dimmable()} wrap="truncate-end">{QUICK_COMMANDS}</Text>
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" width={terminal.width}>
      {markFits ? (
        <Box flexDirection="row">
          <Box flexDirection="column" width={GALAXY_WIDTH + 3}>
            {galaxyFull().map((line, index) => <Text key={index}>{line}</Text>)}
          </Box>
          <Box flexDirection="column">
            {wordmark().map((line, index) => <Text key={index}>{line}</Text>)}
          </Box>
          <Box marginLeft={2}>
            <Text dimColor={dimmable()}>v{version}</Text>
          </Box>
        </Box>
      ) : (
        <Text>
          <Text color={tokenColor('nebula')}>{galaxyGlyph()} m1m1r</Text>
          <Text dimColor={dimmable()}>  v{version}</Text>
        </Text>
      )}
      <Box marginTop={1} flexDirection={stacked ? 'column' : 'row'} justifyContent="space-between">
        {identity}{guide}
      </Box>
      {resumedEngagementId && (
        <Box marginTop={1}>
          <ResumeStrip state={state} engagementId={resumedEngagementId} width={terminal.width} />
        </Box>
      )}
    </Box>
  );
}
