// Loads agents/_shared/constitution.md (PLAN §3.2.1) — prepended to every
// role's system prompt. Cached; the file never changes mid-process.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CONSTITUTION_PATH = fileURLToPath(new URL('./_shared/constitution.md', import.meta.url));

let cached: string | undefined;

export async function loadConstitution(): Promise<string> {
  cached ??= await readFile(CONSTITUTION_PATH, 'utf8');
  return cached;
}
