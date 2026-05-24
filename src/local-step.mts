#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getLiveSwarmRows, printSwarmTable } from './local-status.mts';

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

function getRawStatus(dir: string): string {
  const statusPath = resolve(expandHome(dir), '.sci', 'status-line');
  try {
    if (existsSync(statusPath)) {
      return readFileSync(statusPath, 'utf8').trim();
    }
  } catch {}
  return '';
}

function writeStatus(dir: string, newStatus: string) {
  const statusPath = resolve(expandHome(dir), '.sci', 'status-line');
  writeFileSync(statusPath, newStatus + '\n', 'utf8');
}

interface ActionProposal {
  description: string;
  execute: () => Promise<void>;
}

async function main() {
  console.log('\n=== CURRENT SWARM STATUS ===');
  const rows = await getLiveSwarmRows();
  printSwarmTable(rows);
  console.log('============================\n');

  const workers = loadWorkers();
  const mgr = workers.find(w => w.id === 'mgr');
  const ordinaryWorkers = workers.filter(w => w.id !== 'mgr');

  if (!mgr) {
    console.error("Error: Could not find 'mgr' in workers.jsonl");
    process.exit(1);
  }

  const mgrStatus = getRawStatus(mgr.dir);
  const isMgrIdle = mgrStatus.toUpperCase().startsWith('IDLE');

  const proposals: ActionProposal[] = [];

  // Case 1: Manager has a pending decision (REVIEWED: ACCEPT/ADJUST/REJECT)
  const reviewedMatch = mgrStatus.match(/^REVIEWED:\s*(ACCEPT|ADJUST|REJECT)\s+([A-Za-z0-9_-]+)/i);
  if (reviewedMatch) {
    const decision = reviewedMatch[1].toUpperCase();
    const targetId = reviewedMatch[2];
    const targetWorker = ordinaryWorkers.find(w => w.id === targetId);

    if (targetWorker) {
      if (decision === 'ACCEPT') {
        proposals.push({
          description: `[Decision] Manager accepted ${targetId}'s work. Transition ${targetId} to planning and reset manager to IDLE.`,
          execute: async () => {
            console.log(`Resetting manager status to IDLE...`);
            writeStatus(mgr.dir, 'IDLE: ...');
            console.log(`Running tell-worker accept for ${targetId}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', targetId, 'accept'], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (decision === 'ADJUST') {
        proposals.push({
          description: `[Decision] Manager requested adjustments for ${targetId}'s plan. Transition ${targetId} to adjusting and reset manager to IDLE.`,
          execute: async () => {
            console.log(`Resetting manager status to IDLE...`);
            writeStatus(mgr.dir, 'IDLE: ...');
            console.log(`Running tell-worker adjust for ${targetId}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', targetId, 'adjust'], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (decision === 'REJECT') {
        proposals.push({
          description: `[Decision] Manager REJECTED ${targetId}'s work. Reset manager to IDLE and transition ${targetId} back to WORKING.`,
          execute: async () => {
            console.log(`Resetting manager status to IDLE...`);
            writeStatus(mgr.dir, 'IDLE: ...');
            console.log(`Setting ${targetId} status to WORKING...`);
            writeStatus(targetWorker.dir, 'WORKING: starting task');
            console.log(`⚠️  NOTE: Please manually revert/rollback git changes in ${targetId}'s repository if needed.`);
          }
        });
      }
    }
  }

  // Case 2: Worker has completed a step (READY), proposed a plan (SUGGEST), or is BLOCKED
  // This is only actionable if the manager is IDLE
  if (isMgrIdle) {
    for (const w of ordinaryWorkers) {
      const wStatus = getRawStatus(w.dir);
      
      if (wStatus.toUpperCase().startsWith('READY')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} is READY. Transition ${w.id} to WAITING and hand off code review to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to WAITING: code review...`);
            writeStatus(w.dir, 'WAITING: code review');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            writeStatus(mgr.dir, `REVIEWING: ${w.id}`);
            console.log(`Running tell-worker review for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'review', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (wStatus.toUpperCase().startsWith('SUGGEST')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} has suggested a new plan (SUGGEST). Transition ${w.id} to WAITING and hand off task plan approval to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to WAITING: task plan approval...`);
            writeStatus(w.dir, 'WAITING: task plan approval');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            writeStatus(mgr.dir, `REVIEWING: ${w.id}`);
            console.log(`Running tell-worker approve-task for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'approve-task', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (wStatus.toUpperCase().startsWith('BLOCKED')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} is BLOCKED. Transition ${w.id} to WAITING and hand off blocker triage to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to WAITING: blocker triage...`);
            writeStatus(w.dir, 'WAITING: blocker triage');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            writeStatus(mgr.dir, `REVIEWING: ${w.id}`);
            console.log(`Running tell-worker unblock for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'unblock', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      }
    }
  }

  // Print pending workers if manager is busy
  const busyWorkers: { id: string; status: string }[] = [];
  if (!isMgrIdle) {
    for (const w of ordinaryWorkers) {
      const wStatus = getRawStatus(w.dir);
      if (wStatus.toUpperCase().startsWith('READY') || 
          wStatus.toUpperCase().startsWith('SUGGEST') || 
          wStatus.toUpperCase().startsWith('BLOCKED')) {
        busyWorkers.push({ id: w.id, status: wStatus });
      }
    }
  }

  if (busyWorkers.length > 0) {
    console.log('⚠️  PENDING WORKERS (WAITING FOR MANAGER TO BE IDLE):');
    for (const bw of busyWorkers) {
      console.log(`- ${bw.id} is currently ${bw.status}`);
    }
    console.log('');
  }

  if (proposals.length === 0) {
    console.log('No actionable transitions detected.');
    process.exit(0);
  }

  const rl = createInterface({ input, output });

  try {
    if (proposals.length === 1) {
      const prop = proposals[0];
      console.log(`PROPOSED ACTION:`);
      console.log(`  ${prop.description}\n`);
      
      const answer = await rl.question('Proceed with this action? (y/N): ');
      if (answer.trim().toLowerCase() === 'y') {
        console.log('\nExecuting action...');
        await prop.execute();
        console.log('Done!');
      } else {
        console.log('\nAction cancelled.');
      }
    } else {
      console.log('MULTIPLE PROPOSED ACTIONS DETECTED:');
      proposals.forEach((prop, index) => {
        console.log(`  ${index + 1}) ${prop.description}`);
      });
      console.log('');

      const answer = await rl.question(`Select an action to execute (1-${proposals.length}) or 'q' to quit: `);
      const choice = answer.trim().toLowerCase();
      if (choice === 'q') {
        console.log('\nExiting.');
      } else {
        const num = parseInt(choice, 10);
        if (num >= 1 && num <= proposals.length) {
          const prop = proposals[num - 1];
          console.log(`\nExecuting action ${num}...`);
          await prop.execute();
          console.log('Done!');
        } else {
          console.log('\nInvalid choice.');
        }
      }
    }
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
