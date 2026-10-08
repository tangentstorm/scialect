/**
 * Talks to a real tangentswarm `swarm-mcp` over stdio (the configured command:
 * SCIALECT_SWARM_MCP, scialect.json, <repo>/.venv/bin/swarm-mcp, or PATH).
 * Skipped when none is installed. Read-only against tmux.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSwarmConfig, SwarmClient, SwarmToolError } from '../src/tangentswarm.mts';
import { REQUIRED_TOOLS } from '../src/check-swarm.mts';

const config = loadSwarmConfig();
const cmd = config.command[0]!;
const available = cmd === 'ssh' || spawnSync('sh', ['-c', `command -v "${cmd}"`]).status === 0;
const skip = available ? false : `swarm-mcp not installed (${config.command.join(' ')}); run npm run setup:swarm`;

let swarm: SwarmClient;
let control: string;

before(async () => {
  if (skip) return;
  const state = mkdtempSync(join(tmpdir(), 'sci-state-'));
  process.env['TANGENTSWARM_STATE_DIR'] = state;         // keep swarm-mcp state out of ~
  control = mkdtempSync(join(tmpdir(), 'sci-control-'));
  const wdir = join(control, 'w-jc0');
  mkdirSync(join(wdir, '.sci'), { recursive: true });
  writeFileSync(join(wdir, '.sci', 'status-line'), 'WORKING: proving lemma 3\n');
  writeFileSync(join(control, 'workers.jsonl'),
    JSON.stringify({ id: 'jc0', dir: wdir, session: 'sci-test-no-such-session', window: '1' }) + '\n');
  swarm = await SwarmClient.connect({ ...config, controlDir: control });
});

after(async () => { await swarm?.close(); });

test('swarm-mcp offers every tool scialect needs', { skip }, async () => {
  const tools = await swarm.toolNames();
  assert.deepEqual(REQUIRED_TOOLS.filter(t => !tools.includes(t)), []);
  assert.equal(tools.filter(t => /kill/.test(t)).length, 0);
});

test('list_sessions returns an array', { skip }, async () => {
  assert.ok(Array.isArray(await swarm.listSessions()));
});

test('swarm_status reads workers.jsonl and the status line', { skip }, async () => {
  const rows = await swarm.swarmStatus();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'jc0');
  assert.match(rows[0]!.status, /proving lemma 3/);
});

test('tool errors surface as SwarmToolError', { skip }, async () => {
  await assert.rejects(swarm.capturePane('sci-test-no-such-session:9'), SwarmToolError);
});

test('tell_worker refuses an unknown worker without touching tmux', { skip }, async () => {
  const r = await swarm.tellWorker('nobody', 'accept');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /nobody/);
});
