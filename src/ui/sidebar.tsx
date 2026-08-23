import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { UiState } from './store.js';
import { buildTree, readRepoPaths, treePrefix } from './repo-tree.js';
import { dimmable, tokenColor } from './theme.js';

const TREE_ROWS = 14;

export interface SidebarProps {
  state: UiState;
  width: number;
  projectPath: string;
  paths?: readonly string[];
}

function Section({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={tokenColor('orchid')}>{label}</Text>
      {children}
    </Box>
  );
}

export function Sidebar({ state, width, projectPath, paths: fixedPaths }: SidebarProps): React.JSX.Element {
  const [paths, setPaths] = useState<readonly string[]>(fixedPaths ?? []);
  useEffect(() => {
    if (fixedPaths) return;
    let live = true;
    void readRepoPaths(projectPath).then((next) => {
      if (live) setPaths(next);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [projectPath, fixedPaths]);

  const tree = useMemo(() => buildTree(paths), [paths]);
  const shown = tree.slice(0, TREE_ROWS);
  const hidden = tree.length - shown.length;
  const contextTokens = state.usageTotals.promptTokens + state.usageTotals.completionTokens;

  return (
    <Box
      flexDirection="column"
      width={width}
      paddingLeft={2}
      borderStyle="single"
      borderColor={tokenColor('chrome')}
      borderDimColor={dimmable()}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
    >
      {state.usageSeen && (
        <Section label="Context">
          <Text dimColor={dimmable()}>{contextTokens.toLocaleString('en-US')} tokens</Text>
          {state.ctxPct !== null && <Text dimColor={dimmable()}>{state.ctxPct}% used</Text>}
          {state.budgetSeen && <Text dimColor={dimmable()}>${state.budget.spentUsd.toFixed(2)} spent</Text>}
        </Section>
      )}

      {state.tasksSeen && (
        <Section label="Tasks">
          <Text dimColor={dimmable()}>{state.tasksDone}/{state.tasksTotal} done</Text>
        </Section>
      )}

      <Section label="Files">
        {shown.length === 0 && <Text dimColor={dimmable()}>—</Text>}
        {shown.map((line, index) => (
          <Text key={`${line.depth}-${line.name}-${index}`} dimColor={dimmable() && !line.isDir} wrap="truncate-end">
            {treePrefix(line)}{line.name}{line.isDir ? '/' : ''}
          </Text>
        ))}
        {hidden > 0 && <Text dimColor={dimmable()}>   +{hidden} more</Text>}
      </Section>
    </Box>
  );
}
