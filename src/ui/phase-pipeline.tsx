import React from 'react';
import { Text } from 'ink';
import type { Phase } from '../conductor/conductor.js';
import { useTerminalSize } from './dimensions.js';
import { tokenColor, type TokenName } from './theme.js';

const PIPELINE: Phase[] = ['INTAKE', 'CLARIFY', 'RESEARCH', 'PLAN', 'APPROVE', 'EXECUTE', 'VERIFY', 'INTEGRATE', 'REPORT'];

export interface PhasePipelineProps {
  phase: Phase;
  width?: number;
  failed?: boolean;
  paused?: boolean;
}

export function PhasePipeline({ phase, width, failed = false, paused = false }: PhasePipelineProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const activeIndex = PIPELINE.indexOf(phase);
  const compact = terminal.width < 90;

  if (phase === 'PARKED') return <Text color={tokenColor('alert')}>Ⅱ PARKED</Text>;
  return (
    <Text wrap="truncate-end">
      {PIPELINE.map((item, index) => {
        const current = phase === item;
        const done = phase === 'DONE' || (activeIndex >= 0 && index < activeIndex);
        const marker = current ? (failed ? '✗' : paused ? 'Ⅱ' : item === 'APPROVE' ? '◆' : '▶') : done ? '✓' : '⋯';
        const color: TokenName = current
          ? failed ? 'alert' : item === 'APPROVE' || paused ? 'warn' : 'nebula'
          : done ? 'ok' : 'dim';
        const label = current && failed ? 'FAIL' : compact && !current ? item.slice(0, 3) : item;
        return <Text key={item} color={tokenColor(color)}>{index ? ' ' : ''}{marker}{label}</Text>;
      })}
    </Text>
  );
}
