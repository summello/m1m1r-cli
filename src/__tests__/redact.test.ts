import { describe, expect, it } from 'vitest';
import { denylistCheck, denylisted, Redactor } from '../security/redact.js';

describe('Redactor', () => {
  it('scrubs known secret patterns', () => {
    const r = new Redactor();
    expect(r.scrub('key=sk-abcdefghijklmnopqrstuvwxyz')).toBe('key=[REDACTED]');
    expect(r.scrub('token ghp_' + 'a'.repeat(36))).toContain('[REDACTED]');
  });

  it('scrubs a runtime-registered secret by exact match', () => {
    const r = new Redactor();
    r.addSecret('my-runtime-secret-value');
    expect(r.scrub('leaked: my-runtime-secret-value here')).toBe('leaked: [REDACTED] here');
  });

  it('leaves ordinary text untouched', () => {
    const r = new Redactor();
    expect(r.scrub('nothing sensitive here')).toBe('nothing sensitive here');
  });
});

describe('shell denylist', () => {
  it('blocks destructive commands', () => {
    expect(denylisted('rm -rf /')).toBe(true);
    expect(denylisted('sudo rm -rf /')).toBe(true);
    expect(denylisted('git push origin main --force')).toBe(true);
    expect(denylisted('git push origin main -f')).toBe(true);
    expect(denylisted('DROP TABLE users;')).toBe(true);
  });

  it('does not false-positive on branch names that merely contain "-f"', () => {
    expect(denylisted('git push origin feature-final')).toBe(false);
  });

  it('allows ordinary commands', () => {
    expect(denylisted('npm test')).toBe(false);
    expect(denylisted('git status')).toBe(false);
  });

  it('denylistCheck throws only on blocked commands', () => {
    expect(() => denylistCheck('rm -rf /')).toThrow();
    expect(() => denylistCheck('echo hi')).not.toThrow();
  });
});
