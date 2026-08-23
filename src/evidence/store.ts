// Minimal evidence layer (PLAN §3.3) — the Phase 2 slice Phase 3's gates
// structurally depend on (HANDOFF.md: "gates need something structured to
// check"). Everything passed between a gate and the conductor is an Evidence
// object — claim + source citation + confidence — not prose. The journal is
// the store (PLAN §3 architecture diagram: "EVIDENCE STORE ◄── JOURNAL"):
// evidence objects are journaled as EVIDENCE events and rebuilt by replay,
// same as every other engagement fact.
//
// Deliberately NOT the full Phase 2 truth protocol: no claim auditor, no
// OPEN_QUESTION extraction, no confidence downgrade pass over reports. Those
// stay Phase 2 scope; this file only gives gates receipts-shaped facts.

import type { Conductor, JournalEvent } from '../conductor/conductor.js';

export type Confidence = 'verified' | 'inferred' | 'unverified';

export interface EvidenceSource {
  /** What kind of artifact backs the claim (PLAN §3.3 grounding kinds plus
   * gate-specific ones). */
  kind:
    | 'cmd_output' // a shell command ran; exit code captured
    | 'diff_scan' // structural scan over a diff text
    | 'gate_finding' // a reviewer/gate reported a finding
    | 'journal'; // pointer at another journal event
  /** Citation, `journal#<event-id>` form for journal refs. */
  ref: string;
  cmd?: string;
  exit?: number | null;
}

export interface EvidenceObject {
  claim: string;
  source: EvidenceSource;
  confidence: Confidence;
}

/** Grounding rule (§3.3 rule 1): a behavior claim is only `verified` when it
 * cites a command that actually ran green. Callers may still attach
 * 'inferred' explicitly for judgment calls (e.g. an LLM reviewer's verdict),
 * never 'verified'. */
export function cmdEvidence(claim: string, ref: string, cmd: string, exit: number | null): EvidenceObject {
  return {
    claim,
    source: { kind: 'cmd_output', ref, cmd, exit },
    confidence: exit === 0 ? 'verified' : 'unverified',
  };
}

/** Journal an evidence object. The conductor's redactor scrubs the on-disk
 * copy like any other event (constitution: "Redact before it reaches a
 * journal entry"). */
export async function attachEvidence(
  conductor: Pick<Conductor, 'record'>,
  evidence: EvidenceObject,
): Promise<JournalEvent> {
  return conductor.record('EVIDENCE', evidence);
}

/** Rebuild the store from journal events (resume-safe: replay, not state). */
export function collectEvidence(events: readonly JournalEvent[]): EvidenceObject[] {
  return events
    .filter((ev) => ev.event === 'EVIDENCE')
    .map((ev) => ev.payload as EvidenceObject);
}
