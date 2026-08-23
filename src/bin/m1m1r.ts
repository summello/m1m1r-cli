#!/usr/bin/env node
// CLI entry (PLAN §6 Phase 0: "CLI boots; one engagement runs end-to-end").
// Commands: `m1m1r <requirement>` starts one, `m1m1r resume <id>` continues
// one, `m1m1r secret <set|get|delete> <account> [value]` wraps the keychain.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import React from 'react';
import { render } from 'ink';
import { engagementDir, runEngagement } from '../agents/generic-agent.js';
import { Conductor, loadConfig, newEngagementId, type Config } from '../conductor/conductor.js';
import { runTeamEngagement } from '../conductor/team.js';
import { OpenAiCompat } from '../providers/openai-compat.js';
import { OpenAiCompatRuntime } from '../providers/openai-compat-runtime.js';
import { AnthropicRuntime } from '../providers/anthropic-runtime.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { secretDelete, secretGet, secretSet } from '../providers/keychain.js';
import { Redactor } from '../security/redact.js';
import { shellRun } from '../exec/shell-run.js';
import { INITIAL_UI_STATE, UiStore } from '../ui/store.js';
import { writeStatusline } from '../ui/statusline.js';
import { Cockpit } from '../ui/cockpit.js';
import { enterAltScreen } from '../ui/alt-screen.js';

const execFileAsync = promisify(execFile);
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

  const ui = await startEngagementUi(conductor, {
    model,
    provider: 'openai-compat',
    resumedEngagementId: requirement ? undefined : basename(engDir),
  });

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
    ui.stop();
  }

  if (conductor.state.phase === 'PARKED') {
    console.log(`Parked: budget or question needs attention. Resume with:\n  m1m1r resume ${basename(engDir)}`);
    return;
  }
  console.log(conductor.state.report ?? '(no report produced)');
}

async function resolveAnthropicApiKey(): Promise<string | undefined> {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    return await secretGet('ANTHROPIC_API_KEY');
  } catch {
    return undefined; // fine — the SDK falls back to an existing `claude` CLI OAuth login
  }
}

interface EngagementUiOptions {
  model: string | null;
  provider: string;
  resumedEngagementId?: string;
}

async function workspaceIdentity(): Promise<{ branch: string | null; dirty: boolean }> {
  try {
    const { stdout: branch } = await execFileAsync('git', ['branch', '--show-current'], { cwd: process.cwd() });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: process.cwd() });
    return { branch: branch.trim() || null, dirty: status.trim().length > 0 };
  } catch {
    return { branch: null, dirty: false };
  }
}

async function startEngagementUi(conductor: Conductor, options: EngagementUiOptions): Promise<{ stop: () => void }> {
  const store = new UiStore();
  store.hydrate(conductor.journal.eventsAll);
  const identity = await workspaceIdentity();
  store.set({
    model: options.model,
    provider: options.provider,
    branch: identity.branch,
    dirty: identity.dirty,
    busy: conductor.state.phase !== 'DONE' && conductor.state.phase !== 'PARKED',
  });
  const unsubscribe = conductor.subscribe((event) => store.apply(event));
  const gitWatcher = setInterval(() => {
    void workspaceIdentity().then((next) => {
      const current = store.getSnapshot();
      if (current.branch !== next.branch || current.dirty !== next.dirty) store.set(next);
    });
  }, 1000);
  gitWatcher.unref();

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const redraw = () => writeStatusline(store.getSnapshot());
    const unsubscribeMini = store.subscribe(redraw);
    redraw();
    return {
      stop: () => {
        clearInterval(gitWatcher);
        unsubscribeMini();
        unsubscribe();
        process.stdout.write('\n');
      },
    };
  }

  const command = makeCockpitCommandHandler(conductor, store);
  const leaveAltScreen = enterAltScreen();
  const instance = render(React.createElement(Cockpit, {
    store,
    userName: process.env.USER ?? 'engineer',
    projectPath: process.cwd(),
    resumedEngagementId: options.resumedEngagementId,
    onAnswer: (id: string, answer: string) => conductor.answerQuestion(id, answer),
    onCommand: command,
    onShell: (cmd: string) => shellRun(process.cwd(), cmd),
    onPrompt: async (prompt: string, onDelta: (text: string) => void) => {
      const id = `steer-${Date.now()}`;
      await conductor.record('HUMAN_NOTE', { prompt });
      await conductor.record('STREAM_START', { id, role: 'conductor' });
      for (const chunk of ['Steering note ', 'recorded. Use ', '/redirect <task> <instruction> ', 'to change queued work.']) {
        onDelta(chunk);
        await conductor.record('STREAM_DELTA', { id, text: chunk });
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      await conductor.record('STREAM_END', { id });
    },
  }), { exitOnCtrlC: true });
  return {
    stop: () => {
      clearInterval(gitWatcher);
      unsubscribe();
      instance.unmount();
      instance.clear();
      leaveAltScreen();
    },
  };
}

function makeCockpitCommandHandler(conductor: Conductor, store: UiStore) {
  return async (command: string, args: string[]): Promise<string> => {
    switch (command) {
      case '/pause':
        await conductor.pause();
        return 'Engagement paused after the current provider turn.';
      case '/resume':
        await conductor.resumeRun();
        return 'Engagement resumed.';
      case '/answer': {
        const [id, ...answerParts] = args;
        if (!id || answerParts.length === 0) return 'Usage: /answer <question-id> <answer>';
        await conductor.answerQuestion(id, answerParts.join(' '));
        return `Answered ${id}.`;
      }
      case '/redirect': {
        const [id, ...instructionParts] = args;
        if (!id || instructionParts.length === 0) return 'Usage: /redirect <task-id> <instruction>';
        await conductor.redirectTask(id, instructionParts.join(' '));
        return `Redirect recorded for ${id}; it will be applied before that task starts.`;
      }
      case '/mode': {
        const modes = ['supervised', 'semi', 'full'];
        const current = store.getSnapshot().mode;
        const requested = args[0];
        const mode = requested && modes.includes(requested)
          ? requested
          : modes[(modes.indexOf(current) + 1) % modes.length]!;
        await conductor.record('CONTROL_MODE', { mode });
        return `Autonomy mode: ${mode}.`;
      }
      case '/questions': {
        const questions = store.getSnapshot().questions;
        return questions.length ? questions.map((question) => `${question.id}: ${question.questionLayman}`).join('\n') : 'No open questions.';
      }
      case '/agents': {
        const agents = store.getSnapshot().agents;
        return agents.length ? agents.map((agent) => `${agent.id} ${agent.status}: ${agent.task}`).join('\n') : 'No agents have started yet.';
      }
      case '/budget': {
        const state = store.getSnapshot();
        return state.budgetSeen ? `$${state.budget.spentUsd.toFixed(2)} of $${state.budget.ceilingUsd}` : 'Budget spend — (no usage event yet).';
      }
      case '/model':
        return `${store.getSnapshot().provider}/${store.getSnapshot().model ?? '—'}`;
      case '/plan':
        return conductor.state.teamNodes?.map((node) => `${node.id}: ${node.input}`).join('\n')
          ?? conductor.state.planSteps?.map((step, index) => `${index + 1}: ${step.desc}`).join('\n')
          ?? 'No plan yet.';
      case '/init':
        try {
          await writeFile(join(process.cwd(), 'M1M1R.md'), '# M1M1R project conventions\n', { flag: 'wx' });
          return 'Created M1M1R.md.';
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'M1M1R.md already exists.';
          throw error;
        }
      case '/sessions':
        return 'Session catalog is not available in this phase; the current engagement remains journaled.';
      case '/help':
        return '/pause /resume /redirect /answer /questions /agents /budget /model /mode /plan /init /quit · ! shell';
      default:
        return `Unknown command: ${command}. Try /help.`;
    }
  };
}

async function welcomeCommand(): Promise<void> {
  const store = new UiStore();
  const identity = await workspaceIdentity();
  store.set({
    ...INITIAL_UI_STATE,
    model: process.env.M1M1R_MODEL ?? null,
    provider: process.env.M1M1R_PROVIDER ?? 'openrouter',
    branch: identity.branch,
    dirty: identity.dirty,
  });
  const leaveAltScreen = enterAltScreen();
  const instance = render(React.createElement(Cockpit, {
    store,
    userName: process.env.USER ?? 'engineer',
    projectPath: process.cwd(),
    onShell: (cmd: string) => shellRun(process.cwd(), cmd),
    onCommand: async (command: string) => command === '/help'
      ? '/model /sessions /init /quit · ! shell'
      : 'Start an engagement with: m1m1r "your requirement"',
  }), { exitOnCtrlC: true });
  try {
    if (process.stdin.isTTY) await instance.waitUntilExit();
    else instance.unmount();
  } finally {
    instance.clear();
    leaveAltScreen();
  }
}

type ProviderChoice = 'anthropic' | 'openai-compat' | 'mixed';

async function teamCommand(requirement: string, flags: {
  model?: string;
  baseUrl?: string;
  configPath?: string;
  provider: ProviderChoice;
  anthropicModel?: string;
  concurrency: number;
  integrationBranch?: string;
  testCommand?: string;
}): Promise<void> {
  // The planner's single JSON-producing call always runs over openai-compat
  // (PLAN §4 — no file/shell tools needed for one turn, so there's no reason
  // to spin up the SDK just for that), regardless of --provider: even an
  // all-Anthropic implementer run still needs a plan first. Checked before
  // anything else so a missing --model fails fast, not after an engagement
  // dir/conductor/statusline are already stood up.
  const model = flags.model ?? process.env.M1M1R_MODEL;
  if (!model) {
    console.error('No model configured for the planner (openai-compat). Pass --model <slug> or set M1M1R_MODEL.');
    process.exit(1);
  }
  const needsAnthropic = flags.provider !== 'openai-compat';
  const anthropicModel = flags.anthropicModel ?? process.env.M1M1R_ANTHROPIC_MODEL;
  if (needsAnthropic && !anthropicModel) {
    console.error('No Anthropic model configured. Pass --anthropic-model <slug> or set M1M1R_ANTHROPIC_MODEL.');
    process.exit(1);
  }

  const baseUrl = flags.baseUrl ?? process.env.M1M1R_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const redactor = new Redactor();
  const openAiApiKey = await resolveApiKey();
  redactor.addSecret(openAiApiKey);
  let anthropicApiKey: string | undefined;
  if (needsAnthropic) {
    anthropicApiKey = await resolveAnthropicApiKey();
    if (anthropicApiKey) redactor.addSecret(anthropicApiKey);
  }

  const id = newEngagementId();
  const engDir = engagementDir(ENGAGEMENTS_ROOT, id);
  const worktreesRoot = join(engDir, 'worktrees');
  await mkdir(worktreesRoot, { recursive: true });

  const configPath = flags.configPath ?? join(process.cwd(), '.m1m1r', 'config.json');
  const cfg = await loadConfig(configPath);
  const conductor = await Conductor.open(engDir, cfg, redactor);
  await conductor.journal.append(conductor.state.phase, 'START', { requirement });
  conductor.state.requirement = requirement;

  const ui = await startEngagementUi(conductor, {
    model: model ?? anthropicModel ?? null,
    provider: flags.provider,
  });

  const openAiClient = new OpenAiCompat({
    baseUrl,
    apiKey: openAiApiKey,
    model,
    redactor,
    onUsage: async (usage) => {
      await conductor.charge(usage, model);
    },
  });
  const openAiRuntime = new OpenAiCompatRuntime(openAiClient);
  const anthropicRuntime = needsAnthropic
    ? new AnthropicRuntime({
        model: anthropicModel!,
        apiKey: anthropicApiKey,
        // recordUsage (not charge): the dollar deduction for this turn
        // comes from onUsageUsd's exact total_cost_usd below — using charge()
        // here too would double-bill if this model ever gets a price-table
        // entry (conductor.ts's recordUsage doc explains why).
        onUsage: async (usage) => {
          await conductor.recordUsage(usage, anthropicModel!);
        },
        onUsageUsd: async (usd) => {
          await conductor.chargeUsd(usd);
        },
      })
    : undefined;

  let mixedIndex = 0;
  const pick: () => AgentRuntime =
    flags.provider === 'anthropic'
      ? () => anthropicRuntime!
      : flags.provider === 'openai-compat'
        ? () => openAiRuntime
        : () => (mixedIndex++ % 2 === 0 ? anthropicRuntime! : openAiRuntime);

  try {
    await runTeamEngagement(conductor, {
      repoRoot: process.cwd(),
      worktreesRoot,
      concurrency: flags.concurrency,
      pickImplementerRuntime: pick,
      plannerClient: openAiClient,
      integrationBranch: flags.integrationBranch ?? `m1m1r/integration-${id}`,
      testCommand: flags.testCommand,
      runTestCommand: shellRun,
    });
  } finally {
    ui.stop();
  }

  if (conductor.state.phase === 'PARKED') {
    console.log(`Parked: budget or question needs attention. Resume with:\n  m1m1r resume ${basename(engDir)}`);
    return;
  }
  console.log(conductor.state.report ?? '(no report produced)');
}

async function modelCommand(args: string[], configPath: string): Promise<void> {
  const cfg = await loadConfig(configPath);
  if (args[0] === 'use') {
    const spec = args[1];
    const m = spec?.match(/^([a-zA-Z0-9_-]+)=([a-zA-Z0-9_-]+)\/(.+)$/);
    if (!m) {
      console.error('Usage: m1m1r model use <tier>=<provider>/<model>  (provider: anthropic | openai-compat)');
      process.exit(1);
    }
    const [, tier, provider, modelSlug] = m as unknown as [string, string, string, string];
    const next: Config = { ...cfg, tiers: { ...cfg.tiers, [tier]: { provider, model: modelSlug } } };
    await mkdir(join(configPath, '..'), { recursive: true });
    await writeFile(configPath, JSON.stringify(next, null, 2));
    console.log(`${tier} -> ${provider}/${modelSlug}`);
    return;
  }
  // default: ls
  const tiers = cfg.tiers ?? {};
  if (Object.keys(tiers).length === 0) {
    console.log('No tier bindings configured. Set one with:\n  m1m1r model use <tier>=<provider>/<model>');
    return;
  }
  for (const [tier, binding] of Object.entries(tiers)) {
    console.log(`${tier} -> ${binding.provider}/${binding.model}`);
  }
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
  if (argv.length === 0) {
    await welcomeCommand();
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(
      [
        'm1m1r — autonomous engineering team harness',
        '',
        'Usage:',
        '  m1m1r <requirement...>            single generic agent, one engagement',
        '  m1m1r team <requirement...>       planner fans out to N implementers in',
        '                                    parallel worktrees, merges into one branch',
        '  m1m1r resume <engagement-id>      continue a parked/interrupted engagement',
        '  m1m1r model ls                    list configured tier -> provider/model bindings',
        '  m1m1r model use <tier>=<provider>/<model>',
        '  m1m1r secret set <ACCOUNT> <val>  store an API key in the macOS keychain',
        '  m1m1r secret get <ACCOUNT>',
        '  m1m1r secret delete <ACCOUNT>',
        '',
        'Flags (default/resume/team):',
        '  --model <slug>          openai-compat model; required unless M1M1R_MODEL is set',
        '  --base-url <url>        default https://openrouter.ai/api/v1',
        '  --config <path>         default .m1m1r/config.json (budget, prices, tiers)',
        '',
        'Flags (team only):',
        '  --provider <p>          anthropic | openai-compat (default) | mixed',
        '  --anthropic-model <s>   required when --provider is anthropic or mixed',
        '  --implementers <n>      max concurrent implementers, default 3',
        '  --integration-branch <b> default m1m1r/integration-<engagement-id>',
        '  --test <cmd>            run once after merging, e.g. "npm test"',
      ].join('\n'),
    );
    return;
  }

  if (argv[0] === 'secret') {
    await secretCommand(argv.slice(1));
    return;
  }

  if (argv[0] === 'model') {
    const { value: configPath, rest } = extractFlag(argv.slice(1), 'config');
    await modelCommand(rest, configPath ?? join(process.cwd(), '.m1m1r', 'config.json'));
    return;
  }

  if (argv[0] === 'team') {
    const rest0 = argv.slice(1);
    const { value: model, rest: t1 } = extractFlag(rest0, 'model');
    const { value: baseUrl, rest: t2 } = extractFlag(t1, 'base-url');
    const { value: configPath, rest: t3 } = extractFlag(t2, 'config');
    const { value: providerRaw, rest: t4 } = extractFlag(t3, 'provider');
    const { value: anthropicModel, rest: t5 } = extractFlag(t4, 'anthropic-model');
    const { value: implementers, rest: t6 } = extractFlag(t5, 'implementers');
    const { value: integrationBranch, rest: t7 } = extractFlag(t6, 'integration-branch');
    const { value: testCommand, rest: t8 } = extractFlag(t7, 'test');

    const provider = (providerRaw ?? 'openai-compat') as ProviderChoice;
    if (!['anthropic', 'openai-compat', 'mixed'].includes(provider)) {
      console.error(`Unknown --provider ${providerRaw}. Use anthropic | openai-compat | mixed.`);
      process.exit(1);
    }
    const requirement = t8.join(' ').trim();
    if (!requirement) {
      console.error('No requirement given. Run `m1m1r --help` for usage.');
      process.exit(1);
    }
    await teamCommand(requirement, {
      model,
      baseUrl,
      configPath,
      provider,
      anthropicModel,
      concurrency: implementers ? Number(implementers) : 3,
      integrationBranch,
      testCommand,
    });
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
