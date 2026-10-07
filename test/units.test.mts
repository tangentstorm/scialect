import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSwarmTable, rowToCells } from '../src/swarm-table.mts';
import { parseTellWorkerArgs } from '../src/tell-worker.mts';
import { findChat } from '../src/client.mts';
import type { ChatRef } from '../src/tangentswarm.mts';

test('swarm table keeps lines within 90 columns and truncates status', () => {
  const rows = [rowToCells({ id: 'jc0', agent: 'claude', state: 'WORKING', health: 'OK', status: 'x'.repeat(200) })];
  const lines = formatSwarmTable(rows);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^id +\| agent +\| state +\| health \| status/);
  for (const l of lines) assert.ok(l.length <= 90, `${l.length}: ${l}`);
  assert.ok(lines[2]!.endsWith('…'));
});

test('tell-worker argument validation', () => {
  assert.deepEqual(parseTellWorkerArgs(['jc1', 'accept']), { worker: 'jc1', verb: 'accept' });
  assert.deepEqual(parseTellWorkerArgs(['jc1', 'rebase']), { worker: 'jc1', verb: 'rebase', arg: 'origin/main' });
  assert.deepEqual(parseTellWorkerArgs(['mgr', 'review', 'jc2']), { worker: 'mgr', verb: 'review', arg: 'jc2' });
  assert.ok('error' in parseTellWorkerArgs(['mgr', 'review']));
  assert.ok('error' in parseTellWorkerArgs(['jc1', 'explode']));
  assert.ok('error' in parseTellWorkerArgs([]));
});

test('chat lookup by exact name or unique prefix', () => {
  const chats: ChatRef[] = [
    { id: '1469. Prove skeletal homology', label: '1469. Prove skeletal homology', transport: 'cloud' },
    { id: '1470. Informalize lemma', label: '1470. Informalize lemma', transport: 'cloud' },
    { id: '1470. Informalize lemma 2', label: '1470. Informalize lemma 2', transport: 'cloud' },
  ];
  assert.equal(findChat(chats, '1469')?.id, '1469. Prove skeletal homology');
  assert.equal(findChat(chats, '1470. Informalize lemma')?.id, '1470. Informalize lemma');
  assert.equal(findChat(chats, '1470'), undefined);
});
