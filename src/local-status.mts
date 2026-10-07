#!/usr/bin/env node
/**
 * local-status — one row per worker in workers.jsonl: id | agent | state | health | status.
 *
 * The rows are computed by tangentswarm (`swarm_status` MCP tool): agent
 * detection from the tmux pane's process tree, goal/result timestamps,
 * STUCK detection from unchanged screens, and the worker's .sci/status-line.
 */
import { withSwarm, type SwarmClient } from './tangentswarm.mts';
import { printSwarmTable, rowToCells } from './swarm-table.mts';

export { printSwarmTable };

export async function getLiveSwarmRows(swarm?: SwarmClient): Promise<string[][]> {
  const rows = swarm ? await swarm.swarmStatus() : await withSwarm(s => s.swarmStatus());
  return rows.map(rowToCells);
}

export async function printLocalStatus(swarm?: SwarmClient): Promise<void> {
  printSwarmTable(await getLiveSwarmRows(swarm));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  printLocalStatus().catch(err => {
    console.error((err as Error).message ?? err);
    process.exit(1);
  });
}
