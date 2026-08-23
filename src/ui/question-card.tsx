import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { OpenQuestion } from '../conductor/conductor.js';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

export interface QuestionCardProps {
  question: OpenQuestion;
  onAnswer: (questionId: string, answer: string) => void | Promise<void>;
  width?: number;
  isActive?: boolean;
}

export function QuestionCard({ question, onAnswer, width, isActive = true }: QuestionCardProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const options = useMemo(() => question.options?.length
    ? question.options
    : [{ id: 'default', label: question.proposedDefault ?? 'Accept proposed default' }], [question]);
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setSelected((value) => (value - 1 + options.length) % options.length);
    else if (key.downArrow) setSelected((value) => (value + 1) % options.length);
    else if (/^[1-9]$/.test(input)) setSelected(Math.min(options.length - 1, Number(input) - 1));
    else if (key.return) void onAnswer(question.id, options[selected]!.id);
  }, { isActive });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokenColor(question.blocking ? 'alert' : 'chrome')}
      paddingX={1}
    >
      <Text color={tokenColor(question.blocking ? 'alert' : 'orchid')}>{question.questionLayman}</Text>
      {question.example && <Text dimColor={dimmable()}>Example: {question.example}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Text key={option.id} inverse={index === selected}>
            {index + 1}. {option.label}{option.description ? ` — ${option.description}` : ''}
          </Text>
        ))}
      </Box>
      {question.proposedDefault && <Text dimColor={dimmable()}>Proposed default: {question.proposedDefault}</Text>}
      <Text dimColor={dimmable()}>↑/↓ choose · enter answer</Text>
    </Box>
  );
}
