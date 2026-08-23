// Filled block wordmark for the launch banner. Only the glyphs in "M1M1R" are
// carried — a full figlet font would be dead weight for one fixed string.
import { gradient } from './theme.js';

const GLYPHS: Record<string, string[]> = {
  M: [
    '#   #',
    '## ##',
    '# # #',
    '#   #',
    '#   #',
  ],
  '1': [
    ' # ',
    '## ',
    ' # ',
    ' # ',
    '###',
  ],
  R: [
    '### ',
    '#  #',
    '### ',
    '# # ',
    '#  #',
  ],
};

export const WORDMARK_ROWS = 5;

/** Each grid cell becomes two columns so the letterforms read as solid blocks
 * rather than hairlines. */
export function wordmarkRows(text = 'M1M1R'): string[] {
  const glyphs = [...text].map((char) => GLYPHS[char]).filter((glyph): glyph is string[] => Boolean(glyph));
  return Array.from({ length: WORDMARK_ROWS }, (_, row) =>
    glyphs
      .map((glyph) => [...glyph[row]!].map((cell) => (cell === '#' ? '██' : '  ')).join(''))
      .join('  '),
  );
}

export function wordmarkWidth(text = 'M1M1R'): number {
  return Math.max(...wordmarkRows(text).map((row) => row.length));
}

/** Horizontal nebula->violet ramp per row, so the mark reads as one gradient. */
export function wordmark(text = 'M1M1R'): string[] {
  return wordmarkRows(text).map((row) => gradient('nebula', 'violet', row));
}
