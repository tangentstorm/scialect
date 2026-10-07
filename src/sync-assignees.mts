import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { withSwarm, type ChatRef } from './tangentswarm.mts';

type Config = { gitRepo: string; claudeEnv: string; sorriesDb: string };

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

async function fetchSessions(): Promise<ChatRef[]> {
  return withSwarm(async (swarm) => (await swarm.cloudListSessions()).sessions);
}

function leadingId(name: string): number | null {
  const m = name.match(/^(\d+)\b/);
  return m && m[1] ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const configPath = resolve(globalThis.process.cwd(), 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  const dbPath = expandHome(config.sorriesDb);
  console.log('[sync-assignees] fetching session list from tangentswarm (cloud_list_sessions) ...');
  const chats = await fetchSessions();

  const slugById = new Map<number, string>();
  let withoutId = 0;
  let withoutSlug = 0;
  for (const c of chats) {
    const sid = leadingId(c.id);
    if (sid == null) { withoutId++; continue; }
    if (!c.slug) { withoutSlug++; continue; }
    const stripped = c.slug.startsWith('session_') ? c.slug.slice('session_'.length) : c.slug;
    if (!slugById.has(sid)) slugById.set(sid, stripped);
  }
  console.log(`[sync-assignees] ${chats.length} sessions; ${slugById.size} with leading id+slug` +
    (withoutId ? `, ${withoutId} without leading id` : '') +
    (withoutSlug ? `, ${withoutSlug} without slug` : ''));

  const text = readFileSync(dbPath, 'utf8');
  const lines = text.split('\n');
  let filled = 0;
  let alreadySet = 0;
  let stripped = 0;
  const outLines = lines.map((raw) => {
    if (!raw.trim()) return raw;
    let obj: { i: unknown; a?: string };
    try { obj = JSON.parse(raw); } catch { return raw; }
    if (obj.i === 'ID' || typeof obj.i !== 'number') return raw;
    let changed = false;
    if (obj.a && obj.a.startsWith('claude:session_')) {
      obj.a = 'claude:' + obj.a.slice('claude:session_'.length);
      stripped++;
      changed = true;
    }
    const slug = slugById.get(obj.i);
    if (slug && !(obj.a && obj.a.length > 0)) {
      obj.a = `claude:${slug}`;
      filled++;
      changed = true;
    } else if (slug && obj.a && obj.a.length > 0 && !changed) {
      alreadySet++;
    }
    return changed ? JSON.stringify(obj) : raw;
  });

  if (filled === 0 && stripped === 0) {
    console.log(`[sync-assignees] no changes; ${alreadySet} sorries already had an assignee`);
    return;
  }
  const tmp = dbPath + '.tmp';
  writeFileSync(tmp, outLines.join('\n'));
  renameSync(tmp, dbPath);
  console.log(`[sync-assignees] wrote ${filled} new assignments, stripped ${stripped} session_ prefixes; ${alreadySet} left untouched`);
}

main().catch((err) => {
  console.error(`[sync-assignees] ${(err as Error).message}`);
  globalThis.process.exit(1);
});
