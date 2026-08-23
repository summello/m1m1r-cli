import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { StatusLine } from '../ui/status-line.js';
import { WelcomePanel } from '../ui/welcome-panel.js';
import { QuestionCard } from '../ui/question-card.js';
import { Repl } from '../ui/repl.js';
import { Cockpit } from '../ui/cockpit.js';
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
  it.each([
    [60, '▶EXECUTE 12/18', false, false],
    [80, 'STATUS', false, false],
    [120, 'COCKPIT', true, true],
  ] as const)('reflows the statusline at %i columns', (width, marker, session, control) => {
    setSupport('mono');
    const frame = render(<StatusLine state={state()} width={width} now={10_100} />).lastFrame()!;
    expect(frame).toContain(marker);
    expect(frame.includes('SESSION')).toBe(session);
    expect(frame.includes('CONTROL')).toBe(control);
    expect(frame.split('\n').every((line) => line.length <= width)).toBe(true);
  });

  it('stacks the welcome panel below 90 columns and uses the full galaxy in wide mode', () => {
    setSupport('mono');
    const narrow = render(<WelcomePanel state={state()} width={80} userName="Sonam" projectPath="/repo" />).lastFrame()!;
    const wide = render(<WelcomePanel state={state()} width={120} userName="Sonam" projectPath="/repo" />).lastFrame()!;
    expect(narrow).toContain('✧');
    expect(narrow).not.toContain('.--=====--.');
    expect(narrow.indexOf('Tips for getting started')).toBeGreaterThan(narrow.indexOf('main'));
    expect(wide).toContain('.--=====--.');
    expect(wide).toContain('Tips for getting started');
  });

  it('shows an idle hint instead of the cockpit box before any engagement has run', () => {
    setSupport('mono');
    const frame = render(<StatusLine state={INITIAL_UI_STATE} width={120} />).lastFrame()!;
    expect(frame).toContain('no active engagement');
    expect(frame).not.toContain('COCKPIT');
    expect(frame).not.toContain('ENGAGEMENT');
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
    const frame = render(<StatusLine state={state()} width={120} />).lastFrame()!;
    expect(frame).not.toMatch(/\x1b\[/);
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
