/** Formatting for the swarm status table (id | agent | state | health | status). */
import type { SwarmRow } from './tangentswarm.mts';

export const SWARM_HEADERS = ['id', 'agent', 'state', 'health', 'status'] as const;
export const MAX_TABLE_WIDTH = 90;

export function rowToCells(r: SwarmRow): string[] {
  return [r.id, r.agent, r.state, r.health, r.status];
}

export function formatSwarmTable(rows: string[][], maxWidth = MAX_TABLE_WIDTH): string[] {
  const headers = [...SWARM_HEADERS];
  const all = [headers, ...rows];

  // Natural (content) width of each column.
  const widths = headers.map((_, i) => Math.max(...all.map(row => (row[i] ?? '').length)));

  // Keep the whole line within maxWidth. The separator " | " between N columns
  // costs 3*(N-1) chars; the first four columns (id/agent/state/health) are
  // short, so absorb any overflow by clamping the last column (status).
  const sep = ' | ';
  const sepTotal = sep.length * (headers.length - 1);
  const lastIdx = headers.length - 1;
  const fixed = widths.slice(0, lastIdx).reduce((a, b) => a + b, 0);
  const statusBudget = Math.max(3, maxWidth - sepTotal - fixed);
  if (widths[lastIdx]! > statusBudget) widths[lastIdx] = statusBudget;

  const fit = (cell: string, w: number) =>
    cell.length > w ? cell.slice(0, Math.max(0, w - 1)) + '…' : cell.padEnd(w);
  const line = (row: string[]) => row.map((cell, i) => fit(cell ?? '', widths[i] ?? 0)).join(sep);

  return [line(headers), widths.map(w => '-'.repeat(w)).join('-+-'), ...rows.map(line)];
}

export function printSwarmTable(rows: string[][]): void {
  for (const l of formatSwarmTable(rows)) console.log(l);
}
