// OPEN_QUESTION protocol (PLAN §3.3 rule 2 and rule 5). Missing information
// must become a question, never an invented value — so the shape is validated
// structurally here rather than trusted from the model's output. A question
// without an example or a proposed default is the failure mode this guards:
// it reads as a question but gives the human nothing to decide with.

import type { OpenQuestion } from '../conductor/conductor.js';

export class MalformedQuestionError extends Error {}

interface RawQuestion {
  id?: unknown;
  blocking?: unknown;
  questionLayman?: unknown;
  question_layman?: unknown;
  example?: unknown;
  proposedDefault?: unknown;
  proposed_default?: unknown;
  options?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Jargon that means nothing to the human answering. The layman renderer's job
 * is to keep these out of the question itself (PLAN §3.3 rule 5). */
const JARGON = /\b(nullable|foreign key|idempotent|middleware|schema migration|mutex|serializ)/i;

export function parseOpenQuestion(raw: unknown): OpenQuestion {
  if (!raw || typeof raw !== 'object') {
    throw new MalformedQuestionError('question must be an object');
  }
  const input = raw as RawQuestion;
  const id = text(input.id);
  const questionLayman = text(input.questionLayman) ?? text(input.question_layman);
  const example = text(input.example);
  const proposedDefault = text(input.proposedDefault) ?? text(input.proposed_default);

  if (!id) throw new MalformedQuestionError('question is missing an id');
  if (!questionLayman) throw new MalformedQuestionError(`question ${id} is missing question_layman`);
  if (!example) {
    throw new MalformedQuestionError(
      `question ${id} has no example — a question the human cannot picture is a guess in disguise`,
    );
  }
  if (!proposedDefault) {
    throw new MalformedQuestionError(`question ${id} has no proposed_default`);
  }
  if (JARGON.test(questionLayman)) {
    throw new MalformedQuestionError(
      `question ${id} is not in layman's terms: ${questionLayman}`,
    );
  }

  const options = Array.isArray(input.options)
    ? input.options
        .map((option) => {
          const item = option as { id?: unknown; label?: unknown; description?: unknown };
          const optionId = text(item.id);
          const label = text(item.label);
          return optionId && label
            ? { id: optionId, label, description: text(item.description) }
            : undefined;
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option))
    : undefined;

  return {
    id,
    blocking: input.blocking === true,
    questionLayman,
    example,
    proposedDefault,
    ...(options && options.length > 0 ? { options } : {}),
  };
}

/** Render one question the way PLAN §3.3 rule 5 specifies, for non-TTY output
 * and for the report. The interactive cockpit uses QuestionCard instead. */
export function renderQuestion(question: OpenQuestion): string {
  const lines = [`Q: ${question.questionLayman}`];
  if (question.example) lines.push(question.example);
  for (const option of question.options ?? []) {
    lines.push(`  • ${option.label}${option.description ? ` — ${option.description}` : ''}`);
  }
  if (question.proposedDefault) {
    lines.push(`Proposed default: ${question.proposedDefault}. Reply ok to accept, or say what you want.`);
  }
  return lines.join('\n');
}

/** Questions batch into one review screen — no drip-interruption (PLAN §3.3).
 * Blocking questions sort first so the screen leads with what actually stops
 * work. */
export function batchQuestions(questions: readonly OpenQuestion[]): OpenQuestion[] {
  return [...questions].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}
