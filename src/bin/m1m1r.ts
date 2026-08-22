#!/usr/bin/env node
// CLI entry (PLAN §6 Phase 0: "CLI boots; one engagement runs end-to-end").
// Commands: `m1m1r <requirement>` starts one, `m1m1r resume <id>` continues
// one, `m1m1r secret <set|get|delete> <account> [value]` wraps the keychain.

import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { engagementDir, runEngagement } from '../agents/generic-agent.js';
import { Conductor, loadConfig, newEngagementId } from '../conductor/conductor.js';
import { OpenAiCompat } from '../providers/openai-compat.js';
import { secretDelete, secretGet, secretSet } from '../providers/keychain.js';
import { Redactor } from '../security/redact.js';
import { INITIAL_UI_STATE, UiStore } from '../ui/store.js';
import { writeStatusline } from '../ui/statusline.js';

const ENGAGEMENTS_ROOT = join(process.cwd(), '.m1m1r', 'engagements');

function extractFlag(args: string[], name: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) {
      value = args[++i];
      continue;
    }
    if (a.startsWith(`--${name}=`)) {
      value = a.slice(name.length + 3);
      continue;
    }
    rest.push(a);
  }
  return { value, rest };
}

async function resolveApiKey(): Promise<string> {
  const fromEnv = process.env.M1M1R_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    return await secretGet('OPENROUTER_API_KEY');
  } catch {
    console.error(
      'No API key found. Set M1M1R_API_KEY / OPENROUTER_API_KEY, or run:\n' +
        '  m1m1r secret set OPENROUTER_API_KEY <key>',
    );
    process.exit(1);
  }
}

async function runOrResume(engDir: string, requirement: string | undefined, flags: {
  model?: string;
  baseUrl?: string;
  configPath?: string;
}): Promise<void> {
  const model = flags.model ?? process.env.M1M1R_MODEL;
  if (!model) {
    console.error('No model configured. Pass --model <slug> or set M1M1R_MODEL.');
    process.exit(1);
  }
  const baseUrl = flags.baseUrl ?? process.env.M1M1R_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const apiKey = await resolveApiKey();

  const redactor = new Redactor();
  redactor.addSecret(apiKey);

  const workDir = join(engDir, 'workspace');
  await mkdir(workDir, { recursive: true });

  // Real path, actually reachable: without this, loadConfig()'s file-loading
  // branch was dead code and BudgetGovernor.charge() no-op'd forever (no
  // price entry for any real model -> spentUsd stuck at 0, PLAN §3.1's
  // "statusline $ matches journal Σ" done-criterion trivially true but
  // useless — the ceiling could never actually engage).
  const configPath = flags.configPath ?? join(process.cwd(), '.m1m1r', 'config.json');
  const cfg = await loadConfig(configPath);
  const conductor = await Conductor.open(engDir, cfg, redactor);

  if (!conductor.state.requirement) {
    if (!requirement) {
      console.error(`Engagement at ${engDir} has no requirement recorded and none was given.`);
      process.exit(1);
    }
    await conductor.journal.append(conductor.state.phase, 'START', { requirement });
    conductor.state.requirement = requirement;
  }

  const uiStore = new UiStore();
  uiStore.set({ ...INITIAL_UI_STATE, model, provider: 'openai-compat' });
  conductor.subscribe((ev) => {
    uiStore.apply(ev);
    writeStatusline(uiStore.getSnapshot());
  });
  writeStatusline(uiStore.getSnapshot());

  const client = new OpenAiCompat({
    baseUrl,
    apiKey,
    model,
    redactor,
    onUsage: async (usage) => {
      await conductor.charge(usage, model);
    },
  });

  try {
    await runEngagement(client, conductor, workDir);
  } finally {
    process.stdout.write('\n');
  }

  if (conductor.state.phase === 'PARKED') {
    console.log(`Parked: budget or question needs attention. Resume with:\n  m1m1r resume ${basename(engDir)}`);
    return;
  }
  console.log(conductor.state.report ?? '(no report produced)');
}

async function secretCommand(args: string[]): Promise<void> {
  const [action, account, value] = args;
  if (!action || !account) {
    console.error('Usage: m1m1r secret <set|get|delete> <ACCOUNT> [value]');
    process.exit(1);
  }
  if (action === 'set') {
    if (!value) {
      console.error('Usage: m1m1r secret set <ACCOUNT> <value>');
      process.exit(1);
    }
    await secretSet(account, value);
    console.log(`stored ${account}`);
  } else if (action === 'get') {
    console.log(await secretGet(account));
  } else if (action === 'delete') {
    await secretDelete(account);
    console.log(`deleted ${account}`);
  } else {
    console.error(`unknown secret action: ${action}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    console.log(
      [
        'm1m1r — autonomous engineering team harness',
        '',
        'Usage:',
        '  m1m1r <requirement...>            start a new engagement',
        '  m1m1r resume <engagement-id>      continue a parked/interrupted engagement',
        '  m1m1r secret set <ACCOUNT> <val>  store an API key in the macOS keychain',
        '  m1m1r secret get <ACCOUNT>',
        '  m1m1r secret delete <ACCOUNT>',
        '',
        'Flags (for the default and resume commands):',
        '  --model <slug>      required unless M1M1R_MODEL is set',
        '  --base-url <url>    default https://openrouter.ai/api/v1',
        '  --config <path>     default .m1m1r/config.json (budget ceilings + model prices)',
      ].join('\n'),
    );
    return;
  }

  if (argv[0] === 'secret') {
    await secretCommand(argv.slice(1));
    return;
  }

  const { value: model, rest: r1 } = extractFlag(argv, 'model');
  const { value: baseUrl, rest: r2 } = extractFlag(r1, 'base-url');
  const { value: configPath, rest: r3 } = extractFlag(r2, 'config');

  if (r3[0] === 'resume') {
    const id = r3[1];
    if (!id) {
      console.error('Usage: m1m1r resume <engagement-id>');
      process.exit(1);
    }
    await runOrResume(engagementDir(ENGAGEMENTS_ROOT, id), undefined, { model, baseUrl, configPath });
    return;
  }

  const requirement = r3.join(' ').trim();
  if (!requirement) {
    console.error('No requirement given. Run `m1m1r --help` for usage.');
    process.exit(1);
  }
  const id = newEngagementId();
  await runOrResume(engagementDir(ENGAGEMENTS_ROOT, id), requirement, { model, baseUrl, configPath });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
