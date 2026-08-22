// Unit-level regression tests for the two critical bugs an independent
// review caught in the first version of anthropic-runtime.ts: `canUseTool`
// silently never firing under permissionMode 'bypassPermissions' (fixed by
// moving the shell-denylist check into a PreToolUse hook), and `env`
// replacing the whole subprocess environment instead of merging into it.
// No real SDK/network call here — both fixes were extracted as pure
// functions specifically so they're testable without one.

import { describe, expect, it } from 'vitest';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { buildAnthropicEnv, denyBashOnDenylist } from '../providers/anthropic-runtime.js';

function preToolUse(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-id',
    session_id: 'test-session',
    transcript_path: '',
    cwd: '/tmp',
  } as unknown as PreToolUseHookInput;
}

describe('denyBashOnDenylist (PreToolUse hook)', () => {
  it('blocks a denylisted Bash command', async () => {
    const result = await denyBashOnDenylist(preToolUse('Bash', { command: 'rm -rf /' }), 'tid', {
      signal: new AbortController().signal,
    });
    expect(result.decision).toBe('block');
    if ('hookSpecificOutput' in result) {
      expect(result.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    }
  });

  it('allows a safe Bash command', async () => {
    const result = await denyBashOnDenylist(preToolUse('Bash', { command: 'npm test' }), 'tid', {
      signal: new AbortController().signal,
    });
    expect(result.decision).not.toBe('block');
  });

  it('ignores non-Bash tools entirely', async () => {
    const result = await denyBashOnDenylist(preToolUse('Write', { path: 'x', content: 'y' }), 'tid', {
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ continue: true });
  });

  it('ignores non-PreToolUse hook events', async () => {
    const other = { hook_event_name: 'PostToolUse' } as unknown as PreToolUseHookInput;
    const result = await denyBashOnDenylist(other, 'tid', { signal: new AbortController().signal });
    expect(result).toEqual({ continue: true });
  });
});

describe('buildAnthropicEnv', () => {
  it('returns undefined (SDK inherits process.env as-is) when no key override is given', () => {
    expect(buildAnthropicEnv(undefined)).toBeUndefined();
  });

  it('merges the override into process.env rather than replacing it', () => {
    const env = buildAnthropicEnv('sk-ant-test-key');
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
    // The bug this regression-tests: a naive `{ ANTHROPIC_API_KEY: key }`
    // would drop everything else, including PATH — the SDK spawns a real
    // subprocess that needs it to find the `claude` binary at all.
    expect(env?.PATH).toBe(process.env.PATH);
    expect(Object.keys(env ?? {}).length).toBeGreaterThan(1);
  });
});
