// Spiral-galaxy logo (PLAN §3.7.2). Filled art for the launch banner, glyph
// fallback for tight layouts.
import { gradient } from './theme.js';

// Shading carries the depth the silhouette can't at this size: ░ rim, ▒▓ arms,
// █ disc and core. Sized to sit beside the 5-row wordmark. Block-drawing only —
// ● and ◉ are ambiguous-width and would break column alignment.
export const GALAXY_FULL = [
  '   ░▒▓▓▒░   ',
  ' ░▓██▀▀██▓░ ',
  ' ▒█▌ ██ ▐█▒ ',
  ' ░▓██▄▄██▓░ ',
  '   ░▒▓▓▒░   ',
];

/** Gradient-filled galaxy: rim violet -> arms orchid -> core white-hot. */
export function galaxyFull(): string[] {
  const middle = Math.floor(GALAXY_FULL.length / 2);
  return GALAXY_FULL.map((line, index) =>
    index === middle
      ? gradient('core', 'nebula', line)
      : gradient('violet', 'orchid', line),
  );
}

export function galaxyGlyph(): string {
  return '\u{2727}';
}

export const GALAXY_WIDTH = Math.max(...GALAXY_FULL.map((line) => line.length));
