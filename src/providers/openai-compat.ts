// OpenAI-compat chat adapter (PLAN §4.1 transport row): OpenRouter / OpenAI /
// any /v1/chat/completions endpoint. Captures usage for the budget governor.
// All error bodies pass through the redactor before surfacing.

import type { Usage } from '../conductor/conductor.js';
import type { Redactor } from '../security/redact.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  redactor: Redactor;
  onUsage: (usage: Usage) => void | Promise<void>;
  fetchImpl?: typeof fetch;
}

export class ChatResponse {
  constructor(
    public message: ChatMessage,
    public usage: Usage,
  ) {}
}

export class OpenAiCompat {
  private fetchImpl: typeof fetch;

  constructor(private o: ChatOpts) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async chat(
    messages: ChatMessage[],
    tools?: ToolDef[],
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const body: Record<string, unknown> = { model: this.o.model, messages };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await this.fetchImpl(`${this.o.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.o.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Scrub before surfacing — error bodies have echoed credentials before.
      throw new Error(`chat failed (${res.status}): ${this.o.redactor.scrub(text.slice(0, 500))}`);
    }
    const json = (await res.json()) as {
      choices: Array<{ message: ChatMessage }>;
      usage?: Usage;
    };
    const message = json.choices[0]?.message ?? { role: 'assistant', content: '' };
    const usage = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    if (json.usage) await this.o.onUsage(usage);
    return new ChatResponse(message, usage);
  }
}

/** Minimal tool-use loop (PLAN §4 openai-compat "own minimal tool-use loop").
 * `shouldStop` is checked before every turn so a budget hard-stop that fires
 * mid-loop (via the USAGE charge from the turn just completed) halts further
 * spend instead of running out the rest of `maxTurns` regardless. */
export async function runToolLoop(
  client: OpenAiCompat,
  system: string,
  userPrompt: string,
  tools: ToolDef[],
  execute: (name: string, argsJson: string) => Promise<string>,
  maxTurns = 8,
  shouldStop?: () => boolean,
): Promise<{ content: string; messages: ChatMessage[] }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userPrompt },
  ];
  let content = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    if (shouldStop?.()) break;
    const res = await client.chat(messages, tools);
    messages.push(res.message);
    const calls = res.message.tool_calls ?? [];
    if (!calls.length) {
      content = res.message.content ?? '';
      break;
    }
    for (const call of calls) {
      let result: string;
      try {
        result = await execute(call.function.name, call.function.arguments);
      } catch (e: unknown) {
        result = `tool error: ${(e as Error).message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { content, messages };
}
