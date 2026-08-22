import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal } from '../conductor/conductor.js';
import { Redactor } from '../security/redact.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'm1m1r-journal-'));
  path = join(dir, 'journal.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Journal redaction on write', () => {
  it('scrubs a registered runtime secret before it reaches disk', async () => {
    const redactor = new Redactor();
    redactor.addSecret('super-secret-api-key-value');
    const j = await Journal.open(path, redactor);
    await j.append('INTAKE', 'START', { requirement: 'use key super-secret-api-key-value please' });

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).not.toContain('super-secret-api-key-value');
    expect(onDisk).toContain('[REDACTED]');
  });

  it('scrubs static secret patterns even with no registered secret', async () => {
    const j = await Journal.open(path); // default Redactor()
    await j.append('EXECUTE', 'RECEIPTS', [{ cmd: 'echo sk-abcdefghijklmnopqrstuvwxyz', exit: 0, outputRef: 'x' }]);

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('keeps valid JSON after redaction (the report never breaks parsing)', async () => {
    const redactor = new Redactor();
    redactor.addSecret('leaky-secret-value-here');
    const j = await Journal.open(path, redactor);
    await j.append('REPORT', 'REPORT', { text: 'result contained leaky-secret-value-here in output' });

    const line = (await readFile(path, 'utf8')).trim();
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe('Journal.open resume durability', () => {
  it('recovers valid prior events past a torn trailing line instead of throwing', async () => {
    const j = await Journal.open(path);
    await j.append('INTAKE', 'PHASE');
    await j.append('PLAN', 'PLAN', [{ desc: 'a step' }]);
    // Simulate a kill -9 mid-appendFile: a partially-flushed final line.
    await appendFile(path, '{"ts":123,"id":"abc","phase":"EXECUTE","event":"RECEIPT');

    const reopened = await Journal.open(path);
    expect(reopened.eventsAll.length).toBe(2);
    expect(reopened.eventsAll[1]?.event).toBe('PLAN');
  });
});
