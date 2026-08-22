// AgentRuntime adapter over OpenAiCompat (PLAN §4 "own minimal tool-use
// loop"). Reuses the same FS_TOOLS/executor Phase 0 already ships.

import type { AgentRuntime, TaskInput, TaskResult } from '../runtime/agent-runtime.js';
import { FS_TOOLS, makeFsToolExecutor, type Receipt } from '../agents/fs-tools.js';
import { runToolLoop, type OpenAiCompat } from './openai-compat.js';

export class OpenAiCompatRuntime implements AgentRuntime {
  constructor(private client: OpenAiCompat) {}

  // Usage/budget routing is bound at construction on `this.client` (its own
  // onUsage), same as Phase 0 — nothing extra to wire per call here.
  async runTask(input: TaskInput): Promise<TaskResult> {
    const receipts: Receipt[] = [];
    const execute = makeFsToolExecutor(input.cwd, receipts);
    const result = await runToolLoop(
      this.client,
      input.systemPrompt,
      input.userPrompt,
      FS_TOOLS,
      execute,
    );
    const failed = receipts.some((r) => r.exit !== null && r.exit !== 0);
    return { text: result.content, receipts, isError: failed };
  }
}
