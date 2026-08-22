import { describe, expect, it, vi } from 'vitest';
import { OpenAiCompat, runToolLoop } from '../providers/openai-compat.js';
import { Redactor } from '../security/redact.js';

function clientWithFetch(fetchImpl: typeof fetch): OpenAiCompat {
  return new OpenAiCompat({
    baseUrl: 'https://fake',
    apiKey: 'k',
    model: 'm',
    redactor: new Redactor(),
    onUsage: () => {},
    fetchImpl,
  });
}

describe('runToolLoop shouldStop', () => {
  it('never calls the model at all when shouldStop is already true', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'x' } }] })));
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);

    const { content } = await runToolLoop(client, 'sys', 'user', [], async () => '', 8, () => true);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(content).toBe('');
  });

  it('stops issuing further turns once shouldStop flips true mid-loop (budget hard-stop)', async () => {
    let parked = false;
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      // Simulate a budget hard-stop firing as a side effect of this turn's usage charge.
      parked = true;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: '1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
              },
            },
          ],
        }),
      );
    };
    const client = clientWithFetch(fetchImpl as unknown as typeof fetch);

    await runToolLoop(client, 'sys', 'user', [], async () => 'ok', 8, () => parked);

    expect(calls).toBe(1); // one turn ran, then shouldStop caught the park before a second turn
  });
});
