// Checkpoint/rewind (PLAN §3.1). The journal is append-only by design, so
// rewind never mutates history: `rewind` forks a NEW engagement id whose
// journal is seeded by copying entries 0..seq verbatim from the source, then
// resumes normally from there (via the ordinary `m1m1r resume <new-id>`). A
// human can back out of a bad plan/implementer choice mid-engagement and retry
// from an earlier phase with a different answer to an OPEN_QUESTION, without
// losing the original run's evidence trail — it's still on disk, just
// abandoned rather than overwritten.
//
// `/rewind` in the REPL lists checkpointable journal positions (phase
// transitions, gate passes, question answers) rather than every raw event;
// this module is where that list comes from.
//
// Important: seq indices refer to *parsed event positions* (same as
// Journal.eventsAll), not raw file line numbers. Journal.open skips malformed
// lines (e.g. torn trailing lines from kill -9), so we must parse the same
// way to keep listCheckpoints and rewindEngagement in sync.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface Checkpoint {
  /** 0-based parsed-event index — the `<journal-seq>` argument to rewind. */
  seq: number;
  ts: number;
  phase: string;
  event: string;
  label: string;
}

const CHECKPOINT_EVENTS = new Set(['PHASE', 'SKIPPED', 'AUTO_APPROVED', 'QUESTION_ANSWERED']);

function isCheckpoint(ev: { event: string; payload?: unknown }): boolean {
  if (CHECKPOINT_EVENTS.has(ev.event)) return true;
  if (ev.event === 'GATE_RESULT') {
    return Boolean((ev.payload as { pass?: boolean } | undefined)?.pass);
  }
  return false;
}

function checkpointLabel(ev: { event: string; phase: string; payload?: unknown }): string {
  switch (ev.event) {
    case 'PHASE':
      return `phase -> ${ev.phase}`;
    case 'SKIPPED':
      return `skipped -> ${ev.phase}`;
    case 'AUTO_APPROVED':
      return `plan approved (${ev.phase})`;
    case 'QUESTION_ANSWERED':
      return `question answered: ${(ev.payload as { id?: string } | undefined)?.id ?? '?'}`;
    case 'GATE_RESULT': {
      const p = ev.payload as { gate?: string };
      return `gate passed: ${p.gate ?? '?'}`;
    }
    default:
      return ev.event;
  }
}

/** Parse journal file the same way Journal.open does: one JSON object per
 * non-empty line, skipping malformed lines. Returns (event, originalLine) pairs
 * so callers can use parsed indices for seq while writing verbatim original lines. */
async function parseJournalLines(
  path: string,
): Promise<Array<{ event: { ts: number; phase: string; event: string; payload?: unknown }; originalLine: string }>> {
  const raw = await readFile(path, 'utf8');
  const out: Array<{ event: { ts: number; phase: string; event: string; payload?: unknown }; originalLine: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ts: number; phase: string; event: string; payload?: unknown };
      out.push({ event: parsed, originalLine: trimmed });
    } catch {
      // Skip malformed lines — same as Journal.open
    }
  }
  return out;
}

/** Checkpointable positions in a journal's events (index = parsed event seq). */
export function listCheckpoints(
  events: ReadonlyArray<{ ts: number; phase: string; event: string; payload?: unknown }>,
): Checkpoint[] {
  return events
    .map((ev, seq) => ({ seq, ev }))
    .filter(({ ev }) => isCheckpoint(ev))
    .map(({ seq, ev }) => ({
      seq,
      ts: ev.ts,
      phase: ev.phase,
      event: ev.event,
      label: checkpointLabel(ev),
    }));
}

/** Fork a new engagement at `seq`: copy journal lines 0..seq (inclusive)
 * byte-for-byte into the new engagement dir. Returns the new engagement id.
 * The source journal is never touched. Verbatim copy is the whole point —
 * every event id, timestamp, and evidence reference stays identical, so the
 * forked run's evidence trail points at real receipts that actually exist in
 * its own journal.
 *
 * `seq` is a parsed-event index (matching listCheckpoints output), not a raw
 * line number — Journal.open skips malformed lines, so we parse the same way
 * to stay in sync. */
export async function rewindEngagement(
  srcJournalPath: string,
  destEngagementDir: string,
  newId: string,
  seq: number,
): Promise<string> {
  const parsed = await parseJournalLines(srcJournalPath);
  if (!Number.isInteger(seq) || seq < 0 || seq >= parsed.length) {
    throw new Error(`invalid journal seq ${seq} — journal has ${parsed.length} parsed events`);
  }
  const prefix = parsed.slice(0, seq + 1).map((p) => p.originalLine);
  await mkdir(destEngagementDir, { recursive: true });
  await writeFile(join(destEngagementDir, 'journal.jsonl'), prefix.join('\n') + '\n');
  return newId;
}
