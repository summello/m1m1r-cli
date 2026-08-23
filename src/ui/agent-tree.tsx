import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AgentView } from './store.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor, type TokenName } from './theme.js';

const SPINNER = ['·', '•', '●', '•'];

export interface AgentTreeProps {
  agents: AgentView[];
  width?: number;
  frame?: number;
}

export function AgentTree({ agents, width, frame: fixedFrame }: AgentTreeProps): React.JSX.Element | null {
  const terminal = useTerminalSize(width);
  const [frame, setFrame] = useState(fixedFrame ?? 0);
  useEffect(() => {
    if (fixedFrame !== undefined) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [fixedFrame]);
  if (!agents.length) return null;
  return (
    <Box flexDirection="column" width={terminal.width}>
      <Text color={tokenColor('orchid')} bold>AGENTS</Text>
      {agents.map((agent, index) => {
        const marker = agent.status === 'running' ? SPINNER[frame % SPINNER.length] : agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : '○';
        const color: TokenName = agent.status === 'running' ? 'nebula' : agent.status === 'done' ? 'ok' : agent.status === 'failed' ? 'alert' : 'dim';
        return (
          <Text key={agent.id} wrap="truncate-end">
            <Text dimColor>{index === agents.length - 1 ? '└─' : '├─'}</Text>{' '}
            <Text color={tokenColor(color)}>{marker} {agent.role}</Text>{' '}
            <Text dimColor>#{agent.id}</Text> {agent.task}
          </Text>
        );
      })}
    </Box>
  );
}
