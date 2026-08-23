import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { StatusLine } from '../ui/status-line.js';
import { bannerRows, WelcomePanel } from '../ui/welcome-panel.js';
import { QuestionCard } from '../ui/question-card.js';
import { Repl } from '../ui/repl.js';
import { Cockpit } from '../ui/cockpit.js';
import { Sidebar } from '../ui/sidebar.js';
import { buildTree, treePrefix } from '../ui/repo-tree.js';
import { wordmarkRows } from '../ui/wordmark.js';
import { GALAXY_FULL } from '../ui/logo.js';
import { enterAltScreen } from '../ui/alt-screen.js';
import { INITIAL_UI_STATE, UiStore, type UiState } from '../ui/store.js';
import { detectSupport, setSupport } from '../ui/theme.js';
import { budgetToken } from '../ui/gauge.js';

afterEach(() => {
  cleanup();
  setSupport('mono');
});

function state(patch: Partial<UiState> = {}): UiState {
  return {
    ...INITIAL_UI_STATE,
    agents: [],
    questions: [],
    diffs: [],
    tests: [],
    streams: [],
    phase: 'EXECUTE',
    tasksDone: 12,
    tasksTotal: 18,
    tasksSeen: true,
    agentsActive: 3,
    agentsIdle: 2,
    agentsSeen: true,
    budget: { spentUsd: 14.2, ceilingUsd: 25, level: 'warn' },
    budgetSeen: true,
    usageTotals: { promptTokens: 48_100, completionTokens: 12_400 },
    usageSeen: true,
    ctxPct: 34,
    model: 'ox-alpha',
    provider: 'openrouter',
    branch: 'main',
    lastUsageUpdate: 10_000,
    lastAgentUpdate: 10_000,
    ...patch,
  };
}

describe('responsive cockpit components', () => {
  it.each([60, 80, 120] as const)('keeps the status bar to one line within %i columns', (width) => {
    setSupport('mono');
    const frame = render(
      <StatusLine state={state()} width={width} projectPath="/repo" now={10_100} />,
    ).lastFrame()!;
    expect(frame).toContain('EXECUTE');
    expect(frame.split('\n').every((line) => line.length <= width)).toBe(true);
  });

  it('shows the working directory and live session figures in the status bar', () => {
    setSupport('mono');
    const frame = render(<StatusLine state={state()} width={120} projectPath="/repo" />).lastFrame()!;
    expect(frame).toContain('/repo');
    expect(frame).toContain('main');
    expect(frame).toContain('12/18');
    expect(frame).toContain('60.5K (34%)');
    expect(frame).toContain('$14.20');
  });

  it('omits engagement figures from the status bar before anything has run', () => {
    setSupport('mono');
    const frame = render(<StatusLine state={INITIAL_UI_STATE} width={120} projectPath="/repo" />).lastFrame()!;
    expect(frame).not.toContain('INTAKE');
    expect(frame).not.toContain('0/0');
    expect(frame).toContain('semi · openrouter');
  });

  it('renders the banner unboxed with the block wordmark and workspace identity', () => {
    setSupport('mono');
    const frame = render(
      <WelcomePanel state={state()} width={120} userName="Sonam" projectPath="/repo/summello-cli" />,
    ).lastFrame()!;
    expect(frame).toContain('██');
    expect(frame).toContain('Welcome back, Sonam.');
    expect(frame).toContain('ox-alpha · high · openrouter');
    expect(frame).toContain('/repo/summello-cli');
    expect(frame).toContain('summello-cli · main');
    expect(frame).toContain('Get started');
    expect(frame).toContain('What’s new');
    expect(frame).toContain('Quick commands');
    expect(frame).not.toContain('╭');
  });

  it('falls back to the glyph mark when the block wordmark will not fit', () => {
    setSupport('mono');
    const frame = render(<WelcomePanel state={state()} width={60} projectPath="/repo" />).lastFrame()!;
    expect(frame).toContain('✧ m1m1r');
    expect(frame).not.toContain('██');
  });

  it.each([50, 64, 80, 130])('bannerRows(%i) matches what the banner actually renders', (width) => {
    setSupport('mono');
    const frame = render(
      <WelcomePanel state={state()} width={width} projectPath="/repo/summello-cli" />,
    ).lastFrame()!;
    expect(frame.split('\n')).toHaveLength(bannerRows(width));
  });

  it('keeps every galaxy row the same width so the mark stays aligned', () => {
    expect(new Set(GALAXY_FULL.map((row) => row.length)).size).toBe(1);
    expect(GALAXY_FULL).toHaveLength(5);
  });

  it('writes the alternate-screen sequences only for a TTY', () => {
    const written: string[] = [];
    const tty = { isTTY: true, write: (text: string) => written.push(text) } as unknown as NodeJS.WriteStream;
    enterAltScreen(tty)();
    expect(written[0]).toContain('\x1b[?1049h');
    expect(written[1]).toBe('\x1b[?1049l');

    const piped = { isTTY: false, write: () => { throw new Error('must not write'); } } as unknown as NodeJS.WriteStream;
    expect(() => enterAltScreen(piped)()).not.toThrow();
  });

  it('renders the wordmark as five solid rows of equal width', () => {
    const rows = wordmarkRows();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.length)).size).toBe(1);
    expect(rows.every((row) => row.includes('██'))).toBe(true);
  });

  it('renders a resume strip only when reopening an engagement', () => {
    const fresh = render(<WelcomePanel state={state()} width={100} />).lastFrame()!;
    const resumed = render(<WelcomePanel state={state()} width={100} resumedEngagementId="42" />).lastFrame()!;
    expect(fresh).not.toContain('↻ #42');
    expect(resumed).toContain('↻ #42');
    expect(resumed).toContain('12/18 tasks');
  });

  it('emits no ANSI color escapes in mono mode', () => {
    setSupport('mono');
    const frame = render(<StatusLine state={state()} width={120} projectPath="/repo" />).lastFrame()!;
    expect(frame).not.toMatch(/\x1b\[/);
  });

  it('builds a repo tree with directories first and depth capped', () => {
    const tree = buildTree([
      'README.md',
      'src/ui/cockpit.tsx',
      'src/bin/m1m1r.ts',
      'package.json',
    ]);
    const rendered = tree.map((line) => `${treePrefix(line)}${line.name}`);
    expect(tree[0]!.name).toBe('src');
    expect(tree[0]!.isDir).toBe(true);
    expect(rendered.some((line) => line.includes('README.md'))).toBe(true);
    expect(tree.every((line) => line.depth <= 1)).toBe(true);
    expect(rendered.some((line) => line.includes('cockpit.tsx'))).toBe(false);
  });

  it('lists repo files and session figures in the sidebar', () => {
    setSupport('mono');
    const frame = render(
      <Sidebar
        state={state()}
        width={30}
        projectPath="/repo"
        paths={['README.md', 'src/ui/cockpit.tsx']}
      />,
    ).lastFrame()!;
    expect(frame).toContain('Files');
    expect(frame).toContain('src/');
    expect(frame).toContain('README.md');
    expect(frame).toContain('Context');
    expect(frame).toContain('12/18 done');
  });

  it('detects NO_COLOR presence and TERM=dumb as mono terminals', () => {
    expect(detectSupport({ NO_COLOR: '' })).toBe('mono');
    expect(detectSupport({ TERM: 'dumb', COLORTERM: 'truecolor' })).toBe('mono');
  });

  it('uses ok, warn, and alert tokens at the budget thresholds', () => {
    expect(budgetToken(6.9, 10)).toBe('ok');
    expect(budgetToken(7, 10)).toBe('warn');
    expect(budgetToken(9, 10)).toBe('alert');
  });
});

describe('interactive surfaces', () => {
  it('selects and answers a question card using keyboard input', async () => {
    const onAnswer = vi.fn();
    const view = render(
      <QuestionCard
        width={80}
        question={{
          id: 'q1',
          blocking: true,
          questionLayman: 'Which deletion policy?',
          options: [
            { id: 'hard', label: 'Hard delete' },
            { id: 'soft', label: '30-day soft delete' },
          ],
        }}
        onAnswer={onAnswer}
      />,
    );
    view.stdin.write('\u001B[B');
    await tick();
    view.stdin.write('\r');
    await tick();
    expect(onAnswer).toHaveBeenCalledWith('q1', 'soft');
  });

  it('autocompletes slash commands and executes raw shell input', async () => {
    const onShell = vi.fn(async () => ({ ok: true, output: 'shell receipt' }));
    const view = render(<Repl width={80} onShell={onShell} />);
    view.stdin.write('/pa');
    await tick();
    expect(view.lastFrame()).toContain('/pause');

    view.stdin.write('\u001B');
    view.unmount();
    const shellView = render(<Repl width={80} onShell={onShell} />);
    shellView.stdin.write('!printf ok');
    await tick();
    shellView.stdin.write('\r');
    await tick();
    expect(onShell).toHaveBeenCalledWith('printf ok');
    expect(shellView.lastFrame()).toContain('shell receipt');
  });

  it('reflects a journal phase transition in the mounted cockpit immediately', async () => {
    const store = new UiStore();
    const view = render(<Cockpit store={store} width={60} showWelcome={false} interactive={false} />);
    store.apply({ ts: Date.now(), id: '1', phase: 'VERIFY', event: 'PHASE' });
    await tick();
    expect(view.lastFrame()).toContain('▶VERIFY');
  });

  it('renders agent activity, streamed text, and inline diff/test receipts', async () => {
    setSupport('mono');
    const store = new UiStore();
    store.apply({ ts: 1, id: '1', phase: 'EXECUTE', event: 'AGENT_STARTED', payload: { id: 'auth', role: 'implementer', task: 'fix auth' } });
    store.apply({ ts: 2, id: '2', phase: 'EXECUTE', event: 'STREAM_START', payload: { id: 's1', role: 'implementer' } });
    store.apply({ ts: 3, id: '3', phase: 'EXECUTE', event: 'STREAM_DELTA', payload: { id: 's1', text: 'Working now' } });
    store.apply({ ts: 4, id: '4', phase: 'EXECUTE', event: 'DIFF_RECEIPT', payload: { taskId: 'auth', file: 'src/auth.ts', added: 8, removed: 2 } });
    store.apply({ ts: 5, id: '5', phase: 'VERIFY', event: 'TEST_RECEIPT', payload: { taskId: 'auth', cmd: 'npm test', exit: 0, outputRef: 'captured' } });
    const frame = render(<Cockpit store={store} width={100} showWelcome={false} interactive={false} />).lastFrame()!;
    expect(frame).toContain('implementer #auth fix auth');
    expect(frame).toContain('Working now▌');
    expect(frame).toContain('src/auth.ts +8 -2');
    expect(frame).toContain('PASS npm test');
  });
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
