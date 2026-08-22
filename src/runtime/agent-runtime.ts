// AgentRuntime port (PLAN §3, §4): the seam between the conductor/DAG layer
// and a specific provider. Phase 1 ships two implementations —
// openai-compat-runtime.ts (OpenRouter/OpenAI/Codex, our own tool loop) and
// anthropic-runtime.ts (Claude Agent SDK, its own built-in tool loop) — so a
// task node never knows or cares which one ran it.
//
// Provider, model, and usage routing are bound once per instance (same
// pattern OpenAiCompat already uses) rather than threaded through every
// call — a role's tier binding picks which AgentRuntime instance it gets,
// not a per-call model switch. TaskInput only carries what genuinely varies
// call to call.
//
// Phase 0's generic-agent.ts predates this port and talks to OpenAiCompat
// directly; it is intentionally left alone (already shipped, tested,
// reviewed) rather than refactored onto this interface as a side effect of
// Phase 1. Only the new DAG/implementer path in this phase uses it.

export type { Receipt } from '../agents/fs-tools.js';
import type { Receipt } from '../agents/fs-tools.js';

export interface TaskInput {
  systemPrompt: string;
  userPrompt: string;
  /** Absolute path the agent may read/write within. */
  cwd: string;
}

export interface TaskResult {
  text: string;
  receipts: Receipt[];
  isError: boolean;
}

export interface AgentRuntime {
  runTask(input: TaskInput): Promise<TaskResult>;
}
