import React from 'react';
import { Text } from 'ink';
import type { DiffView, TestView } from './store.js';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

export interface DiffReceiptProps {
  diff?: DiffView;
  test?: TestView;
  width?: number;
}

export function DiffReceipt({ diff, test, width }: DiffReceiptProps): React.JSX.Element {
  useTerminalSize(width);
  if (diff) {
    return (
      <Text wrap="truncate-end">
        <Text color={tokenColor('violet')}>diff</Text> {diff.file}{' '}
        <Text color={tokenColor('ok')}>+{diff.added}</Text>{' '}
        <Text color={tokenColor('alert')}>-{diff.removed}</Text>{' '}
        <Text dimColor={dimmable()}>({diff.taskId})</Text>
      </Text>
    );
  }
  if (test) {
    const passed = test.exit === 0;
    return (
      <Text wrap="truncate-end">
        <Text color={tokenColor(passed ? 'ok' : 'alert')}>{passed ? 'PASS' : test.exit === null ? 'WAIT' : `FAIL ${test.exit}`}</Text>{' '}
        {test.cmd} <Text dimColor={dimmable()}>({test.taskId})</Text>
      </Text>
    );
  }
  return <Text dimColor={dimmable()}>receipt —</Text>;
}
