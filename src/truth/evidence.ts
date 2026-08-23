// Evidence objects (PLAN §3.3): every claim passed between agents, or to the
// human, carries its source. Confidence is *derived* from that source here,
// never taken from what an agent claims about itself — a model asserting
// "confidence: verified" is exactly the failure this layer exists to catch.

export type Confidence = 'verified' | 'inferred' | 'unverified';

export type EvidenceSource =
  /** Claim about code: must cite file:line. */
  | { kind: 'file'; ref: string }
  /** Claim about behavior: must cite a command that ran. */
  | { kind: 'cmd_output'; ref: string; cmd: string; exit: number | null }
  /** Claim about the world: must cite a fetched URL. */
  | { kind: 'url'; ref: string };

export interface Evidence {
  id: string;
  claim: string;
  source?: EvidenceSource;
  confidence: Confidence;
}

const FILE_LINE_RE = /^[^\s:]+:\d+(?:-\d+)?$/;

/** PLAN §3.3 rule 1, applied structurally:
 *  - no citation           -> unverified (cannot ground further work)
 *  - a command that passed  -> verified
 *  - a command that failed or never exited -> inferred (it ran, it didn't prove)
 *  - file:line              -> verified; a bare path without a line -> inferred
 *  - a fetched URL          -> verified */
export function gradeEvidence(source: EvidenceSource | undefined): Confidence {
  if (!source) return 'unverified';
  switch (source.kind) {
    case 'cmd_output':
      return source.exit === 0 ? 'verified' : 'inferred';
    case 'file':
      return FILE_LINE_RE.test(source.ref) ? 'verified' : 'inferred';
    case 'url':
      return /^https?:\/\/\S+$/.test(source.ref) ? 'verified' : 'inferred';
  }
}

export function makeEvidence(id: string, claim: string, source?: EvidenceSource): Evidence {
  return { id, claim, source, confidence: gradeEvidence(source) };
}

/** An unverified claim cannot be the basis for further work (PLAN §3.3 rule 1). */
export function canGroundWork(evidence: Evidence): boolean {
  return evidence.confidence !== 'unverified';
}
