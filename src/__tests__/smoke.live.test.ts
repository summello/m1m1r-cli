// Live smoke test (package.json `test:smoke`, gated by SMOKE=1). Hits a real
// model over a real API key — skipped by default so `npm test` never needs
// network or credentials. Run explicitly: `npm run test:smoke`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEngagement } from '../agents/generic-agent.js';
import { Conductor } from '../conductor/conductor.js';
import { OpenAiCompat } from '../providers/openai-compat.js';
import { Redactor } from '../security/redact.js';

const apiKey = process.env.M1M1R_API_KEY ?? process.env.OPENROUTER_API_KEY;
const model = process.env.M1M1R_MODEL;
const run = process.env.SMOKE === '1' && apiKey && model;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'm1m1r-smoke-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!run)('live engagement', () => {
  it('completes a trivial requirement end to end', async () => {
    const redactor = new Redactor();
    redactor.addSecret(apiKey!);
    const client = new OpenAiCompat({
      baseUrl: process.env.M1M1R_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKey: apiKey!,
      model: model!,
      redactor,
      onUsage: () => {},
    });
    const conductor = await Conductor.open(dir);
    await conductor.journal.append(conductor.state.phase, 'START', {
      requirement: 'Create a file named hello.txt containing the text "hello".',
    });
    conductor.state.requirement = 'Create a file named hello.txt containing the text "hello".';

    await runEngagement(client, conductor, join(dir, 'workspace'));

    expect(conductor.state.phase).toBe('DONE');
    expect(conductor.state.report).toBeTruthy();
  }, 60_000);
});
