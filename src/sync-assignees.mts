import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT,
  type ChatRef,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';

type Config = { gitRepo: string; claudeEnv: string; sorriesDb: string };

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

async function fetchSessions(url: string): Promise<ChatRef[]> {
  const ws = new WebSocket(url);
  const pending = new Map<string, (r: ServerReply) => void>();

  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true });
    ws.addEventListener('error', () => rej(new Error(`ws error connecting to ${url}`)), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let frame: ServerFrame;
    try { frame = JSON.parse(String(ev.data)) as ServerFrame; } catch { return; }
    if (frame.kind === 'event') return;
    const cb = pending.get(frame.id);
    if (cb) { pending.delete(frame.id); cb(frame); }
  });

  const id = randomUUID();
  const reply = await new Promise<ServerReply>((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, kind: 'list' } satisfies ClientRequest));
  });
  ws.close();
  if (reply.kind !== 'list') throw new Error(`unexpected reply: ${JSON.stringify(reply)}`);
  return reply.chats;
}

function leadingId(name: string): number | null {
  const m = name.match(/^(\d+)\b/);
  return m && m[1] ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  const configPath = resolve(globalThis.process.cwd(), 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  const dbPath = expandHome(config.sorriesDb);
  const url = globalThis.process.env['SCIALECT_URL'] ?? `ws://127.0.0.1:${DEFAULT_PORT}/ws`;

  console.log(`[sync-assignees] fetching session list from ${url} ...`);
  const chats = await fetchSessions(url);

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
