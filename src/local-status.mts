#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as git from './git.mts';
import * as tmux from './tmux.mts';

interface WorkerConfig {
  id: string;
  dir: string;
  session: string;
  window: string;
  expected_agent?: string;
}

interface AgentRule {
  name: string;
  match: {
    command?: string;
    args_contains?: string;
    title_contains?: string;
  };
}

interface PaneInfo {
  index: string;
  pid: string;
  command: string;
  path: string;
  title: string;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function shorten(p: string): string {
  const home = homedir();
  if (p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function getMtime(path: string): Date | null {
  try { return statSync(path).mtime; } catch { return null; }
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

function getChildrenPids(pid: string): string[] {
  const res = spawnSync('pgrep', ['-P', pid], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout.trim().split('\n').filter(Boolean);
}

function getProcessInfo(pid: string): { command: string; args: string } {
  const res = spawnSync('ps', ['-p', pid, '-o', 'comm=,args='], { encoding: 'utf8' });
  if (res.status !== 0) return { command: '', args: '' };
  const line = res.stdout.trim();
  const space = line.indexOf(' ');
  if (space === -1) return { command: line, args: '' };
  return { command: line.slice(0, space), args: line.slice(space + 1) };
}

function matchAgent(rules: AgentRule[], command: string, args: string, title: string): string | null {
  const cmdBase = command.split('/').pop() || command;
  for (const rule of rules) {
    const m = rule.match;
    if (m.command && cmdBase !== m.command) continue;
    if (m.args_contains && !args.includes(m.args_contains)) continue;
    if (m.title_contains && !title.includes(m.title_contains)) continue;
    return rule.name;
  }
  return null;
}

async function findAgentInWindow(
  session: string,
  window: string,
  rules: AgentRule[]
): Promise<{ detectedAgent: string | null; liveCwd: string | null }> {
  const windowTarget = `${session}:${window}`;
  try {
    const res = await tmux.listPanes(windowTarget, '#{pane_index} #{pane_pid} #{pane_current_command} #{pane_current_path} "#{pane_title}"');
    if (res.code !== 0 || !res.stdout.trim()) return { detectedAgent: null, liveCwd: null };

    const panes: PaneInfo[] = res.stdout.trim().split('\n').map(line => {
      const [index, pid, command, path, ...titleParts] = line.split(' ');
      const title = titleParts.join(' ').replace(/^"|"$/g, '');
      return { index, pid, command, path, title };
    });

    for (const pane of panes) {
      const own = getProcessInfo(pane.pid);
      let agent = matchAgent(rules, own.command, own.args, pane.title);
      if (agent) return { detectedAgent: agent, liveCwd: pane.path };

      for (const childPid of getChildrenPids(pane.pid)) {
        const info = getProcessInfo(childPid);
        agent = matchAgent(rules, info.command, info.args, pane.title);
        if (agent) return { detectedAgent: agent, liveCwd: pane.path };
      }
    }

    if (panes.length > 0) {
      return { detectedAgent: null, liveCwd: panes[0].path };
    }
  } catch {}
  return { detectedAgent: null, liveCwd: null };
}

function formatState(goal: Date | null, result: Date | null): string {
  if (!goal) return 'NO GOAL';
  if (result && result > goal) return 'DONE';
  return 'BUSY';
}

function getGitStatusSummary(cwd: string): string {
  try {
    const res = spawnSync(
      'sh',
      ['-c', `git status --porcelain | cut -c1-2 | sed 's/ //g' | sort | uniq -c | awk '{printf " %s:%s", $2, $1}'`],
      { cwd, encoding: 'utf8' }
    );
    if (res.status !== 0 || !res.stdout) return '';
    const out = res.stdout.trim();
    return out ? ` (${out})` : '';
  } catch {
    return '';
  }
}

async function main() {
  const workersPath = resolve(process.cwd(), 'workers.jsonl');
  const lines = readFileSync(workersPath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const workers: WorkerConfig[] = lines.map(l => JSON.parse(l) as WorkerConfig);
  const rules = loadKnownAgents();

  const rows: string[][] = [];

  for (const w of workers) {
    const configuredDir = expandHome(w.dir);
    const { detectedAgent, liveCwd } = await findAgentInWindow(w.session, w.window, rules);

    let branch = '—';
    try {
      const res = await git.branchShowCurrent(configuredDir);
      branch = res.stdout.trim() || '—';
    } catch {}

    const goalPath = resolve(configuredDir, '.sci', 'goal.md');
    const resultPath = resolve(configuredDir, '.sci', 'result.md');
    const goalM = getMtime(goalPath);
    const resultM = getMtime(resultPath);
    let state = formatState(goalM, resultM);

    const statusSuffix = getGitStatusSummary(configuredDir);

    let statusDisplay = branch + statusSuffix;

    // Prefer .sci/status-line if present
    const statusLinePath = resolve(configuredDir, '.sci', 'status-line');
    try {
      const content = readFileSync(statusLinePath, 'utf8').trim();
      if (content) {
        const firstLine = content.split('\n')[0].trim();
        if (firstLine) {
          // Extract keyword + remainder
          const match = firstLine.match(/^([A-Za-z0-9_-]+)[:\s]?(.*)$/);
          if (match) {
            const keyword = match[1];
            const rest = match[2] ? match[2].trim() : '';
            state = keyword.toUpperCase();
            statusDisplay = rest ? (rest + statusSuffix) : (keyword + statusSuffix);
          } else {
            statusDisplay = firstLine + statusSuffix;
          }
        }
      }
    } catch {
      // no .sci/status-line → keep computed state + branch
    }

    let agentDisplay = detectedAgent || 'unknown';
    if (w.expected_agent && detectedAgent && detectedAgent !== w.expected_agent) {
      agentDisplay += '!!';
    }

    rows.push([w.id, agentDisplay, state, statusDisplay]);
  }

  // Print table
  const headers = ['id', 'agent', 'state', 'status'];
  const all = [headers, ...rows];

  const widths = headers.map((_, i) =>
    Math.max(...all.map(row => (row[i] ?? '').length))
  );

  const line = (row: string[]) =>
    row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(' | ');

  console.log(line(headers));
  console.log(widths.map(w => '-'.repeat(w)).join('-+-'));
  for (const r of rows) {
    console.log(line(r));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
