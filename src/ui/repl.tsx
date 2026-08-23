import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { useTerminalSize } from './dimensions.js';
import { dimmable, tokenColor } from './theme.js';

export const SLASH_COMMANDS = [
  '/agents', '/answer', '/budget', '/help', '/init', '/model', '/pause',
  '/mode', '/plan', '/questions', '/redirect', '/resume', '/sessions', '/quit',
];

export interface ReplProps {
  width?: number;
  isActive?: boolean;
  onCommand?: (command: string, args: string[]) => string | void | Promise<string | void>;
  onShell?: (command: string) => Promise<{ ok: boolean; output: string }>;
  onPrompt?: (prompt: string, onDelta: (text: string) => void) => Promise<void>;
}

interface ReplLine {
  id: number;
  kind: 'input' | 'output' | 'error';
  text: string;
}

export function Repl({ width, isActive = true, onCommand, onShell, onPrompt }: ReplProps): React.JSX.Element {
  const terminal = useTerminalSize(width);
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(0);
  const [lines, setLines] = useState<ReplLine[]>([]);
  const [busy, setBusy] = useState(false);
  const suggestions = useMemo(() => input.startsWith('/')
    ? SLASH_COMMANDS.filter((command) => command.startsWith(input.split(/\s/, 1)[0]!))
    : [], [input]);

  const append = (kind: ReplLine['kind'], text: string) => {
    setLines((current) => [...current.slice(-5), { id: Date.now() + Math.random(), kind, text }]);
  };

  const execute = async () => {
    const value = input.trim();
    if (!value || busy) return;
    setInput('');
    setSelected(0);
    append('input', `› ${value}`);
    setBusy(true);
    try {
      if (value === '/quit') {
        exit();
      } else if (value.startsWith('!')) {
        const result = onShell ? await onShell(value.slice(1).trim()) : { ok: false, output: 'shell is unavailable' };
        append(result.ok ? 'output' : 'error', result.output.trim() || '(no output)');
      } else if (value.startsWith('/')) {
        const [command, ...args] = value.split(/\s+/);
        const result = await onCommand?.(command!, args);
        if (result) append('output', result);
      } else if (onPrompt) {
        let streamed = '';
        const streamId = Date.now() + Math.random();
        setLines((current) => [...current.slice(-5), { id: streamId, kind: 'output', text: '' }]);
        await onPrompt(value, (delta) => {
          streamed += delta;
          setLines((current) => current.map((line) => line.id === streamId ? { ...line, text: streamed } : line));
        });
      } else {
        append('output', 'Use /redirect <task> <instruction> to steer active work.');
      }
    } catch (error: unknown) {
      append('error', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useInput((text, key) => {
    if (key.return) void execute();
    else if (key.backspace || key.delete) setInput((value) => value.slice(0, -1));
    else if (key.upArrow && suggestions.length) setSelected((value) => (value - 1 + suggestions.length) % suggestions.length);
    else if (key.downArrow && suggestions.length) setSelected((value) => (value + 1) % suggestions.length);
    else if (key.tab && suggestions.length) setInput(`${suggestions[selected]} `);
    else if (!key.ctrl && !key.meta && text) setInput((value) => value + text);
  }, { isActive });

  return (
    <Box flexDirection="column" width={terminal.width}>
      {lines.map((line) => (
        <Text key={line.id} color={line.kind === 'error' ? tokenColor('alert') : undefined} dimColor={dimmable() && line.kind === "input"} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
      {suggestions.length > 0 && (
        <Text wrap="truncate-end">
          {suggestions.map((command, index) => (
            <Text key={command} inverse={index === selected}>{index ? ' ' : ''}{command}</Text>
          ))}
        </Text>
      )}
      {/* No explicit width: a border adds two columns on top of it, which
          overflows the parent and misaligns the frame. Let it stretch. */}
      <Box borderStyle="round" borderColor={tokenColor('chrome')} paddingX={1}>
        <Text color={tokenColor(busy ? 'warn' : 'nebula')}>{busy ? '…' : '>'}</Text>
        <Text> {input}</Text>
        <Text color={tokenColor('core')}>▌</Text>
      </Box>
    </Box>
  );
}
