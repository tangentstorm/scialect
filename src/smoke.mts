/**
 * Local smoke test: spin up a WebSocketServer that speaks the protocol
 * with a fake chat list, connect a ws client, exercise list/use/ping,
 * and exit non-zero on any mismatch. No playwright, no network.
 */
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  type ChatRef,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';

const fakeChats: ChatRef[] = [
  { id: '1469. Prove X', label: '1469. Prove X', transport: 'cloud', status: 'running' },
  { id: '1500. Prove Y', label: '1500. Prove Y', transport: 'cloud', status: 'awaiting' },
];

const wss = new WebSocketServer({ port: 0 });
const port = (wss.address() as { port: number }).port;

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ kind: 'event', type: 'hello', serverVersion: 'test' } satisfies ServerFrame));
  let active: string | null = null;
  ws.on('message', (raw) => {
    const req = JSON.parse(raw.toString()) as ClientRequest;
    let reply: ServerReply;
    switch (req.kind) {
      case 'ping':
        reply = { id: req.id, kind: 'pong' };
        break;
      case 'list':
        reply = { id: req.id, kind: 'list', chats: fakeChats, active };
        break;
      case 'use': {
        const m = fakeChats.find((c) => c.id === req.chatId);
        reply = m
          ? ((active = m.id), { id: req.id, kind: 'use', active: m })
          : { id: req.id, kind: 'error', message: 'no such chat' };
        break;
      }
      default:
        reply = { id: req.id, kind: 'error', message: 'unsupported in smoke' };
    }
    ws.send(JSON.stringify(reply));
  });
});

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const pending = new Map<string, (r: ServerReply) => void>();
let helloSeen = false;

ws.addEventListener('message', (ev) => {
  const f = JSON.parse(String(ev.data)) as ServerFrame;
  if (f.kind === 'event') {
    if (f.type === 'hello') helloSeen = true;
    return;
  }
  pending.get(f.id)?.(f);
  pending.delete(f.id);
});

type RequestBody = { [K in ClientRequest as K['kind']]: Omit<K, 'id'> }[ClientRequest['kind']];

function call(body: RequestBody): Promise<ServerReply> {
  const id = randomUUID();
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ ...body, id }));
  });
}

await new Promise<void>((res) => ws.addEventListener('open', () => res(), { once: true }));

const pong = await call({ kind: 'ping' });
const list = await call({ kind: 'list' });
const use = await call({ kind: 'use', chatId: '1500. Prove Y' });
const useBad = await call({ kind: 'use', chatId: 'nope' });

const checks = [
  ['hello event seen', helloSeen],
  ['ping → pong', pong.kind === 'pong'],
  ['list returned 2 chats', list.kind === 'list' && list.chats.length === 2],
  ['use ok', use.kind === 'use' && use.active.id === '1500. Prove Y'],
  ['use missing → error', useBad.kind === 'error'],
] as const;

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

ws.close();
wss.close();
process.exit(failed ? 1 : 0);
