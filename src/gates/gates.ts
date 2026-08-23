// Quality gates (PLAN §3.5) wired as conductor exit criteria — Phase 3.
//
// Four gates, each producing a GateResult journaled as a GATE_RESULT event
// whose payload IS the structured result (findings + evidence refs), so the
// conductor always reads artifacts, never agent prose (§3.3 rule 3):
//   security   — structural secret/dangerous-API scan over the diff text plus
//                an LLM threat-model pass (security-reviewer role)
//   review     — adversarial correctness refutation of the diff
//                (code-reviewer role)
//   regression — receipts-based: every captured TEST_RECEIPT of surviving
//                tasks exited 0
//   integrate  — post-merge suite green (with ×3 flake discrimination) +
//                conflict-free merges
//
// Hooks (§3.6) wrap every gate: `pre-gate` non-zero exit FAILS the gate
// before its own checks run (a project hook can fail a gate that would
// otherwise pass — Phase 3 done-criterion); `post-gate` non-zero exit fails
// an otherwise-passing gate. Neither direction can ever turn a FAILED gate
// into a PASS — hooks are additive friction, never a bypass.
//
// Resume contract: every gate result lives in the journal, so a resumed
// engagement skips re-running gates that already passed (see
// alreadyPassed()). Gates are exit criteria, not recurring toll booths.

import { SECRET_PATTERNS } from '../security/redact.js';
import type { Conductor, JournalEvent } from '../conductor/conductor.js';
import { runToolLoop, type OpenAiCompat } from '../providers/openai-compat.js';
import { cmdEvidence, type EvidenceObject } from '../evidence/store.js';

export type Severity = 'critical' | 'major' | 'minor';

export interface GateFinding {
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  /** Where the finding came from — receipts stay attributable. */
  origin: 'scan' | 'reviewer' | 'hook' | 'merge' | 'receipts';
}

export interface GateResult {
  gate: 'security' | 'review' | 'regression' | 'integrate' | string;
  pass: boolean;
  taskId?: string;
  findings: GateFinding[];
  /** `journal#<event-id>` citations backing this verdict (§3.7.5: every
   * rendered fact names its source). */
  evidenceRefs: string[];
  /** Set when the suite was inconsistent across re-runs — broken vs flaky
   * is the distinction §7's risk table demands. */
  flaky?: boolean;
}

const BLOCKING: ReadonlyArray<Severity> = ['critical', 'major'];

function blocking(findings: GateFinding[]): boolean {
  return findings.some((f) => BLOCKING.includes(f.severity));
}

async function journalEvidence(conductor: Conductor, ev: EvidenceObject): Promise<string> {
  const evt = await conductor.record('EVIDENCE', ev);
  return `journal#${evt.id}`;
}

/** Run one gate with hook wrapping + journaling shared by all four gates.
 * `check` produces the verdict; hooks add friction around it without being
 * able to flip a failure into a pass. */
async function runGate(
  conductor: Conductor,
  args: {
    gate: string;
    taskId?: string;
    check: () => Promise<{ findings: GateFinding[]; evidence: EvidenceObject[]; flaky?: boolean }>;
  },
): Promise<GateResult> {
  const hookPayload = { gate: args.gate, ...(args.taskId ? { taskId: args.taskId } : {}) };
  const hookEnv = { phase: conductor.state.phase, engagementDir: conductor.dir };
  let findings: GateFinding[] = [];
  let flaky: boolean | undefined;
  let evidence: EvidenceObject[] = [];

  if (conductor.hooks) {
    const pre = await conductor.hooks.fire('pre-gate', hookPayload, hookEnv);
    if (pre.fired && !pre.ok) {
      findings.push({
        severity: 'critical',
        title: `pre-gate hook blocked ${args.gate}`,
        detail: (pre.output ?? '').slice(0, 1000),
        origin: 'hook',
      });
      // Hook-blocked gates still need evidence for the DoD checklist
      evidence.push({
        claim: `pre-gate hook blocked ${args.gate}`,
        source: { kind: 'gate_finding', ref: 'hook-output' },
        confidence: 'unverified',
      });
    }
  }

  if (findings.length === 0) {
    const out = await args.check();
    findings = out.findings;
    evidence = out.evidence;
    flaky = out.flaky;
  }

  // Post-gate hook fires regardless of gate outcome (additive friction on both
  // pass and fail). It can turn a PASS into a FAIL, but never rescues a FAIL.
  if (conductor.hooks) {
    const post = await conductor.hooks.fire('post-gate', { ...hookPayload, pass: !blocking(findings) }, hookEnv);
    if (post.fired && !post.ok) {
      findings.push({
        severity: 'critical',
        title: `post-gate hook blocked ${args.gate}`,
        detail: (post.output ?? '').slice(0, 1000),
        origin: 'hook',
      });
      evidence.push({
        claim: `post-gate hook blocked ${args.gate}`,
        source: { kind: 'gate_finding', ref: 'hook-output' },
        confidence: 'unverified',
      });
    }
  }

  const evidenceRefs: string[] = [];
  for (const ev of evidence) evidenceRefs.push(await journalEvidence(conductor, ev));

  const result: GateResult = {
    gate: args.gate,
    pass: !blocking(findings),
    findings,
    evidenceRefs,
  };
  if (args.taskId) result.taskId = args.taskId;
  if (flaky) result.flaky = true;
  await conductor.record('GATE_RESULT', result);
  return result;
}

/** True when this engagement's journal already holds a passing verdict for
 * this gate (+task) — resumed runs skip re-running it. */
export function alreadyPassed(
  events: readonly JournalEvent[],
  gate: string,
  taskId?: string,
): boolean {
  return events.some((ev) => {
    if (ev.event !== 'GATE_RESULT') return false;
    const p = ev.payload as Partial<GateResult> | undefined;
    return Boolean(
      p &&
        p.gate === gate &&
        p.pass === true &&
        p.findings !== undefined &&
        (taskId === undefined ? p.taskId === undefined : p.taskId === taskId),
    );
  });
}

/** Rebuild every gate verdict from the journal — the DoD checklist's raw
 * material. Tolerates the pre-Phase-3 lite payloads ({gate, pass, failures})
 * the Phase 0 flow still writes. */
export function gatesFromJournal(events: readonly JournalEvent[]): GateResult[] {
  const out: GateResult[] = [];
  for (const ev of events) {
    if (ev.event !== 'GATE_RESULT') continue;
    const p = ev.payload as Partial<GateResult> & { failures?: unknown };
    out.push({
      gate: p.gate ?? '?',
      pass: p.pass ?? false,
      taskId: p.taskId,
      findings: p.findings ?? [],
      evidenceRefs: p.evidenceRefs ?? [],
      flaky: p.flaky,
    });
  }
  return out;
}

/** Task ids rejected by any task-level gate — exactly what must be excluded
 * from the merge, derived from the journal so resume agrees with the first
 * run. */
export function blockedTaskIds(events: readonly JournalEvent[]): Set<string> {
  const blocked = new Set<string>();
  for (const r of gatesFromJournal(events)) {
    if (!r.pass && r.taskId) blocked.add(r.taskId);
  }
  return blocked;
}

// ── structural scans ────────────────────────────────────────────────────────

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

/** Added (+) lines with file/line attribution, parsed from unified-diff hunks.
 * Only additions are scanned: pre-existing problems aren't this diff's fault
 * (minimal-blast-radius principle applies to review scope too). */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let lineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).trim();
      if (file.startsWith('b/')) file = file.slice(2);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!file || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ')) continue;
    if (line === '\\ No newline at end of file') continue; // git marker, not content
    if (line.startsWith('+')) {
      out.push({ file, line: lineNo, text: line.slice(1) });
      lineNo++;
    } else if (line.startsWith('-')) {
      // removal — doesn't advance the new-file line counter
    } else {
      lineNo++;
    }
  }
  return out;
}

/** Secret scan over added lines — same pattern list the redactor scrubs with,
 * so the scanner can never drift from what the journal layer considers a
 * secret. Reports location + pattern name, never echoes the value itself. */
export function scanSecrets(diff: string): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const l of addedLines(diff)) {
    for (const p of SECRET_PATTERNS) {
      const re = new RegExp(p.re.source, p.re.flags.replace('g', ''));
      if (re.test(l.text)) {
        findings.push({
          severity: 'critical',
          title: `possible secret committed (${p.name})`,
          detail: `${l.file}:${l.line} adds a value matching the ${p.name} pattern`,
          file: l.file,
          origin: 'scan',
        });
        break; // one finding per line — five patterns on one key is noise
      }
    }
  }
  return findings;
}

const DANGEROUS_APIS: Array<{ name: string; re: RegExp }> = [
  { name: 'eval()', re: /\beval\s*\(/ },
  { name: 'new Function()', re: /new\s+Function\s*\(/ },
  { name: 'TLS validation disabled', re: /rejectUnauthorized['"]?\s*[:=]\s*false/ },
  { name: 'shell interpolation', re: /(child_process|execSync|spawnSync)/ },
];

export function scanDangerousApis(diff: string): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const l of addedLines(diff)) {
    for (const api of DANGEROUS_APIS) {
      if (api.re.test(l.text)) {
        findings.push({
          severity: 'major',
          title: `dangerous API introduced (${api.name})`,
          detail: `${l.file}:${l.line}: ${api.name}`,
          file: l.file,
          origin: 'scan',
        });
        break;
      }
    }
  }
  return findings;
}

// ── LLM reviewer plumbing ───────────────────────────────────────────────────

interface RawFinding {
  severity?: string;
  title?: string;
  detail?: string;
  file?: string;
}

/** Parse a reviewer's JSON findings payload. Unparseable output becomes a
 * major finding itself (fails closed) — a reviewer that won't produce
 * structured findings hasn't verified anything, and silence must never read
 * as approval. Unknown severities map to major (conservative). */
export function parseFindings(text: string): GateFinding[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return [
      {
        severity: 'major',
        title: 'reviewer produced no parseable findings payload',
        detail: text.slice(0, 500),
        origin: 'reviewer',
      },
    ];
  }
  try {
    const parsed = JSON.parse(match[0]) as { findings?: RawFinding[] };
    const raw = parsed.findings ?? [];
    if (!Array.isArray(parsed.findings)) {
      return [
        {
          severity: 'major',
          title: 'reviewer payload malformed (findings not a list)',
          detail: text.slice(0, 500),
          origin: 'reviewer',
        },
      ];
    }
    return raw.map((f) => ({
      severity: f.severity === 'critical' || f.severity === 'minor' ? f.severity : ('major' as const),
      title: f.title ?? 'untitled finding',
      detail: f.detail ?? '',
      ...(f.file ? { file: f.file } : {}),
      origin: 'reviewer' as const,
    }));
  } catch {
    return [
      {
        severity: 'major',
        title: 'reviewer output was not valid JSON',
        detail: text.slice(0, 500),
        origin: 'reviewer',
      },
    ];
  }
}

async function reviewerFindings(args: {
  client: OpenAiCompat;
  systemPrompt: string;
  userPrompt: string;
  shouldStop?: () => boolean;
}): Promise<GateFinding[]> {
  const { content } = await runToolLoop(
    args.client,
    args.systemPrompt,
    args.userPrompt,
    [], // read-only by construction: no tools offered, the diff is inline
    async () => '',
    2,
    args.shouldStop,
  );
  return parseFindings(content);
}

// ── the four gates ──────────────────────────────────────────────────────────

export async function runSecurityGate(
  conductor: Conductor,
  args: {
    taskId: string;
    diffText: string;
    reviewerSystemPrompt?: string;
    reviewClient?: OpenAiCompat;
    shouldStop?: () => boolean;
  },
): Promise<GateResult> {
  return runGate(conductor, {
    gate: 'security',
    taskId: args.taskId,
    check: async () => {
      const scanFindings = [...scanSecrets(args.diffText), ...scanDangerousApis(args.diffText)];
      let reviewer: GateFinding[] = [];
      if (args.reviewClient && args.reviewerSystemPrompt) {
        reviewer = await reviewerFindings({
          client: args.reviewClient,
          systemPrompt: args.reviewerSystemPrompt,
          userPrompt: `Task id: ${args.taskId}\nDiff to threat-model:\n\n${args.diffText}`,
          shouldStop: args.shouldStop,
        });
      }
      const findings = [...scanFindings, ...reviewer];
      const evidence: EvidenceObject[] = [
        {
          claim: `secret/dangerous-API scan over ${args.taskId}'s diff found ${scanFindings.length} issue(s)`,
          source: { kind: 'diff_scan', ref: `worktree:${args.taskId}` },
          confidence: 'verified',
        },
      ];
      if (args.reviewClient) {
        evidence.push({
          claim: `security-reviewer reported ${reviewer.length} finding(s) on ${args.taskId}`,
          source: { kind: 'gate_finding', ref: 'reviewer-response' },
          confidence: 'inferred',
        });
      }
      return { findings, evidence };
    },
  });
}

export async function runReviewGate(
  conductor: Conductor,
  args: {
    taskId: string;
    diffText: string;
    acceptanceCriteria: string;
    reviewerSystemPrompt: string;
    reviewClient: OpenAiCompat;
    shouldStop?: () => boolean;
  },
): Promise<GateResult> {
  return runGate(conductor, {
    gate: 'review',
    taskId: args.taskId,
    check: async () => {
      const findings = await reviewerFindings({
        client: args.reviewClient,
        systemPrompt: args.reviewerSystemPrompt,
        userPrompt:
          `Task id: ${args.taskId}\nAcceptance criteria: ${args.acceptanceCriteria}\n` +
          `Diff to refute:\n\n${args.diffText}`,
        shouldStop: args.shouldStop,
      });
      return {
        findings,
        evidence: [
          {
            claim: `code-reviewer reported ${findings.length} finding(s) on ${args.taskId}`,
            source: { kind: 'gate_finding', ref: 'reviewer-response' },
            confidence: 'inferred',
          },
        ],
      };
    },
  });
}

/** Receipts-based: every captured TEST_RECEIPT of the tasks still merging
 * exited 0. Reads artifacts the EXECUTE phase already journaled — no re-run,
 * per §3.3 rule 3 ("the conductor parses artifacts"). */
export async function runRegressionGate(
  conductor: Conductor,
  args: { receipts: Array<{ taskId: string; cmd: string; exit: number | null }> },
): Promise<GateResult> {
  return runGate(conductor, {
    gate: 'regression',
    check: async () => {
      const findings: GateFinding[] = [];
      const evidence: EvidenceObject[] = [];
      for (const r of args.receipts) {
        const exitCode = r.exit ?? 'unknown';
        evidence.push(cmdEvidence(`${r.cmd} exited ${exitCode} (${r.taskId})`, 'receipt', r.cmd, r.exit));
        if (r.exit !== 0) {
          findings.push({
            severity: 'critical',
            title: `captured command failed: ${r.cmd}`,
            detail: `${r.taskId}: exit ${r.exit}`,
            origin: 'receipts',
          });
        }
      }
      return { findings, evidence };
    },
  });
}

/** Post-merge: conflict-free merges + the configured suite green on the
 * merged tree. A failing suite re-runs up to ×3 total (§3.5 "flakes re-run
 * ×3"): consistent failure = broken, inconsistent = flaky — both fail the
 * gate, the label tells the human which kind of bad day they're having. */
export async function runIntegrateGate(
  conductor: Conductor,
  args: {
    repoRoot: string;
    testCommand?: string;
    runTestCommand?: (cwd: string, cmd: string) => Promise<{ ok: boolean; output: string }>;
    merges: Array<{ id: string; ok: boolean; conflict: boolean }>;
    shouldStop?: () => boolean;
  },
): Promise<GateResult> {
  return runGate(conductor, {
    gate: 'integrate',
    check: async () => {
      const findings: GateFinding[] = args.merges
        .filter((m) => !m.ok)
        .map((m) => ({
          severity: 'critical' as const,
          title: `merge conflict for ${m.id}`,
          detail: m.conflict ? 'merge aborted — needs resolution' : 'merge failed',
          origin: 'merge' as const,
        }));

      let flaky: boolean | undefined;
      if (args.testCommand && args.runTestCommand) {
        let last = { ok: false, output: '' };
        let attempts = 0;
        let failed = 0;
        let passed = 0;
        // Re-run ×3 max; stop early once the verdict is known. A suite that
        // both fails and passes inside one gate run is FLAKY — it still fails
        // this gate (a green re-run doesn't un-see the red one), but the
        // label tells the human this is instability, not breakage. Resuming
        // re-runs the gate fresh; three consecutive greens on resume clear it.
        while (attempts < 3) {
          attempts++;
          last = await args.runTestCommand(args.repoRoot, args.testCommand);
          await conductor.record('TEST_RECEIPT', {
            taskId: `integration-attempt-${attempts}`,
            cmd: args.testCommand,
            exit: last.ok ? 0 : 1,
            outputRef: last.output.slice(0, 1000),
          });
          if (last.ok) {
            passed++;
            if (failed === 0) break; // clean pass on first try
            // flaky: we have both pass and fail, stop here
            break;
          } else {
            failed++;
          }
          if (args.shouldStop?.()) break;
        }
        const suiteGreen = failed === 0 && passed > 0;
        flaky = failed > 0 && passed > 0;
        if (!suiteGreen) {
          findings.push({
            severity: 'critical',
            title: flaky ? 'integration suite FLAKY (inconsistent across re-runs)' : 'integration suite BROKEN',
            detail: `${args.testCommand}: ${passed} pass / ${failed} fail over ${attempts} attempt(s); last output:\n${last.output.slice(0, 500)}`,
            origin: 'receipts',
          });
        }
        return {
          findings,
          flaky,
          evidence: [
            cmdEvidence(
              `${args.testCommand} green on merged tree`,
              'receipt',
              args.testCommand,
              suiteGreen ? 0 : 1,
            ),
          ],
        };
      }
      findings.push({
        severity: 'minor',
        title: 'no test command configured',
        detail: 'integrate gate verified merges only; suite greenness is unverified',
        origin: 'receipts',
      });
      return {
        findings,
        evidence: [
          {
            claim: 'merged tree accepted (no test command configured)',
            source: { kind: 'journal', ref: 'MERGE_RESULTS' },
            confidence: 'unverified',
          },
        ],
      };
    },
  });
}

/** Definition-of-Done checklist (§3.5): one line per gate verdict, every line
 * printing its receipts (Phase 3 done-criterion). Renders plain ASCII so it's
 * safe in journals and non-TTY output alike. */
export function dodChecklist(results: readonly GateResult[]): string {
  if (results.length === 0) return 'Definition of Done:\n  (no gate results journaled)';
  const lines = results.map((r) => {
    const mark = r.pass ? '[PASS]' : '[FAIL]';
    const label = r.taskId ? `${r.gate}:${r.taskId}` : r.gate;
    const receipts = r.evidenceRefs.length > 0 ? `receipts: ${r.evidenceRefs.join(', ')}` : 'receipts: none';
    const worst = r.findings.find((f) => f.severity !== 'minor');
    const note = worst ? ` — ${worst.title}` : '';
    return `  ${mark} ${label}${note}\n      ${receipts}`;
  });
  return ['Definition of Done:', ...lines].join('\n');
}
