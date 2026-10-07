#!/usr/bin/env node
/**
 * tell-worker — perform one state-machine handoff (docs/state-machine.md §4).
 *
 * The handoff itself (checking the target is idle, reaching an empty agent
 * prompt, `/new` for a fresh conversation, typing the message, copying the
 * git-committed guides from rules/ into the worker's .sci/, and only then
 * updating .sci/status-line) is done by tangentswarm's `tell_worker` tool.
 */
import { withSwarm, type SwarmClient } from './tangentswarm.mts';

export const WORKER_VERBS = ['assigned', 'accept', 'plan-approved', 'adjust', 'unblocked', 'reject', 'rebase'] as const;
export const MANAGER_VERBS = ['review', 'approve-task', 'unblock'] as const;

export const USAGE = [
  'Usage:',
  '  npm run tell-worker -- <worker> assigned',
  '  npm run tell-worker -- <worker> accept',
  '  npm run tell-worker -- <worker> plan-approved',
  '  npm run tell-worker -- <worker> adjust',
  '  npm run tell-worker -- <worker> unblocked',
  '  npm run tell-worker -- <worker> reject',
  '  npm run tell-worker -- <manager> review <worker>',
  '  npm run tell-worker -- <manager> approve-task <worker>',
  '  npm run tell-worker -- <manager> unblock <worker>',
  '  npm run tell-worker -- <worker> rebase [branch]',
].join('\n');

/** Validate argv; returns [worker, verb, arg] or an error message. */
export function parseTellWorkerArgs(argv: string[]): { worker: string; verb: string; arg?: string } | { error: string } {
  const [worker, verb, arg] = argv;
  if (!worker || !verb) return { error: USAGE };
  if ((MANAGER_VERBS as readonly string[]).includes(verb)) {
    if (!arg) return { error: `Usage: npm run tell-worker -- <manager> ${verb} <worker>` };
    return { worker, verb, arg };
  }
  if (!(WORKER_VERBS as readonly string[]).includes(verb)) return { error: `Unknown action: ${verb}` };
  if (verb === 'rebase') return { worker, verb, arg: arg || 'origin/main' };
  return { worker, verb };
}

/** Run one handoff, echoing tangentswarm's log. Returns true on success. */
export async function tellWorker(swarm: SwarmClient, worker: string, verb: string, arg?: string): Promise<boolean> {
  const res = await swarm.tellWorker(worker, verb, arg);
  for (const line of res.log) console.log(line);
  if (!res.ok) console.error(res.error ?? `tell-worker ${worker} ${verb} failed`);
  return res.ok;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseTellWorkerArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }
  withSwarm(s => tellWorker(s, parsed.worker, parsed.verb, parsed.arg))
    .then(ok => process.exit(ok ? 0 : 1))
    .catch(err => {
      console.error((err as Error).message ?? err);
      process.exit(1);
    });
}
