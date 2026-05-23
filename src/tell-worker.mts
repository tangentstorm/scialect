#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as tmux from './tmux.mts';
import { ClaudeTui } from './agents/claude-cli.mts';
import { CodexTui } from './agents/codex-cli.mts';
import { GeminiTui } from './agents/gemini-cli.mts';

interface WorkerConfig {
  id: string;
  dir: string;
  session: string;
  window: string;
  expected_agent?: string;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function loadWorkers(): WorkerConfig[] {
  const path = resolve(process.cwd(), 'workers.jsonl');
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l) as WorkerConfig);
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function isGitClean(dir: string): boolean {
  const res = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  return res.status === 0 && !res.stdout.trim();
}

interface AgentRule {
  name: string;
  match: {
    command?: string;
    args_contains?: string;
    title_contains?: string;
  };
}

function loadKnownAgents(): AgentRule[] {
  const path = resolve(process.cwd(), 'known-agents.jsonl');
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as AgentRule);
  } catch {
    return [];
  }
}

async function assertTmuxWindowExists(session: string, window: string, label: string) {
  const windowTarget = `${session}:${window}`;
  const res = await tmux.listPanes(windowTarget, '#{pane_index}');
  if (res.code !== 0 || !res.stdout.trim()) {
    console.error(`${label}: tmux window '${windowTarget}' does not exist`);
    process.exit(1);
  }
}

async function detectAgent(session: string, window: string): Promise<string | null> {
  const rules = loadKnownAgents();
  const windowTarget = `${session}:${window}`;

  try {
    const res = await tmux.listPanes(windowTarget, '#{pane_index} #{pane_pid} #{pane_current_command} #{pane_current_path} "#{pane_title}"');
    if (res.code !== 0 || !res.stdout.trim()) return null;

    const lines = res.stdout.trim().split('\n');
    // Focus on the first/main pane for now
    const first = lines[0].split(' ');
    if (first.length < 5) return null;

    const pid = first[1];
    const command = first[2];
    const title = lines[0].match(/"([^"]*)"$/)?.[1] || '';

    // Get process info
    const proc = spawnSync('ps', ['-p', pid, '-o', 'comm=,args='], { encoding: 'utf8' });
    let args = '';
    if (proc.status === 0) {
      const space = proc.stdout.indexOf(' ');
      args = space > 0 ? proc.stdout.slice(space + 1) : '';
    }

    const cmdBase = command.split('/').pop() || command;

    for (const rule of rules) {
      const m = rule.match;
      if (m.command && cmdBase !== m.command) continue;
      if (m.args_contains && !args.includes(m.args_contains)) continue;
      if (m.title_contains && !title.includes(m.title_contains)) continue;
      return rule.name;
    }
  } catch {
    return null;
  }

  return null;
}

async function doAssigned(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(w.dir);

  if (!isGitClean(configuredDir)) {
    console.error(`${w.id}: git tree is not clean`);
    process.exit(1);
  }

  const goalPath = resolve(configuredDir, 'goal.md');
  if (!existsSync(goalPath)) {
    console.error(`${w.id}: goal.md does not exist`);
    process.exit(1);
  }

  const goalContent = readFileSync(goalPath, 'utf8');

  // Remove old result
  const resultPath = resolve(configuredDir, 'result.md');
  if (existsSync(resultPath)) {
    unlinkSync(resultPath);
  }

  // Set swarm status
  const statusPath = resolve(configuredDir, '.swarm-status');
  writeFileSync(statusPath, `ASSIGNED: ${goalContent.split('\n')[0].slice(0, 80)}\n`, 'utf8');

  console.log(`${w.id}: files prepared (ASSIGNED, goal.md present, result.md cleared)`);

  // Now talk to the live agent in the pane
  const detected = await detectAgent(w.session, w.window);
  const agent = (detected || w.expected_agent || 'claude').toLowerCase();

  let tui: any = null;

  if (agent.includes('codex')) {
    tui = new CodexTui(target);
  } else if (agent === 'claude') {
    tui = new ClaudeTui(target);
  } else if (agent === 'gemini') {
    tui = new GeminiTui(target);
  }

  if (tui) {
    console.log(`${w.id}: waiting for empty prompt (up to 5s)...`);
    if (!await tui.ensurePromptIsEmpty()) {
      console.error(`${w.id}: never reached empty prompt`);
      process.exit(1);
    }

    console.log(`${w.id}: clean prompt detected. Sending handoff...`);

    if (agent === 'claude' || agent.includes('codex')) {
      // Claude/Codex handoff protocol
      // IMPORTANT: We deliberately do NOT send /clear for Claude.
      await tmux.sendKeys(target, '/new', false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
      await sleep(10000);
      await tmux.sendKeys(target, '/goal follow the instructions in goal.md', false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
    } else if (agent === 'gemini') {
      // Basic handoff for Gemini (agy). Adjust as needed.
      await tmux.sendKeys(target, 'Follow the instructions in goal.md', false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
    }

    console.log(`${w.id}: handoff sent to ${agent}.`);
  } else {
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
  }
}

async function doReview(manager: WorkerConfig, targetWorkerId: string) {
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const targetPane = `${manager.session}:${manager.window}.0`;

  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || manager.expected_agent || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const reviewMessage = `${targetWorkerId} has stopped. Please review its result.md and recent commits and decide whether to ACCEPT, REJECT, or ADJUST.`;

  let tui: any = null;
  let message = '';

  if (agent.includes('codex')) {
    tui = new CodexTui(targetPane);
    message = reviewMessage;
  } else if (agent === 'claude') {
    tui = new ClaudeTui(targetPane);
    message = reviewMessage;
  } else if (agent === 'gemini') {
    tui = new GeminiTui(targetPane);
    message = reviewMessage;
  } else {
    console.error(`${manager.id}: no TUI handler implemented for agent '${agent}'`);
    process.exit(1);
  }

  console.log(`${manager.id}: waiting for empty prompt (up to 5s)...`);
  if (!await tui.ensurePromptIsEmpty()) {
    console.error(`${manager.id}: never reached empty prompt`);
    process.exit(1);
  }

  console.log(`${manager.id}: sending review request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, message, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  console.log(`${manager.id}: review request sent for ${targetWorkerId}.`);
}

async function doAdjust(manager: WorkerConfig, targetWorkerId: string) {
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const targetPane = `${manager.session}:${manager.window}.0`;

  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || manager.expected_agent || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const adjustMessage = `Please adjust the goal.md prompt for ${targetWorkerId}.`;

  let tui: any = null;

  if (agent.includes('codex')) {
    tui = new CodexTui(targetPane);
  } else if (agent === 'claude') {
    tui = new ClaudeTui(targetPane);
  } else if (agent === 'gemini') {
    tui = new GeminiTui(targetPane);
  } else {
    console.error(`${manager.id}: no TUI handler implemented for agent '${agent}'`);
    process.exit(1);
  }

  console.log(`${manager.id}: waiting for empty prompt (up to 5s)...`);
  if (!await tui.ensurePromptIsEmpty()) {
    console.error(`${manager.id}: never reached empty prompt`);
    process.exit(1);
  }

  console.log(`${manager.id}: sending adjust request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, adjustMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  console.log(`${manager.id}: adjust request sent for ${targetWorkerId}.`);
}

async function main() {
  const [workerId, action, ...args] = process.argv.slice(2);

  if (!workerId || !action) {
    console.error('Usage:');
    console.error('  npm run tell-worker -- <id> assigned');
    console.error('  npm run tell-worker -- <manager> review <worker>');
    console.error('  npm run tell-worker -- <manager> adjust <worker>');
    process.exit(1);
  }

  const workers = loadWorkers();
  const w = workers.find(x => x.id === workerId);
  if (!w) {
    console.error(`Unknown worker: ${workerId}`);
    process.exit(1);
  }

  const target = `${w.session}:${w.window}.0`;

  if (action === 'assigned') {
    await doAssigned(w, w.dir, target);
  } else if (action === 'review') {
    const targetWorkerId = args[0];
    if (!targetWorkerId) {
      console.error('Usage: npm run tell-worker -- <manager> review <worker>');
      process.exit(1);
    }
    await doReview(w, targetWorkerId);
  } else if (action === 'adjust') {
    const targetWorkerId = args[0];
    if (!targetWorkerId) {
      console.error('Usage: npm run tell-worker -- <manager> adjust <worker>');
      process.exit(1);
    }
    await doAdjust(w, targetWorkerId);
  } else {
    console.error(`Unknown action: ${action}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
