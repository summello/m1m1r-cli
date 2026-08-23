// Spiral-galaxy logo (PLAN §3.7.2). Full art for wide layouts, glyph fallback.
import { gradient } from './theme.js';

export const GALAXY_FULL = [
  "        .       *       .        ",
  "      .     .--=====--.     .    ",
  "         ,-'     o     '-,       ",
  "     .  /   ,-'''''''-,   \\  .  ",
  "       |   /    (@)    \\   |    ",
  "   -   |  |   ,-----,   |  |   - ",
  "       |   \\  '-----'  /   |    ",
  "     .  \\   '-.......-'   /  .  ",
  "         '-,           ,-'       ",
  "      .     '--.....--'     .    ",
  "        .       *       .        ",
];

/** Gradient-filled galaxy: rim violet -> arms orchid -> core white-hot.
 * Row bands mapped top-to-bottom so the center rows glow brightest. */
export function galaxyFull(): string[] {
  const bands = GALAXY_FULL.length;
  return GALAXY_FULL.map((line, i) => {
    const t = i / Math.max(1, bands - 1);
    if (i >= 4 && i <= 5) return gradient('core', 'nebula', line); // core rows glow
    return t < 0.5 ? gradient('violet', 'orchid', line) : gradient('orchid', 'violet', line);
  });
}

export function galaxyGlyph(): string {
  return '\u{2727}';
}

export const GALAXY_WIDTH = Math.max(...GALAXY_FULL.map((line) => line.length));
