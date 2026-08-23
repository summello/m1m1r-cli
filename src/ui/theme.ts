// Nebula theme (PLAN §3.7.1) — tokens, semantic colors, gradient renderer,
// fallback ladder: truecolor -> 256-color -> mono.

export type TokenName =
  | 'void'
  | 'chrome'
  | 'violet'
  | 'nebula'
  | 'orchid'
  | 'core'
  | 'ok'
  | 'warn'
  | 'alert'
  | 'dim';

export const TOKENS: Record<TokenName, string> = {
  void: '#0d0a14',
  chrome: '#6d28d9',
  violet: '#8b5cf6',
  nebula: '#ff6ec7',
  orchid: '#c084fc',
  core: '#fef3ff',
  ok: '#34d399',
  warn: '#fbbf24',
  alert: '#f87171',
  dim: '#6b7280',
};

export type ColorSupport = 'truecolor' | '256' | 'mono';

export function detectSupport(env: NodeJS.ProcessEnv = process.env): ColorSupport {
  if ('NO_COLOR' in env) return 'mono';
  const term = env.TERM ?? '';
  if (term === 'dumb') return 'mono';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  if (term.includes('256color')) return '256';
  if (env.TERMINAL_EMULATOR || env.ITERM_SESSION_ID || env.WT_SESSION) return 'truecolor';
  return term ? '256' : 'mono';
}

let support: ColorSupport | undefined;

export function setSupport(s: ColorSupport): void {
  support = s;
}

export function getSupport(): ColorSupport {
  support ??= detectSupport();
  return support;
}

/** Color value for Ink's Text/Box props. Undefined in mono mode so Ink emits
 * no color sequences at all. */
export function tokenColor(token: TokenName): string | undefined {
  return getSupport() === 'mono' ? undefined : TOKENS[token];
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export const RESET = '\x1b[0m';

function fgTruecolor(rgb: [number, number, number], text: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${RESET}`;
}

// Nearest entry in the xterm-256 palette (6x6x6 cube vs grayscale ramp).
function nearest256(r: number, g: number, b: number): number {
  const d = (a: [number, number, number], c: [number, number, number]) =>
    (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
  const [cr, cg, cb] = [q(r), q(g), q(b)];
  const cubeRgb: [number, number, number] = [
    cr ? 55 + cr * 40 : 0,
    cg ? 55 + cg * 40 : 0,
    cb ? 55 + cb * 40 : 0,
  ];
  const candidates: Array<{ idx: number; rgb: [number, number, number] }> = [
    { idx: 16 + 36 * cr + 6 * cg + cb, rgb: cubeRgb },
  ];
  if (r === g && g === b) {
    const gi = Math.max(0, Math.min(23, Math.round((r - 8) / 10)));
    candidates.push({ idx: 232 + gi, rgb: [8 + gi * 10, 8 + gi * 10, 8 + gi * 10] });
  }
  candidates.sort((x, y) => d([r, g, b], x.rgb) - d([r, g, b], y.rgb));
  return candidates[0]!.idx;
}

function fg256(hex: string, text: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;5;${nearest256(r, g, b)}m${text}${RESET}`;
}

/** Paint text with a token color, honoring the support ladder. */
export function fg(token: TokenName, text: string): string {
  if (getSupport() === 'mono') return text;
  const hex = TOKENS[token];
  return getSupport() === 'truecolor' ? fgTruecolor(hexToRgb(hex), text) : fg256(hex, text);
}

/** Interpolate two tokens across text, one color per character (gradient). */
export function gradient(from: TokenName, to: TokenName, text: string): string {
  if (getSupport() === 'mono') return text;
  const a = hexToRgb(TOKENS[from]);
  const b = hexToRgb(TOKENS[to]);
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  let out = '';
  chars.forEach((ch, i) => {
    const t = i / n;
    const rgb: [number, number, number] = [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
    out += getSupport() === 'truecolor' ? fgTruecolor(rgb, ch) : fg256(rgbToHex(rgb), ch);
  });
  return out;
}

function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Horizontal gradient rule of `width` columns using box-drawing char. */
export function gradientRule(width: number, char = '─'): string {
  return gradient('nebula', 'violet', char.repeat(Math.max(0, width)));
}
