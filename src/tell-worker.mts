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
    if (lines.length === 0 || !lines[0]) return null;
    
    // Focus on the first/main pane for now
    const first = lines[0].split(' ');
    if (first.length < 5) return null;

    const pid = first[1];
    const command = first[2];
    if (!pid || !command) return null;

    const titleMatch = lines[0].match(/"([^"]*)"$/);
    const title = titleMatch ? (titleMatch[1] || '') : '';

    // Get process info
    const proc = spawnSync('ps', ['-p', pid, '-o', 'comm=,args='], { encoding: 'utf8' });
    let args = '';
    if (proc.status === 0 && proc.stdout) {
      const stdoutStr = proc.stdout.toString();
      const space = stdoutStr.indexOf(' ');
      args = space > 0 ? stdoutStr.slice(space + 1) : '';
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

function getCommittedGuideContent(guideName: string): string | null {
  const scialectRoot = resolve(process.cwd());
  const res = spawnSync('git', ['show', `HEAD:rules/${guideName}`], { cwd: scialectRoot, encoding: 'utf8' });
  if (res.status === 0) {
    return res.stdout;
  }
  return null;
}

function propagateGuide(targetDir: string, guideName: string): boolean {
  const committedContent = getCommittedGuideContent(guideName);
  if (!committedContent) {
    console.error(`Error: Could not retrieve committed content for rules/${guideName}`);
    process.exit(1);
  }

  const sciDir = resolve(targetDir, '.sci');
  const targetPath = resolve(sciDir, guideName);

  let existingContent = '';
  if (existsSync(targetPath)) {
    existingContent = readFileSync(targetPath, 'utf8');
  }

  if (existingContent.trim() !== committedContent.trim()) {
    writeFileSync(targetPath, committedContent, 'utf8');
    return true; // Content actually changed or is new
  }

  return false; // Content did not change
}

function checkManagerIdle(manager: WorkerConfig) {
  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  if (existsSync(statusPath)) {
    const statusContent = readFileSync(statusPath, 'utf8').trim();
    if (statusContent && !statusContent.startsWith('IDLE')) {
      console.error(`${manager.id}: Manager status is not IDLE (currently: '${statusContent}'). Cannot hand off new task.`);
      process.exit(1);
    }
  }
}

async function doAssigned(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);

  if (!isGitClean(configuredDir)) {
    console.error(`${w.id}: git tree is not clean`);
    process.exit(1);
  }

  const sciDir = resolve(configuredDir, '.sci');
  const goalPath = resolve(sciDir, 'goal.md');
  const taskPath = resolve(sciDir, 'task.md');

  if (!existsSync(goalPath)) {
    console.error(`${w.id}: .sci/goal.md does not exist`);
    process.exit(1);
  }
  if (!existsSync(taskPath)) {
    console.error(`${w.id}: .sci/task.md does not exist`);
    process.exit(1);
  }

  // Remove old result
  const resultPath = resolve(sciDir, 'result.md');
  if (existsSync(resultPath)) {
    unlinkSync(resultPath);
  }

  // Propagate proving-guide.md
  const changed = propagateGuide(configuredDir, 'proving-guide.md');

  // Set status-line inside .sci/
  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `WORKING: starting task\n`, 'utf8');

  console.log(`${w.id}: files prepared (WORKING, .sci/goal.md + task.md, result cleared, guide propagated)`);

  // Now talk to the live agent in the pane
  const detected = await detectAgent(w.session, w.window);
  const agent = (detected || 'claude').toLowerCase();

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

    const changeNotice = changed ? ' IMPORTANT: .sci/proving-guide.md has just been updated with new instructions; please read it carefully.' : '';
    const handoffMsg = `/goal follow the instructions in .sci/task.md (see .sci/goal.md for context). Please refer to .sci/proving-guide.md for detailed instructions.${changeNotice}`;

    if (agent === 'claude' || agent.includes('codex')) {
      await tmux.sendKeys(target, '/new', false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
      await sleep(10000);
      await tmux.sendKeys(target, handoffMsg, false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
    } else if (agent === 'gemini') {
      await tmux.sendKeys(target, handoffMsg, false);
      await sleep(500);
      await tmux.sendKeys(target, 'Enter', false);
    }

    console.log(`${w.id}: handoff sent to ${agent}.`);
  } else {
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
  }
}

async function doAccept(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const sciDir = resolve(configuredDir, '.sci');

  const changed = propagateGuide(configuredDir, 'proving-guide.md');

  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `WORKING: plan next step\n`, 'utf8');

  console.log(`${w.id}: files prepared (WORKING: plan next step, guide propagated)`);

  const detected = await detectAgent(w.session, w.window);
  const agent = (detected || 'claude').toLowerCase();

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

    const changeNotice = changed ? ' IMPORTANT: .sci/proving-guide.md has just been updated with new instructions; please read it carefully.' : '';
    const handoffMsg = `Your recent work has been accepted! Please read your .sci/plan.md, formulate your next commit-sized step in .sci/task.md, and set your status to SUGGEST when your task plan is ready for manager approval. Refer to .sci/proving-guide.md for detailed instructions.${changeNotice}`;

    await tmux.sendKeys(target, handoffMsg, false);
    await sleep(500);
    await tmux.sendKeys(target, 'Enter', false);

    console.log(`${w.id}: accept handoff sent to ${agent}.`);
  } else {
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
  }
}

async function doAdjust(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const sciDir = resolve(configuredDir, '.sci');

  const changed = propagateGuide(configuredDir, 'adjust-guide.md');

  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `WORKING: adjust task plan\n`, 'utf8');

  console.log(`${w.id}: files prepared (WORKING: adjust task plan, guide propagated)`);

  const detected = await detectAgent(w.session, w.window);
  const agent = (detected || 'claude').toLowerCase();

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

    const changeNotice = changed ? ' IMPORTANT: .sci/adjust-guide.md has just been updated with new instructions; please read it carefully.' : '';
    const handoffMsg = `Your proposed task plan was not approved by the manager. Please adjust the task in .sci/task.md based on the manager's feedback. Refer to .sci/adjust-guide.md for detailed instructions.${changeNotice}`;

    await tmux.sendKeys(target, handoffMsg, false);
    await sleep(500);
    await tmux.sendKeys(target, 'Enter', false);

    console.log(`${w.id}: adjust handoff sent to ${agent}.`);
  } else {
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
  }
}

async function doReview(manager: WorkerConfig, targetWorkerId: string) {
  checkManagerIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');

  // Propagate review-guide.md
  const changed = propagateGuide(configuredDir, 'review-guide.md');

  // Set manager status
  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const changeNotice = changed ? ' IMPORTANT: .sci/review-guide.md has just been updated with new instructions; please read it carefully.' : '';
  const reviewMessage = `Please review the completed code task for ${targetWorkerId}. Refer to .sci/review-guide.md for detailed instructions on conducting reviews and setting your status.${changeNotice}`;

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

  console.log(`${manager.id}: sending review request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, reviewMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  console.log(`${manager.id}: review request sent for ${targetWorkerId}.`);
}

async function doApproveTask(manager: WorkerConfig, targetWorkerId: string) {
  checkManagerIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');

  // Propagate approve-task-guide.md
  const changed = propagateGuide(configuredDir, 'approve-task-guide.md');

  // Set manager status
  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const changeNotice = changed ? ' IMPORTANT: .sci/approve-task-guide.md has just been updated with new instructions; please read it carefully.' : '';
  const approveMessage = `Please review and approve the proposed next task plan in .sci/task.md for ${targetWorkerId}. Refer to .sci/approve-task-guide.md for detailed instructions.${changeNotice}`;

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

  console.log(`${manager.id}: sending task approval request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, approveMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  console.log(`${manager.id}: task approval request sent for ${targetWorkerId}.`);
}

async function doUnblock(manager: WorkerConfig, targetWorkerId: string) {
  checkManagerIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');

  // Propagate unblock-guide.md
  const changed = propagateGuide(configuredDir, 'unblock-guide.md');

  // Set manager status
  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const changeNotice = changed ? ' IMPORTANT: .sci/unblock-guide.md has just been updated with new instructions; please read it carefully.' : '';
  const unblockMessage = `Please triage the blocker for ${targetWorkerId} and help unblock them. Refer to .sci/unblock-guide.md for detailed instructions.${changeNotice}`;

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

  console.log(`${manager.id}: sending unblock request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, unblockMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  console.log(`${manager.id}: unblock request sent for ${targetWorkerId}.`);
}

async function main() {
  const [workerId, action, ...args] = process.argv.slice(2);

  if (!workerId || !action) {
    console.error('Usage:');
    console.error('  npm run tell-worker -- <worker> assigned');
    console.error('  npm run tell-worker -- <worker> accept');
    console.error('  npm run tell-worker -- <worker> adjust');
    console.error('  npm run tell-worker -- <manager> review <worker>');
    console.error('  npm run tell-worker -- <manager> approve-task <worker>');
    console.error('  npm run tell-worker -- <manager> unblock <worker>');
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
  } else if (action === 'accept') {
    await doAccept(w, w.dir, target);
  } else if (action === 'adjust') {
    await doAdjust(w, w.dir, target);
  } else if (action === 'review') {
    const targetWorkerId = args[0];
    if (!targetWorkerId) {
      console.error('Usage: npm run tell-worker -- <manager> review <worker>');
      process.exit(1);
    }
    await doReview(w, targetWorkerId);
  } else if (action === 'approve-task') {
    const targetWorkerId = args[0];
    if (!targetWorkerId) {
      console.error('Usage: npm run tell-worker -- <manager> approve-task <worker>');
      process.exit(1);
    }
    await doApproveTask(w, targetWorkerId);
  } else if (action === 'unblock') {
    const targetWorkerId = args[0];
    if (!targetWorkerId) {
      console.error('Usage: npm run tell-worker -- <manager> unblock <worker>');
      process.exit(1);
    }
    await doUnblock(w, targetWorkerId);
  } else {
    console.error(`Unknown action: ${action}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
