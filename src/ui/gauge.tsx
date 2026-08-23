import React from 'react';
import { Text } from 'ink';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor, type TokenName } from './theme.js';

export interface GaugeProps {
  value: number | null;
  label?: string;
  width?: number;
  color?: TokenName;
  stale?: boolean;
}

export function Gauge({ value, label = '', width, color = 'violet', stale = false }: GaugeProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  if (value === null) return <Text dimColor={dimmable()}>{label ? `${label} —` : '—'}</Text>;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const suffix = ` ${pct}%`;
  const prefix = label ? `${label} ` : '';
  const cells = Math.max(1, terminal.width - prefix.length - suffix.length);
  const filled = Math.round((cells * pct) / 100);
  return (
    <Text dimColor={dimmable() && stale}>
      {prefix}<Text color={tokenColor(color)}>{'▓'.repeat(filled)}</Text>
      <Text dimColor={dimmable()}>{'░'.repeat(cells - filled)}</Text>{suffix}
    </Text>
  );
}

export interface BudgetBarProps {
  spent: number | null;
  ceiling: number;
  width?: number;
  stale?: boolean;
}

export function BudgetBar({ spent, ceiling, width, stale = false }: BudgetBarProps): React.JSX.Element {
  const ratio = spent === null || ceiling <= 0 ? null : (spent / ceiling) * 100;
  const color = budgetToken(spent, ceiling);
  const terminal = useTerminalSize(width);
  const amount = spent === null ? '—' : `$${spent.toFixed(2)}`;
  const label = `${amount} of $${ceiling}`;
  const gaugeWidth = Math.max(1, terminal.width - label.length - 1);
  return (
    <Text dimColor={dimmable() && stale}>
      <Text color={tokenColor(color)}>{label}</Text>{' '}
      <Gauge value={ratio} width={gaugeWidth} color={color} stale={stale} />
    </Text>
  );
}

export function budgetToken(spent: number | null, ceiling: number): TokenName {
  const ratio = spent === null || ceiling <= 0 ? null : (spent / ceiling) * 100;
  return ratio !== null && ratio >= 90 ? 'alert' : ratio !== null && ratio >= 70 ? 'warn' : 'ok';
}
