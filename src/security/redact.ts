// Secret redaction (PLAN §3.6). Patterns always on; exact-match list for
// values loaded at runtime (keychain secrets). Scrub before anything is journaled.

const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI / OpenRouter style
  /sk-ant-[^"'\s]+/g, // Anthropic
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
];

export class Redactor {
  private secrets = new Set<string>();

  /** Register a runtime secret value for exact-match scrubbing. */
  addSecret(value: string): void {
    if (value.length >= 8) this.secrets.add(value);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('[REDACTED]');
    return out.replace(
      new RegExp(PATTERNS.map((p) => p.source).join('|'), 'g'),
      '[REDACTED]',
    );
  }

  scrubAll(values: string[]): string[] {
    return values.map((v) => this.scrub(v));
  }
}

/** True when a shell command matches the hard denylist (destructive). */
export function denylisted(cmd: string): boolean {
  const denylist = [
    /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/, // rm -rf and friends
    /(^|\s)sudo(\s|$)/,
    /\bmkfs\b/,
    /\bdd\s+.*of=\/dev\//,
    /:\(\)\s*\{\s*:\|\:&\s*\};:/, // fork bomb
    /\bgit\s+push\s+.*(--force\b|-f(\s|$))/,
    /\bdrop\s+(table|database)\b/i,
    />\s*\/dev\/sd[a-z]/,
  ];
  return denylist.some((re) => re.test(cmd));
}

/** Throw when a command hits the denylist — call before any execution. */
export function denylistCheck(cmd: string): void {
  if (denylisted(cmd)) throw new Error(`command blocked by shell policy: ${cmd}`);
}
