#!/usr/bin/env node
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PORT,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';

const url = process.env['SCIALECT_URL'] ?? `ws://127.0.0.1:${DEFAULT_PORT}/ws`;

const ws = new WebSocket(url);
const pending = new Map<string, (r: ServerReply) => void>();

ws.addEventListener('open', () => {
  console.log(`[scialect] connected to ${url}`);
  startRepl();
});

ws.addEventListener('close', () => {
  console.log('\n[scialect] disconnected');
  process.exit(0);
});

ws.addEventListener('error', (e) => {
  console.error('[scialect] ws error:', (e as ErrorEvent).message ?? e);
  process.exit(1);
});

ws.addEventListener('message', (ev) => {
  let frame: ServerFrame;
  try {
    frame = JSON.parse(String(ev.data)) as ServerFrame;
  } catch {
    process.stderr.write(`\n[bad frame] ${String(ev.data)}\n`);
    return;
  }
  if (frame.kind === 'event') {
    handleEvent(frame);
    return;
  }
  const cb = pending.get(frame.id);
  if (cb) {
    pending.delete(frame.id);
    cb(frame);
  }
});

function handleEvent(frame: Extract<ServerFrame, { kind: 'event' }>): void {
  switch (frame.type) {
    case 'hello':
      console.log(`[server v${frame.serverVersion}]`);
      break;
    case 'chat-update':
      process.stdout.write(`\n[update] ${frame.chat.id} → ${frame.chat.status ?? '?'}\n`);
      rl?.prompt(true);
      break;
    case 'message':
      // Don't echo our own outgoing message back to ourselves.
      // (Server broadcasts to everyone including the sender; OK for now.)
      break;
  }
}

type RequestBody = { [K in ClientRequest as K['kind']]: Omit<K, 'id'> }[ClientRequest['kind']];

function call<T extends ServerReply>(body: RequestBody): Promise<T> {
  const id = randomUUID();
  const full = { ...body, id } as ClientRequest;
  return new Promise<T>((resolve) => {
    pending.set(id, (r) => resolve(r as T));
    ws.send(JSON.stringify(full));
  });
}

let rl: readline.Interface | undefined;
let activeLabel = '(no chat)';

function setPrompt(): void {
  rl?.setPrompt(`${activeLabel} > `);
  rl?.prompt(true);
}

function startRepl(): void {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('commands: /list  /use <name>  /status [name]  /latest  /help  /quit');
  setPrompt();

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) return setPrompt();

    try {
      if (!line.startsWith('/')) {
        const r = await call<ServerReply>({ kind: 'send', text: line });
        if (r.kind === 'error') console.log(`[err] ${r.message}`);
        return setPrompt();
      }

      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');

      switch (cmd) {
        case 'list': {
          const r = await call<ServerReply>({ kind: 'list' });
          if (r.kind !== 'list') {
            console.log(`[err] ${stringify(r)}`);
            break;
          }
          if (r.chats.length === 0) console.log('(no chats)');
          for (const c of r.chats) {
            const mark = c.id === r.active ? '*' : ' ';
            console.log(`${mark} [${c.transport}/${c.status ?? '?'}] ${c.label}`);
          }
          break;
        }
        case 'use': {
          if (!arg) {
            console.log('usage: /use <chat name>');
            break;
          }
          const r = await call<ServerReply>({ kind: 'use', chatId: arg });
          if (r.kind !== 'use') {
            console.log(`[err] ${stringify(r)}`);
            break;
          }
          activeLabel = r.active.label;
          console.log(`-> ${r.active.label}`);
          break;
        }
        case 'status': {
          const r = await call<ServerReply>(
            arg ? { kind: 'status', chatId: arg } : { kind: 'status' },
          );
          if (r.kind !== 'status') {
            console.log(`[err] ${stringify(r)}`);
            break;
          }
          console.log(`${r.chat.id}: ${r.chat.status ?? '?'}`);
          break;
        }
        case 'latest': {
          const r = await call<ServerReply>({ kind: 'latest' });
          if (r.kind !== 'latest') {
            console.log(`[err] ${stringify(r)}`);
            break;
          }
          console.log(r.text ?? '(no message yet)');
          break;
        }
        case 'help':
          console.log('  /list                 list every chat');
          console.log('  /use <name>           switch active chat');
          console.log('  /status [name]        active chat status (or named)');
          console.log('  /latest               latest assistant reply in active chat');
          console.log('  /quit                 disconnect');
          console.log('  <anything else>       send as a message to active chat');
          break;
        case 'quit':
        case 'exit':
          ws.close();
          return;
        default:
          console.log(`unknown command: /${cmd}`);
      }
    } catch (e) {
      console.error('[err]', (e as Error).message);
    }
    setPrompt();
  });

  rl.on('close', () => ws.close());
}

function stringify(r: ServerReply): string {
  return r.kind === 'error' ? r.message : JSON.stringify(r);
}
