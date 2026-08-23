import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { AgentTree } from './agent-tree.js';
import { DiffReceipt } from './diff-receipt.js';
import { QuestionCard } from './question-card.js';
import { Repl, type ReplProps } from './repl.js';
import { StatusLine } from './status-line.js';
import type { UiStore } from './store.js';
import { WelcomePanel, type WelcomePanelProps } from './welcome-panel.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor } from './theme.js';

export interface CockpitProps extends Pick<WelcomePanelProps,
  'version' | 'userName' | 'projectPath' | 'resumedEngagementId'> {
  store: UiStore;
  width?: number;
  showWelcome?: boolean;
  interactive?: boolean;
  onAnswer?: (questionId: string, answer: string) => void | Promise<void>;
  onCommand?: ReplProps['onCommand'];
  onShell?: ReplProps['onShell'];
  onPrompt?: ReplProps['onPrompt'];
}

export function Cockpit({
  store,
  width,
  showWelcome = true,
  interactive = true,
  version,
  userName,
  projectPath,
  resumedEngagementId,
  onAnswer = () => {},
  onCommand,
  onShell,
  onPrompt,
}: CockpitProps): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const terminal = useTerminalSize(width);
  const [welcomeVisible, setWelcomeVisible] = useState(showWelcome);
  useEffect(() => {
    if (terminal.height < 12) setWelcomeVisible(false);
  }, [terminal.height]);
  const questionOpen = state.questions.length > 0;
  const recentDiffs = state.diffs.slice(-3);
  const recentTests = state.tests.slice(-3);

  return (
    <Box flexDirection="column" width={terminal.width}>
      {welcomeVisible && (
        <WelcomePanel
          state={state}
          width={terminal.width}
          version={version}
          userName={userName}
          projectPath={projectPath}
          resumedEngagementId={resumedEngagementId}
        />
      )}
      {state.streams.slice(-3).map((stream) => (
        <Text key={stream.id} wrap="wrap">
          <Text color={tokenColor('orchid')}>{stream.role} › </Text>{stream.text}
          {stream.streaming && <Text color={tokenColor('nebula')}>▌</Text>}
        </Text>
      ))}
      <AgentTree agents={state.agents} width={terminal.width} />
      {state.questions.map((question, index) => (
        <QuestionCard
          key={question.id}
          question={question}
          onAnswer={onAnswer}
          width={terminal.width}
          isActive={interactive && index === 0}
        />
      ))}
      {(recentDiffs.length > 0 || recentTests.length > 0) && (
        <Box flexDirection="column">
          <Text color={tokenColor('orchid')} bold>RECEIPTS</Text>
          {recentDiffs.map((diff, index) => <DiffReceipt key={`d-${index}-${diff.file}`} diff={diff} width={terminal.width} />)}
          {recentTests.map((test, index) => <DiffReceipt key={`t-${index}-${test.cmd}`} test={test} width={terminal.width} />)}
        </Box>
      )}
      <StatusLine state={state} width={terminal.width} />
      {interactive && (
        <Repl
          width={terminal.width}
          isActive={!questionOpen}
          onCommand={onCommand}
          onShell={onShell}
          onPrompt={onPrompt}
        />
      )}
    </Box>
  );
}
