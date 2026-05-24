import type { WorkerState } from './protocol.mts';
import { getLiveSwarmRows, printSwarmTable } from './local-status.mts';

// Internal state table - the source of truth while the server is running
let currentState: Record<string, WorkerState> = {};

export function getCurrentSwarmState(): Record<string, WorkerState> {
  return { ...currentState };
}

/**
 * Updates the internal swarm state table and returns only the workers that changed.
 * The caller is responsible for emitting the changes (e.g. via the Hub).
 */
export function updateSwarmState(newState: Record<string, WorkerState>): Record<string, WorkerState> {
  const changes: Record<string, WorkerState> = {};

  for (const [id, state] of Object.entries(newState)) {
    const previous = currentState[id];
    if (!previous || 
        previous.state !== state.state || 
        previous.status !== state.status ||
        previous.agent !== state.agent) {
      changes[id] = state;
    }
  }

  currentState = { ...newState };

  return changes;
}

export async function pollSwarmOnce() {
  const rows = await getLiveSwarmRows();

  const newState: Record<string, WorkerState> = {};
  for (const [id, agent, state, status] of rows) {
    newState[id] = { agent, state, status };
  }

  const changes = updateSwarmState(newState);

  if (Object.keys(changes).length > 0) {
    const g = globalThis as any;
    const hub = g.__scialect?.hub;
    if (hub?.emitSwarmStatus) {
      hub.emitSwarmStatus(changes);
    }
  }

  // Live display for `npm run dev` (watchable in tmux)
  console.clear();
  console.log(`[swarm] ${new Date().toLocaleTimeString()}`);
  printSwarmTable(rows);
}
