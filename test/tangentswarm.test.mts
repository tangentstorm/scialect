import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeToolResult, loadSwarmConfig, splitCommand, SwarmToolError } from '../src/tangentswarm.mts';

test('splitCommand honours quotes', () => {
  assert.deepEqual(splitCommand('ssh memnar-mcp'), ['ssh', 'memnar-mcp']);
  assert.deepEqual(splitCommand(`ssh -i '/a b/key' -o "X=1 2" host`), ['ssh', '-i', '/a b/key', '-o', 'X=1 2', 'host']);
  assert.deepEqual(splitCommand('   '), []);
});

test('loadSwarmConfig precedence: env > scialect.json > repo .venv > PATH', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sci-cfg-'));
  const repo = mkdtempSync(join(tmpdir(), 'sci-repo-'));
  // defaults
  let c = loadSwarmConfig({ env: {}, cwd, repoRoot: repo });
  assert.deepEqual(c.command, ['swarm-mcp']);
  assert.deepEqual(c.cli, ['swarm']);
  assert.equal(c.controlDir, cwd);
  // repo .venv
  mkdirSync(join(repo, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(repo, '.venv', 'bin', 'swarm-mcp'), '');
  c = loadSwarmConfig({ env: {}, cwd, repoRoot: repo });
  assert.deepEqual(c.command, [join(repo, '.venv', 'bin', 'swarm-mcp')]);
  // scialect.json
  writeFileSync(join(cwd, 'scialect.json'), JSON.stringify({ swarm: { mcpCommand: ['ssh', 'memnar-mcp'], controlDir: '/srv/sci', cli: 'swarm' } }));
  c = loadSwarmConfig({ env: {}, cwd, repoRoot: repo });
  assert.deepEqual(c.command, ['ssh', 'memnar-mcp']);
  assert.equal(c.controlDir, '/srv/sci');
  // env wins
  c = loadSwarmConfig({ env: { SCIALECT_SWARM_MCP: 'ssh -T other', SCIALECT_CONTROL_DIR: '/x' }, cwd, repoRoot: repo });
  assert.deepEqual(c.command, ['ssh', '-T', 'other']);
  assert.equal(c.controlDir, '/x');
});

test('decodeToolResult parses JSON, passes plain text, throws on isError', () => {
  assert.deepEqual(decodeToolResult('t', { content: [{ type: 'text', text: '{"a": 1}' }] }), { a: 1 });
  assert.equal(decodeToolResult('t', { content: [{ type: 'text', text: 'plain $ ' }] }), 'plain $ ');
  assert.deepEqual(decodeToolResult('t', { content: [], structuredContent: { b: 2 } }), { b: 2 });
  assert.throws(() => decodeToolResult('send_keys', { isError: true, content: [{ type: 'text', text: 'insufficient_scope' }] }),
    (e: unknown) => e instanceof SwarmToolError && /send_keys: insufficient_scope/.test(e.message));
});
