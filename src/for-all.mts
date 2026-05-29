#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

interface WorkerConfig {
  id: string;
  dir: string;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run for-all -- '<cmd>'");
  process.exit(1);
}
const cmdStr = args.join(' ');

const workersPath = resolve(process.cwd(), 'workers.jsonl');
let workers: WorkerConfig[] = [];
try {
  workers = readFileSync(workersPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
} catch (err) {
  console.error("Failed to read workers.jsonl", err);
  process.exit(1);
}

for (const w of workers) {
  const targetDir = expandHome(w.dir);
  console.log(`\n=== Running in ${w.id} (${targetDir}) ===`);
  const res = spawnSync(cmdStr, { shell: true, cwd: targetDir, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`Command failed in ${w.id} with exit code ${res.status}`);
  }
}
console.log('\n=== Done ===');
