// Role registry (PLAN §3.2): loads `agents/roles/*.md` — YAML-ish
// frontmatter (name/description/model tier/tools) + a Markdown body that
// becomes the role's system prompt, prepended with the shared constitution
// (§3.2.1). Phase 1 only ships the two LLM roles the DAG done-criterion
// actually needs (planner, implementer) — `integrator` (PLAN §3.2) is
// deliberately pure TypeScript in this phase (src/exec/worktree.ts's
// mergeInto + a test-suite run), not an LLM role: Phase 1's scope decision
// is "no auto-conflict-resolution," so there's no judgment call for a model
// to make yet — an LLM integrator role becomes worth authoring once
// conflict *resolution* (not just detection) is in scope. The other nine
// roles from PLAN.md's roster table (clarifier, researcher, test-engineer,
// security-reviewer, code-reviewer, auditor, devops, saas-ops, pr-watcher)
// are a real, tracked gap, not silently dropped: the loader itself is
// generic over any `<name>.md` file, so adding a role later is authoring one
// file, not touching this code.
//
// ponytail: frontmatter parsing is deliberately not real YAML — a handful of
// scalar fields plus one comma-separated list don't need a dependency. If a
// role file ever needs nested structure, reach for a real parser then.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConstitution } from './constitution.js';

export interface RoleDefinition {
  name: string;
  description: string;
  /** Tier alias (e.g. "opus"/"sonnet"/"haiku") — resolved to a real
   * provider/model by the tier-binding config (PLAN §4.1), not by this file. */
  model: string;
  tools: string[];
  /** Constitution + this role's own prompt body, ready to use as a system prompt. */
  systemPrompt: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export async function loadRole(rolesDir: string, name: string): Promise<RoleDefinition> {
  const raw = await readFile(join(rolesDir, `${name}.md`), 'utf8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`role file ${name}.md is missing --- frontmatter`);
  const fm = parseFrontmatter(match[1]!);
  const body = match[2]!.trim();
  const constitution = await loadConstitution();
  return {
    name: fm.name ?? name,
    description: fm.description ?? '',
    model: fm.model ?? 'sonnet',
    tools: fm.tools ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean) : [],
    systemPrompt: `${constitution}\n\n${body}`,
  };
}

export const DEFAULT_ROLES_DIR = fileURLToPath(new URL('./roles/', import.meta.url));
