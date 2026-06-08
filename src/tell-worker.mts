#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as tmux from './tmux.mts';
import { resolveDependencies } from './rule-deps.mts';
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
    const res = await tmux.listPanes(windowTarget, '#{pane_index} #{pane_tty} #{pane_current_command} "#{pane_title}"');
    if (res.code !== 0 || !res.stdout.trim()) return null;

    const lines = res.stdout.trim().split('\n');
    if (lines.length === 0 || !lines[0]) return null;
    
    // Focus on the first/main pane for now
    const first = lines[0].split(' ');
    if (first.length < 4) return null;

    const tty = first[1];
    const command = first[2];
    if (!tty || !command) return null;

    const titleMatch = lines[0].match(/"([^"]*)"$/);
    const title = titleMatch ? (titleMatch[1] || '') : '';

    // Get all process info on the pane's TTY
    const proc = spawnSync('ps', ['-t', tty, '-o', 'comm=,args='], { encoding: 'utf8' });
    let args = '';
    let allCommands = '';
    if (proc.status === 0 && proc.stdout) {
      args = proc.stdout.toString(); // contains all comm and args
      allCommands = args; // for simple includes matching
    }

    const cmdBase = command.split('/').pop() || command;

    for (const rule of rules) {
      const m = rule.match;
      if (m.command && cmdBase !== m.command && !allCommands.includes(m.command)) continue;
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

/** Copy a single committed guide into the worker's .sci/. Returns true if it changed. */
function copyGuide(targetDir: string, guideName: string): boolean {
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

/**
 * Propagate a guide and everything it transitively pulls in via `uses:` into
 * the worker's .sci/. Returns true if the named guide OR any of its
 * dependencies changed, so callers can still emit a single "guide updated,
 * please re-read" notice.
 */
function propagateGuide(targetDir: string, guideName: string): boolean {
  let changed = copyGuide(targetDir, guideName);

  const deps = resolveDependencies(guideName, getCommittedGuideContent);
  for (const dep of deps) {
    const depChanged = copyGuide(targetDir, dep);
    if (depChanged) {
      console.log(`  ${guideName} → propagated dependency ${dep}`);
    }
    changed = changed || depChanged;
  }

  return changed;
}

/** Read-only peek: would propagateGuide() change anything on disk? Compares the
 * committed guide (and its transitive `uses:` deps) against the worker's .sci/
 * copies WITHOUT writing. Used to compute the handoff change-notice before the
 * actual propagation (which is deferred until after the message send). */
function guideWouldChange(targetDir: string, guideName: string): boolean {
  const sciDir = resolve(targetDir, '.sci');
  const names = [guideName, ...resolveDependencies(guideName, getCommittedGuideContent)];
  for (const name of names) {
    const committed = getCommittedGuideContent(name);
    if (!committed) continue;
    const targetPath = resolve(sciDir, name);
    const existing = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
    if (existing.trim() !== committed.trim()) return true;
  }
  return false;
}

function checkIdle(w: WorkerConfig) {
  const configuredDir = expandHome(w.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  if (existsSync(statusPath)) {
    const statusContent = readFileSync(statusPath, 'utf8').trim();
    if (statusContent && !statusContent.startsWith('IDLE') && !statusContent.startsWith('HELD')) {
      console.error(`${w.id}: Status is not IDLE or HELD (currently: '${statusContent}'). Cannot hand off new task.`);
      process.exit(1);
    }
  }
}

function checkReadyForIntegration(w: WorkerConfig) {
  const configuredDir = expandHome(w.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  if (existsSync(statusPath)) {
    const statusContent = readFileSync(statusPath, 'utf8').trim();
    const statusUpper = statusContent.toUpperCase();
    if (statusContent &&
        !statusUpper.startsWith('IDLE') &&
        !statusUpper.startsWith('HELD') &&
        !statusUpper.startsWith('AWAITING: CODE REVIEW') &&
        !statusUpper.startsWith('READY')) {
      console.error(`${w.id}: Status is not ready for integration (currently: '${statusContent}'). Cannot start rebase.`);
      process.exit(1);
    }
  }
}

async function doAssigned(w: WorkerConfig, dir: string, target: string) {
  checkIdle(w);
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

  // --- ATOMICITY ---------------------------------------------------------
  // Do NOT mutate any worker state (status-line, result/review, guide) until
  // the handoff message has actually been delivered to the live agent pane.
  // Otherwise a failed send (e.g. the prompt never reaches an empty state)
  // strands the worker in `ASSIGNED` and `tell-worker assigned` refuses to
  // retry (it requires IDLE/HELD). So: reach the empty prompt first, then send,
  // and only after a successful send write the new state.

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

  if (!tui) {
    // No live-agent handling for this agent; nothing to send, so it is safe to
    // prepare the files directly (there is no fallible send step to gate on).
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
    finalizeAssigned(w, configuredDir, sciDir);
    return;
  }

  // 1. Reach an empty prompt BEFORE touching any state.
  console.log(`${w.id}: waiting for empty prompt (up to 5s)...`);
  if (!await tui.ensurePromptIsEmpty()) {
    console.error(`${w.id}: never reached empty prompt — no changes made; worker left as-is, safe to retry.`);
    process.exit(1);
  }

  // 2. Send the handoff. We compute the guide-change notice WITHOUT writing the
  //    guide yet (peek), so the message text is correct; the actual propagation
  //    happens in finalize() only after the send succeeds.
  const guideWillChange = guideWouldChange(configuredDir, 'proving-guide.md');
  console.log(`${w.id}: clean prompt detected. Sending handoff...`);
  const changeNotice = guideWillChange ? ' IMPORTANT: .sci/proving-guide.md has just been updated with new instructions; please read it carefully.' : '';
  const handoffMsg = `/goal You have been assigned a new task. Please review .sci/goal.md, .sci/plan.md, and .sci/task.md. Then, follow the instructions in .sci/proving-guide.md to acknowledge the assignment and begin work.${changeNotice}`;

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

  // 3. Send succeeded — NOW commit the state changes.
  finalizeAssigned(w, configuredDir, sciDir);
  console.log(`${w.id}: handoff sent to ${agent}.`);
}

/**
 * Atomic worker handoff: reach an empty prompt and send the message FIRST, then
 * run `commit()` (which writes the new status-line / propagates guides). If the
 * prompt is never reachable, nothing is committed — the worker is left as-is and
 * the command is safe to retry. Used by the single-message worker verbs
 * (accept, plan-approved, adjust, unblocked, reject, rebase).
 *
 * `message(notice)` builds the handoff text; `notice` is the guide-change
 * warning, computed via a read-only peek so the text is correct even though the
 * guide is not actually propagated until `commit()`.
 */
async function sendHandoffThenCommit(
  w: WorkerConfig,
  target: string,
  opts: {
    guide?: string;
    configuredDir: string;
    message: (notice: string) => string;
    commit: () => void;
  },
) {
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

  if (!tui) {
    // No live-agent send step; commit directly (nothing fallible to gate on).
    console.log(`${w.id}: no special TUI handling for agent '${agent}' yet.`);
    opts.commit();
    return;
  }

  console.log(`${w.id}: waiting for empty prompt (up to 5s)...`);
  if (!await tui.ensurePromptIsEmpty()) {
    console.error(`${w.id}: never reached empty prompt — no changes made; worker left as-is, safe to retry.`);
    process.exit(1);
  }

  const notice = opts.guide && guideWouldChange(opts.configuredDir, opts.guide)
    ? ` IMPORTANT: .sci/${opts.guide} has just been updated with new instructions; please read it carefully.`
    : '';

  await tmux.sendKeys(target, opts.message(notice), false);
  await sleep(500);
  await tmux.sendKeys(target, 'Enter', false);

  // Send succeeded — now commit the state changes.
  opts.commit();
  console.log(`${w.id}: handoff sent to ${agent}.`);
}

/** Commit the worker-state changes for an `assigned` handoff. Called only after
 * the handoff message has been delivered (or when there is no send step), so a
 * failed send never leaves the worker mutated. */
function finalizeAssigned(w: WorkerConfig, configuredDir: string, sciDir: string) {
  const resultPath = resolve(sciDir, 'result.md');
  if (existsSync(resultPath)) unlinkSync(resultPath);
  const reviewPath = resolve(sciDir, 'review.md');
  if (existsSync(reviewPath)) unlinkSync(reviewPath);

  propagateGuide(configuredDir, 'proving-guide.md');

  const statusPath = resolve(sciDir, 'status-line');
  writeFileSync(statusPath, `ASSIGNED\n`, 'utf8');

  console.log(`${w.id}: files prepared (ASSIGNED, .sci/goal.md + plan.md + task.md, result cleared, guide propagated)`);
}

async function doAccept(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  // Atomic: reach prompt + send BEFORE mutating state, so a failed send leaves
  // the worker untouched and retryable (see doAssigned for the rationale).
  await sendHandoffThenCommit(w, target, {
    guide: 'proving-guide.md',
    configuredDir,
    message: (notice) => `Your recent work has been accepted! Please read your .sci/plan.md, formulate your next commit-sized step in .sci/task.md, and set your status to SUGGEST when your task plan is ready for manager approval. Refer to .sci/proving-guide.md for detailed instructions.${notice}`,
    commit: () => {
      propagateGuide(configuredDir, 'proving-guide.md');
      writeFileSync(statusPath, `WORKING: plan next step\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: plan next step, guide propagated)`);
    },
  });
}

async function doPlanApproved(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const statusPath = resolve(configuredDir, '.sci', 'status-line');

  await sendHandoffThenCommit(w, target, {
    configuredDir,
    message: () => `Your proposed task plan has been approved by the manager! Please begin executing your plan. You may use tools to write code, test it, and commit it. Remember to set your status to READY when finished.`,
    commit: () => {
      writeFileSync(statusPath, `WORKING: starting task\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: starting task)`);
    },
  });
}

async function doAdjust(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const statusPath = resolve(configuredDir, '.sci', 'status-line');

  // The worker can only adjust against feedback the manager wrote to its
  // .sci/review.md (the single canonical location — see approve-task-guide.md /
  // adjust-guide.md). If it is missing, the manager skipped writing feedback;
  // refuse here rather than telling the worker to "adjust" with nothing to act
  // on. No state change — safe to retry once the manager writes review.md.
  const reviewPath = resolve(configuredDir, '.sci', 'review.md');
  if (!existsSync(reviewPath)) {
    console.error(`${w.id}: no .sci/review.md — the manager must write adjustment feedback there before 'adjust'. No changes made.`);
    process.exit(1);
  }

  await sendHandoffThenCommit(w, target, {
    guide: 'adjust-guide.md',
    configuredDir,
    message: (notice) => `Your proposed task plan was not approved by the manager. Please adjust the task in .sci/task.md based on the manager's feedback. Refer to .sci/adjust-guide.md for detailed instructions.${notice}`,
    commit: () => {
      propagateGuide(configuredDir, 'adjust-guide.md');
      writeFileSync(statusPath, `WORKING: adjust task plan\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: adjust task plan, guide propagated)`);
    },
  });
}

async function doUnblocked(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const statusPath = resolve(configuredDir, '.sci', 'status-line');

  await sendHandoffThenCommit(w, target, {
    configuredDir,
    message: () => `The manager has triaged your blocker. Please read .sci/task.md to see their resolution or instructions, adjust your approach as directed, and resume working on your task. Remember to set your status back to READY when finished.`,
    commit: () => {
      writeFileSync(statusPath, `WORKING: resume task\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: resume task)`);
    },
  });
}

async function doReject(w: WorkerConfig, dir: string, target: string) {
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const statusPath = resolve(configuredDir, '.sci', 'status-line');

  await sendHandoffThenCommit(w, target, {
    guide: 'adjust-guide.md',
    configuredDir,
    message: (notice) => `The manager has REJECTED your code! Please read the manager's review in .sci/review.md, revert any bad commits if necessary, fix your code, and submit it again. Remember to set your status back to READY when finished.${notice}`,
    commit: () => {
      propagateGuide(configuredDir, 'adjust-guide.md');
      writeFileSync(statusPath, `WORKING: fix rejected code\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: fix rejected code, guide propagated)`);
    },
  });
}

async function doRebase(w: WorkerConfig, dir: string, target: string, branch: string) {
  checkReadyForIntegration(w);
  await assertTmuxWindowExists(w.session, w.window, w.id);

  const configuredDir = expandHome(dir);
  const statusPath = resolve(configuredDir, '.sci', 'status-line');

  await sendHandoffThenCommit(w, target, {
    guide: 'rebase-guide.md',
    configuredDir,
    message: (notice) => `It is time to integrate your work! Please fetch and rebase your branch onto ${branch}. Resolve any conflicts if they occur. Then run local checks (lake build Jacobian.Solution, python3 scripts/blueprint_audit.py, python3 scripts/blueprint_graph_audit.py). If everything passes, force push your branch to GitHub and create a pull request using the gh CLI. Refer to .sci/rebase-guide.md for detailed instructions.${notice}`,
    commit: () => {
      propagateGuide(configuredDir, 'rebase-guide.md');
      writeFileSync(statusPath, `WORKING: rebase onto ${branch}\n`, 'utf8');
      console.log(`${w.id}: files prepared (WORKING: rebase onto ${branch}, guide propagated)`);
    },
  });
}

async function doReview(manager: WorkerConfig, targetWorkerId: string) {
  checkIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const targetWorker = loadWorkers().find(x => x.id === targetWorkerId);
  if (!targetWorker) {
    console.error(`${manager.id}: Unknown target worker: ${targetWorkerId}`);
    process.exit(1);
  }
  const targetDir = expandHome(targetWorker.dir);

  // Notice computed from a read-only peek; the guide is not propagated until
  // after the send succeeds (atomicity — see sendHandoffThenCommit).
  const changeNotice = guideWouldChange(configuredDir, 'review-guide.md') ? ` IMPORTANT: your own review-guide at ${configuredDir}/.sci/review-guide.md has just been updated with new instructions; please read it carefully.` : '';
  const reviewMessage = `Please review the completed code task for ${targetWorkerId}. Change your directory to the worker's project directory ${targetDir} and inspect the files there: read that worker's ${targetDir}/.sci/goal.md, ${targetDir}/.sci/plan.md, and ${targetDir}/.sci/task.md, and write your review to that worker's ${targetDir}/.sci/review.md. Do not overwrite that worker's ${targetDir}/.sci/result.md; it is reserved for worker task output. Follow the instructions in YOUR OWN review-guide at ${configuredDir}/.sci/review-guide.md, and set YOUR OWN status-line at ${configuredDir}/.sci/status-line (NOT the worker's).${changeNotice}`;

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
    console.error(`${manager.id}: never reached empty prompt — no changes made; safe to retry.`);
    process.exit(1);
  }

  console.log(`${manager.id}: sending review request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, reviewMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  // Send succeeded — now commit manager state.
  propagateGuide(configuredDir, 'review-guide.md');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');
  console.log(`${manager.id}: review request sent for ${targetWorkerId}.`);
}

async function doApproveTask(manager: WorkerConfig, targetWorkerId: string) {
  checkIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const targetWorker = loadWorkers().find(x => x.id === targetWorkerId);
  if (!targetWorker) {
    console.error(`${manager.id}: Unknown target worker: ${targetWorkerId}`);
    process.exit(1);
  }
  const targetDir = expandHome(targetWorker.dir);

  const changeNotice = guideWouldChange(configuredDir, 'approve-task-guide.md') ? ` IMPORTANT: your own approve-task-guide at ${configuredDir}/.sci/approve-task-guide.md has just been updated with new instructions; please read it carefully.` : '';
  const approveMessage = `Please review and approve the proposed next task plan for ${targetWorkerId}. Change your directory to the worker's project directory ${targetDir} and inspect the files there: read that worker's ${targetDir}/.sci/task.md and ${targetDir}/.sci/plan.md. Follow the instructions in YOUR OWN approve-task-guide at ${configuredDir}/.sci/approve-task-guide.md, and set YOUR OWN status-line at ${configuredDir}/.sci/status-line (NOT the worker's).${changeNotice}`;

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
    console.error(`${manager.id}: never reached empty prompt — no changes made; safe to retry.`);
    process.exit(1);
  }

  console.log(`${manager.id}: sending task approval request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, approveMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  // Send succeeded — now commit manager state.
  propagateGuide(configuredDir, 'approve-task-guide.md');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');
  console.log(`${manager.id}: task approval request sent for ${targetWorkerId}.`);
}

async function doUnblock(manager: WorkerConfig, targetWorkerId: string) {
  checkIdle(manager);
  await assertTmuxWindowExists(manager.session, manager.window, manager.id);

  const configuredDir = expandHome(manager.dir);
  const sciDir = resolve(configuredDir, '.sci');
  const statusPath = resolve(sciDir, 'status-line');

  const targetPane = `${manager.session}:${manager.window}.0`;
  const detected = await detectAgent(manager.session, manager.window);
  const agent = (detected || 'unknown').toLowerCase();

  console.log(`${manager.id}: detected agent = ${agent}`);

  const targetWorker = loadWorkers().find(x => x.id === targetWorkerId);
  if (!targetWorker) {
    console.error(`${manager.id}: Unknown target worker: ${targetWorkerId}`);
    process.exit(1);
  }
  const targetDir = expandHome(targetWorker.dir);

  const changeNotice = guideWouldChange(configuredDir, 'unblock-guide.md') ? ` IMPORTANT: your own unblock-guide at ${configuredDir}/.sci/unblock-guide.md has just been updated with new instructions; please read it carefully.` : '';
  const unblockMessage = `Please triage the blocker reported by ${targetWorkerId}. Change your directory to the worker's project directory ${targetDir} and inspect that worker's ${targetDir}/.sci/task.md there, where you should also write your triage feedback. Follow the instructions in YOUR OWN unblock-guide at ${configuredDir}/.sci/unblock-guide.md, and set YOUR OWN status-line at ${configuredDir}/.sci/status-line (NOT the worker's).${changeNotice}`;

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
    console.error(`${manager.id}: never reached empty prompt — no changes made; safe to retry.`);
    process.exit(1);
  }

  console.log(`${manager.id}: sending unblock request for ${targetWorkerId}...`);
  await tmux.sendKeys(targetPane, unblockMessage, false);
  await sleep(500);
  await tmux.sendKeys(targetPane, 'Enter', false);

  // Send succeeded — now commit manager state.
  propagateGuide(configuredDir, 'unblock-guide.md');
  writeFileSync(statusPath, `REVIEWING: ${targetWorkerId}\n`, 'utf8');
  console.log(`${manager.id}: unblock request sent for ${targetWorkerId}.`);
}

async function main() {
  const [workerId, action, ...args] = process.argv.slice(2);

  if (!workerId || !action) {
    console.error('Usage:');
    console.error('  npm run tell-worker -- <worker> assigned');
    console.error('  npm run tell-worker -- <worker> accept');
    console.error('  npm run tell-worker -- <worker> plan-approved');
    console.error('  npm run tell-worker -- <worker> adjust');
    console.error('  npm run tell-worker -- <worker> unblocked');
    console.error('  npm run tell-worker -- <manager> review <worker>');
    console.error('  npm run tell-worker -- <manager> approve-task <worker>');
    console.error('  npm run tell-worker -- <manager> unblock <worker>');
    console.error('  npm run tell-worker -- <worker> rebase [branch]');
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
  } else if (action === 'plan-approved') {
    await doPlanApproved(w, w.dir, target);
  } else if (action === 'adjust') {
    await doAdjust(w, w.dir, target);
  } else if (action === 'unblocked') {
    await doUnblocked(w, w.dir, target);
  } else if (action === 'rebase') {
    const branch = args[0] || 'origin/main';
    await doRebase(w, w.dir, target, branch);
  } else if (action === 'reject') {
    await doReject(w, w.dir, target);
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
