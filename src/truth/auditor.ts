// Claim auditor (PLAN §3.3 rule 4): before a final report reaches the human,
// every factual sentence is replayed against the evidence store. Supported
// sentences are tagged inline; unsupported ones are struck rather than deleted,
// so the human can see what the model asserted without backing.

import type { Confidence, Evidence } from './evidence.js';

export interface AuditedClaim {
  sentence: string;
  confidence: Confidence;
  evidenceId?: string;
  struck: boolean;
}

export interface AuditResult {
  text: string;
  claims: AuditedClaim[];
  struckCount: number;
}

// Overlap needed between a sentence and an evidence claim to count as the same
// assertion. Tuned so a paraphrase still matches but a different claim about
// the same subsystem does not.
const MATCH_THRESHOLD = 0.6;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'will', 'with',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      // `.` `/` `-` stay inside a token so `src/auth.ts:42` survives whole,
      // which means sentence punctuation has to be trimmed from the edges
      // afterwards — otherwise "passes." never matches "passes".
      .split(/[^a-z0-9_./-]+/)
      .map((word) => word.replace(/^[.\-/]+|[.\-/]+$/g, ''))
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

/** Fraction of the sentence's own meaningful words that the evidence claim
 * also contains. Asymmetric on purpose: a short evidence claim should still
 * support a sentence that restates it with extra words, but a sentence that
 * asserts more than the evidence does should not pass. */
function overlap(sentence: Set<string>, claim: Set<string>): number {
  if (sentence.size === 0) return 0;
  let shared = 0;
  for (const word of sentence) if (claim.has(word)) shared += 1;
  return shared / sentence.size;
}

/** Lines that assert nothing on their own — headings, blanks, and everything
 * inside a code fence pass through untouched rather than being struck. The
 * fence has to be tracked as state: its *contents* are what must be skipped,
 * and those lines look like ordinary prose on their own. */
function proseLines(report: string): boolean[] {
  let inFence = false;
  return report.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      return false;
    }
    if (inFence) return false;
    if (!trimmed) return false;
    return !trimmed.startsWith('#');
  });
}

function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])\s+/).filter((part) => part.trim().length > 0);
}

export function auditReport(report: string, evidence: readonly Evidence[]): AuditResult {
  const graded = evidence.map((item) => ({ item, words: tokens(item.claim) }));
  const claims: AuditedClaim[] = [];

  const isProse = proseLines(report);
  const text = report
    .split('\n')
    .map((line, lineIndex) => {
      if (!isProse[lineIndex]) return line;
      const audited = splitSentences(line).map((sentence) => {
        const sentenceWords = tokens(sentence);
        let best: { item: Evidence; score: number } | undefined;
        for (const { item, words } of graded) {
          const score = overlap(sentenceWords, words);
          if (!best || score > best.score) best = { item, score };
        }
        const supported = best !== undefined && best.score >= MATCH_THRESHOLD;
        // Unverified evidence cannot support a claim any more than no evidence
        // can — that is what "cannot be a basis for further work" means here.
        const usable = supported && best!.item.confidence !== 'unverified';
        const claim: AuditedClaim = usable
          ? {
              sentence,
              confidence: best!.item.confidence,
              evidenceId: best!.item.id,
              struck: false,
            }
          : { sentence, confidence: 'unverified', struck: true };
        claims.push(claim);
        return renderClaim(claim);
      });
      return audited.join(' ');
    })
    .join('\n');

  return { text, claims, struckCount: claims.filter((claim) => claim.struck).length };
}

function renderClaim(claim: AuditedClaim): string {
  if (claim.struck) return `~~${claim.sentence}~~ [unsupported]`;
  return `${claim.sentence} ${claim.confidence === 'verified' ? '[verified]' : '[assumed]'}`;
}

/** Share of report sentences that survived the audit — the hallucination-rate
 * metric PLAN §6's parallel eval track tracks per release. */
export function survivalRate(result: AuditResult): number {
  if (result.claims.length === 0) return 1;
  return (result.claims.length - result.struckCount) / result.claims.length;
}
