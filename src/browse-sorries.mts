import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';
import {
  CSCR,
  cursor,
  goxy,
  renderDiff,
  UiTree,
  VideoBuffer,
  type RenderTarget,
  type TreeFetch,
  type TreeSeed,
} from 'kvm';

type Sorry = {
  i: number;
  f: string;
  k?: string;
  s: string;
  n?: number;
  o?: number;
  r?: 0 | 1;
  e?: number | null;
  u?: number[];
  d?: number[];
  a?: string;
  c?: string;
  b?: string;
  t?: string;
  l?: number;
};

type Config = {
  gitRepo: string;
  claudeEnv: string;
  sorriesDb: string;
};

type Mode = 'frontier' | 'leaves';

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

function loadConfig(path: string): Config {
  return JSON.parse(readFileSync(path, 'utf8')) as Config;
}

function findLeanDeclLine(path: string, keyword: string, statement: string): number {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return 1; }
  const lines = text.split('\n');
  const escName = statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const kw = keyword || '\\w+';
  const decl = new RegExp(`^\\s*(?:@\\[[^\\]]*\\]\\s*)?(?:private\\s+|protected\\s+|noncomputable\\s+)*${kw}\\s+${escName}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (decl.test(lines[i] ?? '')) return i + 1;
  }
  const bare = new RegExp(`\\b${escName}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (bare.test(lines[i] ?? '')) return i + 1;
  }
  return 1;
}

function loadDb(path: string): Map<number, Sorry> {
  const db = new Map<number, Sorry>();
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.i === 'ID') continue;
    db.set(obj.i as number, obj as Sorry);
  }
  return db;
}

function crawlTex(root: string): Map<string, { path: string; line: number }> {
  const out = new Map<string, { path: string; line: number }>();
  const labelRe = /\\label\{([^}]+)\}/g;
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) walk(p);
      else if (s.isFile() && name.endsWith('.tex')) {
        let text;
        try { text = readFileSync(p, 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          labelRe.lastIndex = 0;
          let m;
          while ((m = labelRe.exec(line)) !== null) {
            const label = m[1];
            if (label && !out.has(label)) out.set(label, { path: p, line: i + 1 });
          }
        }
      }
    }
  };
  walk(root);
  return out;
}

function isDone(node: Sorry | undefined): boolean {
  return node?.c === 'done';
}

function depCounts(db: Map<number, Sorry>, node: Sorry): { open: number; total: number } {
  const u = node.u ?? [];
  let open = 0;
  for (const id of u) if (!isDone(db.get(id))) open++;
  return { open, total: u.length };
}

function computeRoots(db: Map<number, Sorry>, mode: Mode, showDone: boolean): number[] {
  const reachable: number[] = [];
  for (const [id, n] of db) if (n.r === 1) reachable.push(id);

  if (!showDone) {
    const open = reachable.filter(id => !isDone(db.get(id)));
    if (mode === 'leaves') {
      return open
        .filter(id => (db.get(id)!.u ?? []).every(uid => isDone(db.get(uid))))
        .sort((a, b) => a - b);
    }
    const roots = open.filter(id => {
      const d = db.get(id)!.d ?? [];
      return d.length === 0 || d.every(did => isDone(db.get(did)));
    });
    if (roots.length === 0 && open.length > 0) {
      const topOpen = open.filter(id => (db.get(id)!.d ?? []).length === 0);
      return (topOpen.length > 0 ? topOpen : open.slice(0, 10)).sort((a, b) => a - b);
    }
    return roots.sort((a, b) => a - b);
  }

  if (mode === 'leaves') {
    return reachable.filter(id => (db.get(id)!.u ?? []).length === 0).sort((a, b) => a - b);
  }
  return reachable.filter(id => (db.get(id)!.d ?? []).length === 0).sort((a, b) => a - b);
}

function childrenOf(db: Map<number, Sorry>, id: number, showDone: boolean): number[] {
  const u = db.get(id)?.u ?? [];
  const filtered = showDone ? u : u.filter(cid => !isDone(db.get(cid)));
  return [...filtered].sort((a, b) => a - b);
}

function statusColor(node: Sorry): number {
  if (isDone(node)) return -10;
  if (node.r === 1) return -11;
  return -8;
}

const WORKER_WIDTH = 10;

function assigneeBadge(a: string | undefined): string {
  if (!a) return ' '.repeat(WORKER_WIDTH);
  const colon = a.indexOf(':');
  const kind = (colon >= 0 ? a.slice(0, colon) : a).toLowerCase();
  const id = colon >= 0 ? a.slice(colon + 1) : '';
  const tag = `${kind[0] ?? 'w'}:${id}`;
  return tag.slice(0, WORKER_WIDTH).padEnd(WORKER_WIDTH, ' ');
}

function formatRow(db: Map<number, Sorry>, id: number, width: number): string {
  const n = db.get(id);
  if (!n) return `${id} <missing>`;
  const { open, total } = depCounts(db, n);
  const deps = total === 0 ? '   -  ' : `${String(open).padStart(2)}/${String(total).padStart(2)}`.padStart(6);
  const r = n.r === 1 ? '*' : ' ';
  const bp = n.b ? 'b' : ' ';
  const worker = assigneeBadge(n.a);
  const eff = n.e == null ? ' ?' : String(n.e).padStart(2);
  const head = `${String(id).padStart(5)} ${r} ${bp} ${worker} ${deps} e${eff} `;
  return (head + n.s).slice(0, Math.max(head.length, width));
}

class SorriesTree extends UiTree<number> {
  constructor(
    private db: Map<number, Sorry>,
    seed: TreeSeed<number>[],
    width: number,
    height: number,
    fetchItems: TreeFetch<number>,
  ) {
    super(seed, width, height, fetchItems);
    this.TX_BG = -234;
  }

  override renderItem(target: RenderTarget, index: number, item: number): void {
    const indent = ' '.repeat(this.depth[index] ?? 0);
    const icon = this.hasChildren[index] ? (this.expanded[index] ? '-' : '+') : ' ';
    const prefix = `${indent}${icon} `;
    const row = formatRow(this.db, item, Math.max(1, this.width - prefix.length));
    if (index !== this.cursor) {
      const node = this.db.get(item);
      if (node) target.fg(statusColor(node));
    }
    target.puts((prefix + row).slice(0, this.width).padEnd(this.width, ' '));
  }
}

type State = {
  mode: Mode;
  showDone: boolean;
  showHelp: boolean;
  toast: string;
};

function buildTree(db: Map<number, Sorry>, state: State, width: number, height: number): SorriesTree {
  const roots = computeRoots(db, state.mode, state.showDone);
  const seed: TreeSeed<number>[] = roots.map(id => ({
    label: id,
    hasChildren: childrenOf(db, id, state.showDone).length > 0,
    depth: 0,
  }));
  const fetchItems: TreeFetch<number> = (tree, index) => {
    const parentId = tree.items[index];
    if (parentId == null) return { labels: [], hasChildren: [] };
    const kids = childrenOf(db, parentId, state.showDone);
    return {
      labels: kids,
      hasChildren: kids.map(cid => childrenOf(db, cid, state.showDone).length > 0),
    };
  };
  return new SorriesTree(db, seed, width, height, fetchItems);
}

function clampTreeView(tree: UiTree<number>): void {
  if (tree.cursor < tree.scroll) tree.scroll = tree.cursor;
  if (tree.cursor >= tree.scroll + tree.height) tree.scroll = tree.cursor - tree.height + 1;
  tree.scroll = Math.max(0, Math.min(tree.scroll, Math.max(0, tree.items.length - tree.height)));
}

function statusLine(db: Map<number, Sorry>, tree: UiTree<number>, state: State, width: number): string {
  const id = tree.items[tree.cursor];
  const node = id != null ? db.get(id) : undefined;
  const rootCount = tree.items.filter((_, i) => tree.depth[i] === 0).length;
  const left = `mode:${state.mode}  done:${state.showDone ? 'shown' : 'hidden'}  roots:${rootCount}`;
  const right = node ? `  #${id} ${node.f}:${node.l ?? '?'}  bp:${node.b || '-'}` : '';
  const help = '  [?] help  [v/V] lean/tex  [c] chat  [arrows] move  [enter] expand  [u] up  [m] mode  [t] done  [q] quit';
  return (left + right + help).slice(0, width).padEnd(width, ' ');
}

const HELP_LINES = [
  'Columns:',
  '  +/- : node has children (collapsed / expanded)',
  '   id : sorry id (matches "i" in sorries.jsonl)',
  '    * : reachable from root goal (r=1); blank = unreachable',
  '    b : has blueprint label; blank = no tex blueprint',
  'c:sid : assignee shown as kind-letter + session id; blank = unassigned',
  '  o/t : open / total upstream deps (- if no upstream)',
  '   eN : effort estimate 1..10 (? if unset)',
  '        statement = lean def/theorem name',
  '',
  'Colors: green=done  yellow=reachable  dim=unreachable',
  '',
  'Modes:',
  '  frontier = open nodes whose downstream are all done',
  '  leaves   = open nodes with no open upstream deps',
  '',
  'Keys:',
  '  up / p          previous',
  '  down / n        next',
  '  PgUp / PgDn     page',
  '  enter / tab / space   expand / collapse',
  '  right           expand',
  '  left / u        collapse, or go up to parent',
  '  m               toggle frontier / leaves mode',
  '  t               toggle show-done',
  '  v               edit .lean source ($EDITOR / vim)',
  '  V               edit .tex blueprint',
  '  c               open assignee chat in browser',
  '  ?               this help',
  '  q / Ctrl-C      quit',
  '',
  'Press any key to close.',
];

function drawHelp(frame: VideoBuffer, width: number, height: number): void {
  const boxW = Math.min(width - 4, 62);
  const boxH = Math.min(height - 2, HELP_LINES.length + 2);
  const x0 = Math.floor((width - boxW) / 2);
  const y0 = Math.floor((height - boxH) / 2);
  for (let y = 0; y < boxH; y++) {
    frame.goxy(x0, y0 + y).fg(-15).bg(-238).puts(' '.repeat(boxW));
  }
  for (let i = 0; i < HELP_LINES.length && i < boxH - 2; i++) {
    frame.goxy(x0 + 2, y0 + 1 + i).fg(-15).bg(-238).puts((HELP_LINES[i] ?? '').slice(0, boxW - 4));
  }
}

async function lookupSessionName(slug: string): Promise<string | null> {
  const url = globalThis.process.env['SCIALECT_URL'] ?? `ws://127.0.0.1:${DEFAULT_PORT}/ws`;
  const ws = new WebSocket(url);
  const pending = new Map<string, (r: ServerReply) => void>();
  try {
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error(`ws connect failed: ${url}`)), { once: true });
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
    if (reply.kind !== 'list') return null;
    const bare = slug.startsWith('session_') ? slug.slice('session_'.length) : slug;
    const full = slug.startsWith('session_') ? slug : `session_${slug}`;
    const hit = reply.chats.find(c => c.slug === full || c.slug === bare);
    return hit?.id ?? null;
  } finally {
    ws.close();
  }
}

function runBrowser(configPath: string): void {
  const config = loadConfig(configPath);
  const dbPath = expandHome(config.sorriesDb);
  const db = loadDb(dbPath);
  const repoRoot = dirname(dbPath);
  const texMap = crawlTex(join(repoRoot, 'tex'));

  const width = Math.min(globalThis.process.stdout.columns ?? 100, 160);
  const height = Math.max(8, (globalThis.process.stdout.rows ?? 24) - 2);
  const write = (text: string): boolean => globalThis.process.stdout.write(text);

  const state: State = { mode: 'frontier', showDone: false, showHelp: false, toast: '' };
  let tree = buildTree(db, state, width, height);
  const frame = new VideoBuffer(width, height + 1);
  const previous = new VideoBuffer(width, height + 1).cscr('\x80');

  const rebuild = (): void => {
    tree = buildTree(db, state, width, height);
  };

  const draw = (): void => {
    frame.cscr();
    clampTreeView(tree);
    tree.render(frame, true);
    const line = state.toast || statusLine(db, tree, state, width);
    frame.goxy(0, height).fg(-15).bg(-236).puts(line.slice(0, width).padEnd(width, ' '));
    if (state.showHelp) drawHelp(frame, width, height);
    write(renderDiff(previous, frame));
  };

  let stopped = false;
  const stdin = globalThis.process.stdin;

  const onKey = (text: string): void => {
    if (state.showHelp) {
      state.showHelp = false;
      draw();
      return;
    }
    if (text === '?') { state.showHelp = true; draw(); return; }
    switch (text) {
      case '':
      case ' ':
      case 'q':
        stop();
        globalThis.process.exit(0);
        break;
      case '[A':
      case 'p':
        tree.bak(); draw(); break;
      case '[B':
      case 'n':
        tree.fwd(); draw(); break;
      case '[5~':
        tree.k_pgup(); draw(); break;
      case '[6~':
        tree.k_pgdn(); draw(); break;
      case '[D':
      case 'u':
        if (tree.expanded[tree.cursor]) tree.toggle();
        else tree.upw();
        draw();
        break;
      case '[C':
      case '\t':
      case '\r':
      case '\n':
      case ' ':
        tree.toggle(); draw(); break;
      case 'm':
        state.mode = state.mode === 'frontier' ? 'leaves' : 'frontier';
        rebuild(); draw(); break;
      case 't':
        state.showDone = !state.showDone;
        rebuild(); draw(); break;
      case 'v':
        editCurrent('lean'); break;
      case 'V':
        editCurrent('tex'); break;
      case 'c':
        openChat(); break;
    }
  };

  const openChat = (): void => {
    const id = tree.items[tree.cursor];
    if (id == null) return;
    const node = db.get(id);
    const a = node?.a;
    if (!a) { flash('no assignee for this sorry'); return; }
    const colon = a.indexOf(':');
    const sid = colon >= 0 ? a.slice(colon + 1) : a;
    if (!sid) { flash(`unrecognized assignee: ${a}`); return; }
    const slug = sid.startsWith('session_') ? sid : `session_${sid}`;
    flash(`looking up ${slug} ...`);
    write(renderDiff(previous, frame));
    lookupSessionName(slug).then((name) => {
      if (!name) { flash(`no live session matches ${slug}`); draw(); return; }
      spawnClient(name);
    }).catch((err) => {
      flash(`lookup failed: ${(err as Error).message}`);
      draw();
    });
  };

  const flash = (msg: string): void => {
    state.toast = msg;
    draw();
    setTimeout(() => { state.toast = ''; draw(); }, 2500);
  };

  const spawnClient = (name: string): void => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.off('data', onData);
    write(cursor(true));
    spawnSync('npx', ['tsx', resolve(import.meta.dirname, 'client.mts')], {
      stdio: 'inherit',
      env: { ...globalThis.process.env, SCIALECT_USE: name },
    });
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    previous.cscr('\x80');
    write(CSCR + cursor(false));
    draw();
  };

  const editCurrent = (kind: 'lean' | 'tex'): void => {
    const id = tree.items[tree.cursor];
    if (id == null) return;
    const node = db.get(id);
    if (!node) return;
    let target: { path: string; line: number } | null = null;
    if (kind === 'lean') {
      const fullPath = resolve(repoRoot, node.f);
      const line = node.l ?? findLeanDeclLine(fullPath, node.k ?? '', node.s);
      target = { path: fullPath, line };
    } else {
      const label = node.b;
      const hit = label ? texMap.get(label) : undefined;
      if (!hit) return;
      target = hit;
    }
    const editor = globalThis.process.env.EDITOR || 'vim';
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.off('data', onData);
    write(cursor(true));
    spawnSync(editor, [`+${target.line}`, target.path], { stdio: 'inherit' });
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    previous.cscr('\x80');
    write(CSCR + cursor(false));
    draw();
  };

  const onData = (chunk: Buffer): void => onKey(chunk.toString('utf8'));

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stdin.off('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    write(cursor(true) + goxy(0, height + 1));
  }

  write(CSCR + cursor(false) + goxy(0, 0));
  draw();
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  }

  const shutdown = (): void => { stop(); globalThis.process.exit(0); };
  globalThis.process.on('SIGINT', shutdown);
  globalThis.process.on('SIGTERM', shutdown);
}

const configPath = resolve(globalThis.process.cwd(), 'config.json');
runBrowser(configPath);
