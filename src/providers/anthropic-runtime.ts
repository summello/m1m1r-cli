// AgentRuntime adapter over the Claude Agent SDK (PLAN §4: "Claude Code
// packaged as a library"). Unlike openai-compat-runtime.ts, this adapter
// does NOT define its own write_file/run_shell tools — the SDK's built-in
// Read/Write/Edit/Bash/Glob/Grep already do that, scoped to `cwd`. The only
// thing we add is routing Bash commands through the same shell denylist
// Phase 0 already uses, so both providers get equivalent defense-in-depth
// rather than the SDK path being unguarded.
//
// Verified against the installed @anthropic-ai/claude-agent-sdk@0.3.240 type
// definitions (sdk.d.ts) before writing this, and re-verified after an
// independent review caught a real bug in the first version: `canUseTool` is
// NEVER invoked under `permissionMode: 'bypassPermissions'` — the SDK's own
// sdk.mjs emits a runtime warning saying exactly that and pointing at a
// PreToolUse hook instead ("hooks fire even in bypass mode"). Gating via
// `canUseTool` there was silently dead code — every Bash command, denylisted
// or not, was auto-approved before the callback ran. Fixed below by using a
// PreToolUse hook. `bypassPermissions` also requires
// `allowDangerouslySkipPermissions: true` per sdk.d.ts's own doc comment
// ("a safety measure to ensure intentional bypassing") — set explicitly now
// rather than left implicit.

import {
  query,
  type HookCallback,
  type PreToolUseHookInput,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Receipt } from '../agents/fs-tools.js';
import type { AgentRuntime, TaskInput, TaskResult } from '../runtime/agent-runtime.js';
import type { Usage } from '../conductor/conductor.js';
import { denylisted } from '../security/redact.js';

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

export const denyBashOnDenylist: HookCallback = async (input) => {
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return { continue: true };
  const command = (input as PreToolUseHookInput).tool_input as { command?: unknown };
  if (typeof command.command === 'string' && denylisted(command.command)) {
    return {
      decision: 'block',
      reason: `command blocked by shell policy: ${command.command}`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `command blocked by shell policy: ${command.command}`,
      },
    };
  }
  return { continue: true };
};

/** `env`, when set, REPLACES the SDK subprocess's environment entirely — it
 * is not merged with process.env (sdk.d.ts is explicit about this: "Spread
 * process.env yourself if the subprocess still needs inherited variables
 * like PATH, HOME"). Extracted as a pure function so the merge itself is
 * unit-testable without spinning up the SDK. */
export function buildAnthropicEnv(apiKey: string | undefined): Record<string, string | undefined> | undefined {
  return apiKey ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : undefined;
}

export interface AnthropicRuntimeOptions {
  model: string;
  onUsage: (usage: Usage) => void | Promise<void>;
  onUsageUsd: (usd: number) => void | Promise<void>;
  /** Explicit API key; omit to use the ambient ANTHROPIC_API_KEY env var or
   * an existing `claude` CLI OAuth login (PLAN §4.1). */
  apiKey?: string;
  maxTurns?: number;
}

export class AnthropicRuntime implements AgentRuntime {
  constructor(private opts: AnthropicRuntimeOptions) {}

  async runTask(input: TaskInput): Promise<TaskResult> {
    const receipts: Receipt[] = [];
    const abortController = new AbortController();

    const stream = query({
      prompt: input.userPrompt,
      options: {
        systemPrompt: input.systemPrompt,
        cwd: input.cwd,
        model: this.opts.model,
        maxTurns: this.opts.maxTurns ?? 8,
        // Scoped to `cwd` (no additionalDirectories granted), so this is
        // the SDK analog of Phase 0's safeJoin-scoped tool executor, not an
        // unscoped grant — bypassPermissions only skips the interactive
        // approval UI, which doesn't exist in a non-interactive DAG run.
        // Required alongside bypassPermissions per sdk.d.ts's own doc
        // comment on that mode.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: ALLOWED_TOOLS,
        abortController,
        env: buildAnthropicEnv(this.opts.apiKey),
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [denyBashOnDenylist] }] },
      },
    });

    let text = '';
    let isError = false;
    for await (const msg of stream as AsyncGenerator<SDKMessage>) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            // ponytail: coarse receipts, not per-tool exit codes — matching
            // a tool_use to its tool_result frame needs correlating by
            // toolUseID across the next user-message; deferred until a task
            // actually needs per-tool granularity. exit is backfilled below
            // from the turn's overall result.
            const summary = JSON.stringify(block.input).slice(0, 200);
            receipts.push({ cmd: `${block.name} ${summary}`, exit: null, outputRef: 'pending' });
          }
        }
      } else if (msg.type === 'result') {
        isError = msg.is_error;
        text = msg.subtype === 'success' ? msg.result : msg.errors.join('\n');
        await this.opts.onUsage({
          prompt_tokens: msg.usage.input_tokens,
          completion_tokens: msg.usage.output_tokens,
        });
        await this.opts.onUsageUsd(msg.total_cost_usd);
        for (const r of receipts) if (r.exit === null) r.exit = isError ? 1 : 0;
      }
    }
    return { text, receipts, isError };
  }
}
