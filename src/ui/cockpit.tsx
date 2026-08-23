import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text } from 'ink';
import { AgentTree } from './agent-tree.js';
import { DiffReceipt } from './diff-receipt.js';
import { PhasePipeline } from './phase-pipeline.js';
import { QuestionCard } from './question-card.js';
import { Repl, type ReplProps } from './repl.js';
import { Sidebar } from './sidebar.js';
import { StatusLine } from './status-line.js';
import type { UiStore } from './store.js';
import { WelcomePanel, type WelcomePanelProps } from './welcome-panel.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor } from './theme.js';

const RAIL_WIDTH = 30;
const RAIL_MIN_TERMINAL = 100;

export interface CockpitProps extends Pick<WelcomePanelProps,
  'version' | 'userName' | 'projectPath' | 'resumedEngagementId'> {
  store: UiStore;
  width?: number;
  showWelcome?: boolean;
  interactive?: boolean;
  repoPaths?: readonly string[];
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
  projectPath = process.cwd(),
  resumedEngagementId,
  repoPaths,
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
  const railVisible = terminal.width >= RAIL_MIN_TERMINAL;
  const mainWidth = railVisible ? terminal.width - RAIL_WIDTH : terminal.width;
  const engagementStarted =
    state.tasksSeen || state.agentsSeen || state.budgetSeen || state.usageSeen ||
    state.busy || state.phase !== 'INTAKE';

  return (
    <Box flexDirection="column" width={terminal.width}>
      <Box flexDirection="row" width={terminal.width}>
        <Box flexDirection="column" width={mainWidth}>
          {welcomeVisible && !engagementStarted && (
            <WelcomePanel
              state={state}
              width={mainWidth}
              version={version}
              userName={userName}
              projectPath={projectPath}
              resumedEngagementId={resumedEngagementId}
            />
          )}
          {engagementStarted && (
            <Box>
              <PhasePipeline
                phase={state.phase}
                width={mainWidth}
                paused={state.paused}
                failed={state.gateFailed}
              />
            </Box>
          )}
          {state.streams.slice(-3).map((stream) => (
            <Text key={stream.id} wrap="wrap">
              <Text color={tokenColor('orchid')}>{stream.role} › </Text>{stream.text}
              {stream.streaming && <Text color={tokenColor('nebula')}>▌</Text>}
            </Text>
          ))}
          {state.agents.length > 0 && (
            <Box marginTop={1}>
              <AgentTree agents={state.agents} width={mainWidth} />
            </Box>
          )}
          {state.questions.map((question, index) => (
            <QuestionCard
              key={question.id}
              question={question}
              onAnswer={onAnswer}
              width={mainWidth}
              isActive={interactive && index === 0}
            />
          ))}
          {(recentDiffs.length > 0 || recentTests.length > 0) && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={tokenColor('orchid')}>Receipts</Text>
              {recentDiffs.map((diff, index) => <DiffReceipt key={`d-${index}-${diff.file}`} diff={diff} width={mainWidth} />)}
              {recentTests.map((test, index) => <DiffReceipt key={`t-${index}-${test.cmd}`} test={test} width={mainWidth} />)}
            </Box>
          )}
        </Box>
        {railVisible && (
          <Sidebar state={state} width={RAIL_WIDTH} projectPath={projectPath} paths={repoPaths} />
        )}
      </Box>
      {interactive && (
        <Box marginTop={1}>
          <Repl
            width={terminal.width}
            isActive={!questionOpen}
            onCommand={onCommand}
            onShell={onShell}
            onPrompt={onPrompt}
          />
        </Box>
      )}
      <StatusLine state={state} width={terminal.width} projectPath={projectPath} />
    </Box>
  );
}
