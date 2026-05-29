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

  // Case 1: Manager has a pending decision (REVIEWED: ACCEPT/ADJUST/REJECT/UNBLOCKED)
  const reviewedMatch = mgrStatus.match(/^REVIEWED:\s*(ACCEPT|ADJUST|REJECT|UNBLOCKED)\s+([A-Za-z0-9_-]+)/i);
  if (reviewedMatch) {
    const decision = reviewedMatch[1].toUpperCase();
    const targetId = reviewedMatch[2];
    const targetWorker = ordinaryWorkers.find(w => w.id === targetId);

    if (targetWorker) {
      if (decision === 'ACCEPT') {
        const tStatus = getRawStatus(targetWorker.dir);
        if (tStatus.toUpperCase().includes('PLAN APPROVAL')) {
          proposals.push({
            description: `[Decision] Manager approved ${targetId}'s task plan. Transition ${targetId} to execution and reset manager to IDLE.`,
            execute: async () => {
              console.log(`Resetting manager status to IDLE...`);
              writeStatus(mgr.dir, 'IDLE: ...');
              console.log(`Running tell-worker plan-approved for ${targetId}...`);
              const res = spawnSync('npm', ['run', 'tell-worker', '--', targetId, 'plan-approved'], { stdio: 'inherit' });
              if (res.status !== 0) {
                console.error(`Command failed with exit code ${res.status}`);
              }
            }
          });
        } else {
          proposals.push({
            description: `[Decision] Manager accepted ${targetId}'s code work. Transition ${targetId} to planning and reset manager to IDLE.`,
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
        }
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
      } else if (decision === 'UNBLOCKED') {
        proposals.push({
          description: `[Decision] Manager resolved blocker for ${targetId}. Transition ${targetId} back to WORKING and reset manager to IDLE.`,
          execute: async () => {
            console.log(`Resetting manager status to IDLE...`);
            writeStatus(mgr.dir, 'IDLE: ...');
            console.log(`Running tell-worker unblocked for ${targetId}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', targetId, 'unblocked'], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
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
      
      if (wStatus.toUpperCase().startsWith('READY') || wStatus.toUpperCase().startsWith('STEP-DONE')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} is READY. Transition ${w.id} to AWAITING and hand off code review to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to AWAITING: code review...`);
            writeStatus(w.dir, 'AWAITING: code review');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            // tell-worker will check if manager is IDLE and set it to REVIEWING
            console.log(`Running tell-worker review for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'review', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (wStatus.toUpperCase().startsWith('SUGGEST')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} has suggested a new plan (SUGGEST). Transition ${w.id} to AWAITING and hand off task plan approval to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to AWAITING: task plan approval...`);
            writeStatus(w.dir, 'AWAITING: task plan approval');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            // tell-worker will check if manager is IDLE and set it to REVIEWING
            console.log(`Running tell-worker approve-task for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'approve-task', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
        });
      } else if (wStatus.toUpperCase().startsWith('BLOCKED')) {
        proposals.push({
          description: `[Handoff] Worker ${w.id} is BLOCKED. Transition ${w.id} to AWAITING and hand off blocker triage to manager.`,
          execute: async () => {
            console.log(`Setting ${w.id} status to AWAITING: blocker triage...`);
            writeStatus(w.dir, 'AWAITING: blocker triage');
            console.log(`Setting manager status to REVIEWING: ${w.id}...`);
            // tell-worker will check if manager is IDLE and set it to REVIEWING
            console.log(`Running tell-worker unblock for ${w.id}...`);
            const res = spawnSync('npm', ['run', 'tell-worker', '--', 'mgr', 'unblock', w.id], { stdio: 'inherit' });
            if (res.status !== 0) {
              console.error(`Command failed with exit code ${res.status}`);
            }
          }
      } else if (wStatus.toUpperCase().startsWith('PR-AWAIT')) {
        proposals.push({
          description: `[CI] Worker ${w.id} is PR-AWAIT. Check if CI is green and merge PR.`,
          execute: async () => {
            console.log(`Checking PR checks for ${w.id}...`);
            const checkRes = spawnSync('gh', ['pr', 'checks'], { cwd: expandHome(w.dir), encoding: 'utf8' });
            
            if (checkRes.status === 0) {
              console.log(checkRes.stdout);
              console.log(`\n✅ CI passed! Merging PR...`);
              const mergeRes = spawnSync('gh', ['pr', 'merge', '--merge', '--delete-branch'], { cwd: expandHome(w.dir), stdio: 'inherit' });
              if (mergeRes.status === 0) {
                console.log(`Setting status to MERGED.`);
                writeStatus(w.dir, 'MERGED: integrated successfully');
              } else {
                console.error(`Failed to merge PR.`);
              }
            } else {
              console.log(checkRes.stdout || checkRes.stderr);
              console.log(`\n⏳ CI is pending or failed (exit code ${checkRes.status}). Will check again later.`);
            }
          }
        });
      }
    }
  }

  // Check if any worker is currently REBASING or PR-AWAIT
  const activeIntegration = ordinaryWorkers.find(w => {
    const s = getRawStatus(w.dir).toUpperCase();
    return s.startsWith('WORKING: REBASE') || s.startsWith('PR-AWAIT');
  });

  if (!activeIntegration) {
    // If no active integration, propose starting the next HELD worker
    const heldWorkers = ordinaryWorkers.filter(w => getRawStatus(w.dir).toUpperCase().startsWith('HELD'));
    // Sort by id to ensure jc0 -> jc1 -> jc2 -> jc3 -> jc4
    heldWorkers.sort((a, b) => a.id.localeCompare(b.id));
    if (heldWorkers.length > 0) {
      const nextW = heldWorkers[0];
      proposals.push({
        description: `[Integrate] Integration pipeline is empty. Start rebasing ${nextW.id} onto origin/main.`,
        execute: async () => {
          console.log(`Starting rebase sequence for ${nextW.id}...`);
          const res = spawnSync('npm', ['run', 'tell-worker', '--', nextW.id, 'rebase', 'origin/main'], { stdio: 'inherit' });
          if (res.status !== 0) {
            console.error(`Command failed with exit code ${res.status}`);
          }
        }
      });
    }
  }

  // Print pending workers if manager is busy
  const busyWorkers: { id: string; status: string }[] = [];
  if (!isMgrIdle) {
    for (const w of ordinaryWorkers) {
      const wStatus = getRawStatus(w.dir);
      if (wStatus.toUpperCase().startsWith('READY') || 
          wStatus.toUpperCase().startsWith('STEP-DONE') || 
          wStatus.toUpperCase().startsWith('SUGGEST') || 
          wStatus.toUpperCase().startsWith('BLOCKED')) {
        busyWorkers.push({ id: w.id, status: wStatus });
      }
    }
  }

  if (busyWorkers.length > 0) {
    console.log('⚠️  PENDING WORKERS (AWAITING MANAGER TO BE IDLE):');
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
      if (answer.trim().toLowerCase() === 'y' || answer.trim() === '1') {
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
