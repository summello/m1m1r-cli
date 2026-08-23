import type {
  BudgetLevel,
  JournalEvent,
  OpenQuestion,
  Phase,
  Usage,
} from '../conductor/conductor.js';

export interface AgentView {
  id: string;
  role: string;
  task: string;
  status: 'running' | 'idle' | 'done' | 'failed';
  startedAt?: number;
}

export interface DiffView {
  taskId: string;
  file: string;
  added: number;
  removed: number;
}

export interface TestView {
  taskId: string;
  cmd: string;
  exit: number | null;
  outputRef: string;
}

export interface StreamView {
  id: string;
  role: string;
  text: string;
  streaming: boolean;
}

export interface UiState {
  phase: Phase;
  tasksDone: number;
  tasksTotal: number;
  tasksSeen: boolean;
  agentsActive: number;
  agentsIdle: number;
  agentsSeen: boolean;
  agents: AgentView[];
  budget: BudgetLevel;
  budgetSeen: boolean;
  usageTotals: { promptTokens: number; completionTokens: number };
  usageSeen: boolean;
  ctxPct: number | null;
  model: string | null;
  effort: string;
  mode: string;
  provider: string;
  account: string;
  branch: string | null;
  dirty: boolean;
  worktree: string;
  blockingQuestions: number;
  questions: OpenQuestion[];
  diffs: DiffView[];
  tests: TestView[];
  streams: StreamView[];
  busy: boolean;
  paused: boolean;
  gateFailed: boolean;
  fiveHourCost: number | null;
  sevenDayCost: number | null;
  lastUpdate: number;
  lastAgentUpdate: number;
  lastUsageUpdate: number;
}

export const INITIAL_UI_STATE: UiState = {
  phase: 'INTAKE',
  tasksDone: 0,
  tasksTotal: 0,
  tasksSeen: false,
  agentsActive: 0,
  agentsIdle: 0,
  agentsSeen: false,
  agents: [],
  budget: { spentUsd: 0, ceilingUsd: 25, level: 'ok' },
  budgetSeen: false,
  usageTotals: { promptTokens: 0, completionTokens: 0 },
  usageSeen: false,
  ctxPct: null,
  model: null,
  effort: 'high',
  mode: 'semi',
  provider: 'openrouter',
  account: 'key',
  branch: null,
  dirty: false,
  worktree: 'primary',
  blockingQuestions: 0,
  questions: [],
  diffs: [],
  tests: [],
  streams: [],
  busy: false,
  paused: false,
  gateFailed: false,
  fiveHourCost: null,
  sevenDayCost: null,
  lastUpdate: 0,
  lastAgentUpdate: 0,
  lastUsageUpdate: 0,
};

export class UiStore {
  private state: UiState = { ...INITIAL_UI_STATE };
  private subs = new Set<() => void>();
  private ctxWindow = 128_000;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  getSnapshot = (): UiState => this.state;

  set(patch: Partial<UiState>): void {
    this.state = { ...this.state, ...patch, lastUpdate: Date.now() };
    for (const fn of this.subs) fn();
  }

  setCtxWindow(tokens: number): void {
    if (tokens > 0) this.ctxWindow = tokens;
  }

  hydrate(events: readonly JournalEvent[]): void {
    for (const event of events) this.apply(event);
  }

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'PHASE':
      case 'SKIPPED':
      case 'AUTO_APPROVED':
        this.set({ phase: ev.phase, busy: ev.phase !== 'DONE' && ev.phase !== 'PARKED', gateFailed: false });
        break;
      case 'PLAN': {
        const steps = (ev.payload as unknown[] | undefined)?.length ?? 0;
        this.set({ tasksTotal: steps, tasksDone: 0, tasksSeen: true });
        break;
      }
      case 'TEAM_PLAN': {
        const nodes = (ev.payload as unknown[] | undefined)?.length ?? 0;
        this.set({ tasksTotal: nodes, tasksDone: 0, tasksSeen: true });
        break;
      }
      case 'RECEIPTS': {
        const receipts = (ev.payload as Array<{ exit: number | null }> | undefined) ?? [];
        this.set({ tasksDone: receipts.filter((receipt) => receipt.exit === 0).length, tasksSeen: true });
        break;
      }
      case 'TEAM_RESULTS': {
        const results = (ev.payload as Array<{ ok: boolean }> | undefined) ?? [];
        this.set({ tasksDone: results.filter((result) => result.ok).length, tasksSeen: true });
        break;
      }
      case 'AGENT_STARTED': {
        const payload = ev.payload as { id: string; role: string; task: string };
        const agents = upsertAgent(this.state.agents, {
          ...payload,
          status: 'running',
          startedAt: ev.ts,
        });
        this.set({
          agents,
          agentsActive: agents.filter((agent) => agent.status === 'running').length,
          agentsIdle: agents.filter((agent) => agent.status === 'idle').length,
          agentsSeen: true,
          lastAgentUpdate: ev.ts,
        });
        break;
      }
      case 'AGENT_FINISHED': {
        const payload = ev.payload as { id: string; role: string; ok: boolean };
        const existing = this.state.agents.find((agent) => agent.id === payload.id);
        const agents = upsertAgent(this.state.agents, {
          id: payload.id,
          role: payload.role,
          task: existing?.task ?? payload.id,
          status: payload.ok ? 'done' : 'failed',
          startedAt: existing?.startedAt,
        });
        this.set({
          agents,
          agentsActive: agents.filter((agent) => agent.status === 'running').length,
          agentsIdle: agents.filter((agent) => agent.status === 'idle').length,
          agentsSeen: true,
          tasksDone: this.state.tasksDone + (payload.ok ? 1 : 0),
          lastAgentUpdate: ev.ts,
        });
        break;
      }
      case 'GATE_RESULT':
        this.set({ phase: ev.phase, gateFailed: !(ev.payload as { pass?: boolean } | undefined)?.pass });
        break;
      case 'USAGE': {
        const payload = ev.payload as { usage: Usage; model?: string };
        const usageTotals = {
          promptTokens: this.state.usageTotals.promptTokens + payload.usage.prompt_tokens,
          completionTokens: this.state.usageTotals.completionTokens + payload.usage.completion_tokens,
        };
        const contextTokens = payload.usage.prompt_tokens + payload.usage.completion_tokens;
        this.set({
          usageTotals,
          usageSeen: true,
          ctxPct: Math.min(100, Math.round((contextTokens / this.ctxWindow) * 100)),
          model: payload.model ?? this.state.model,
          lastUsageUpdate: ev.ts,
        });
        break;
      }
      case 'BUDGET_UPDATE':
        this.set({ budget: ev.payload as BudgetLevel, budgetSeen: true, lastUsageUpdate: ev.ts });
        break;
      case 'QUESTION_RAISED': {
        const question = ev.payload as OpenQuestion;
        const questions = [...this.state.questions.filter((item) => item.id !== question.id), question];
        this.set({ questions, blockingQuestions: questions.filter((item) => item.blocking).length });
        break;
      }
      case 'QUESTION_ANSWERED': {
        const { id } = ev.payload as { id: string };
        const questions = this.state.questions.filter((question) => question.id !== id);
        this.set({ questions, blockingQuestions: questions.filter((item) => item.blocking).length });
        break;
      }
      case 'DIFF_RECEIPT':
        this.set({ diffs: [...this.state.diffs, ev.payload as DiffView] });
        break;
      case 'TEST_RECEIPT':
        this.set({ tests: [...this.state.tests, ev.payload as TestView] });
        break;
      case 'STREAM_START': {
        const payload = ev.payload as { id: string; role: string };
        this.set({ streams: [...this.state.streams, { ...payload, text: '', streaming: true }] });
        break;
      }
      case 'STREAM_DELTA': {
        const payload = ev.payload as { id: string; text: string };
        this.set({
          streams: this.state.streams.map((stream) =>
            stream.id === payload.id ? { ...stream, text: stream.text + payload.text } : stream,
          ),
        });
        break;
      }
      case 'STREAM_END': {
        const { id } = ev.payload as { id: string };
        this.set({
          streams: this.state.streams.map((stream) =>
            stream.id === id ? { ...stream, streaming: false } : stream,
          ),
        });
        break;
      }
      case 'CONTROL_PAUSED':
        this.set({ paused: true });
        break;
      case 'CONTROL_RESUMED':
        this.set({ paused: false });
        break;
      case 'CONTROL_MODE':
        this.set({ mode: (ev.payload as { mode: string }).mode });
        break;
      case 'PARK':
      case 'COMPLETE':
        this.set({ busy: false, phase: ev.phase });
        break;
      default:
        break;
    }
  }
}

function upsertAgent(agents: AgentView[], next: AgentView): AgentView[] {
  const found = agents.some((agent) => agent.id === next.id);
  return found ? agents.map((agent) => (agent.id === next.id ? next : agent)) : [...agents, next];
}
