#!/usr/bin/env node
/**
 * for-all — run a shell command in every worker directory listed in workers.jsonl.
 *
 * Delegates to `swarm -c for-all` (tangentswarm's CLI) rather than MCP because
 * the output is streamed to the terminal as it runs. Runs locally.
 */
import { spawnSync } from 'node:child_process';
import { loadSwarmConfig } from './tangentswarm.mts';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: npm run for-all -- '<cmd>'");
  process.exit(1);
}
const [cmd, ...pre] = loadSwarmConfig().cli;
const res = spawnSync(cmd!, [...pre, '-c', 'for-all', ...args], { stdio: 'inherit' });
if (res.error) {
  console.error(`could not run ${cmd}: ${res.error.message} (install tangentswarm: npm run setup:swarm)`);
  process.exit(1);
}
process.exit(res.status ?? 1);
