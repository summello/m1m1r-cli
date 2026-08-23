import React from 'react';
import { Box, Text } from 'ink';
import type { UiState } from './store.js';
import { galaxyGlyph } from './logo.js';
import { ResumeStrip } from './resume-strip.js';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

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
  const commandWidth = Math.max(...STARTERS.map(([command]) => command.length)) + 3;
  return (
    <Box flexDirection="column" width={terminal.width}>
      <Text>
        <Text color={tokenColor('nebula')}>{galaxyGlyph()} m1m1r</Text>
        <Text dimColor={dimmable()}>  v{version}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor={dimmable()} wrap="truncate-end">
          {userName} · {state.model ?? 'no model'} · {state.effort} · {state.provider}
        </Text>
        <Text dimColor={dimmable()} wrap="truncate-start">{projectPath}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={tokenColor('orchid')}>Get started</Text>
        {STARTERS.map(([command, description]) => (
          <Text key={command} wrap="truncate-end">
            {'  '}{command.padEnd(commandWidth)}<Text dimColor={dimmable()}>{description}</Text>
          </Text>
        ))}
      </Box>
      {resumedEngagementId && (
        <Box marginTop={1}>
          <ResumeStrip state={state} engagementId={resumedEngagementId} width={terminal.width} />
        </Box>
      )}
    </Box>
  );
}
