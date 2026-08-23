import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTerminalSize } from './dimensions.js';
import { gradient, tokenColor } from './theme.js';

export interface GradientBoxProps {
  children: ReactNode;
  title?: string;
  width?: number;
  paddingX?: number;
}

export function GradientBox({ children, title, width, paddingX = 1 }: GradientBoxProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const innerWidth = Math.max(1, terminal.width - 2);
  const label = title ? `─ ${title} ` : '─';
  const top = `╭${label}${'─'.repeat(Math.max(0, innerWidth - label.length))}╮`;
  return (
    <Box flexDirection="column" width={terminal.width}>
      <Text>{gradient('nebula', 'violet', top)}</Text>
      <Box
        width={terminal.width}
        flexDirection="column"
        borderStyle="round"
        borderTop={false}
        borderColor={tokenColor('chrome')}
        paddingX={paddingX}
      >
        {children}
      </Box>
    </Box>
  );
}
