import React from 'react';
import { Box, Text } from 'ink';
import { galaxyFull, galaxyGlyph, GALAXY_WIDTH } from './logo.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor } from './theme.js';

export interface GalaxyLogoProps {
  size?: 'full' | 'compact';
  width?: number;
}

export function GalaxyLogo({ size = 'full', width }: GalaxyLogoProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  if (size === 'compact' || terminal.width < 40) {
    return <Text color={tokenColor('core')}>{galaxyGlyph()}</Text>;
  }
  return (
    <Box flexDirection="column" width={Math.min(terminal.width, GALAXY_WIDTH)}>
      {galaxyFull().map((line, index) => <Text key={index}>{line}</Text>)}
    </Box>
  );
}
