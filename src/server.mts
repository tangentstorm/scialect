#!/usr/bin/env node
import { WebSocketServer, type WebSocket } from 'ws';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { launchBrowser, gotoClaudeCode, type BrowserHandle } from './browser.mts';
import {
  listSessions,
  openSession,
  sendMessage,
  getLatestResponse,
  getSessionStatus,
} from './sessions.mts';
import {
  DEFAULT_PORT,
  type ChatRef,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';

const execp = promisify(exec);
const SERVER_VERSION = '0.1.0';

/**
 * Bring the Chromium window to the front on macOS. Playwright launches
 * bundled Chromium (process name "Chromium"); fall back to "Google Chrome"
 * if that fails so it works either way.
 */
async function raiseBrowserToForeground(): Promise<void> {
  if (process.platform !== 'darwin') return;
  for (const app of ['Chromium', 'Google Chrome']) {
    try {
      await execp(`osascript -e 'tell application "${app}" to activate'`);
      return;
    } catch {
      /* try next */
    }
  }
}

interface ClientState {
  ws: WebSocket;
  activeChat: string | null;
}

class Hub {
  private clients = new Set<ClientState>();
  // Single shared playwright handle; per-client active chat lives in ClientState.
  // The page can only show one session at a time, so `send` and `latest`
  // serialize through `withActiveChat`.
  private pageMutex: Promise<void> = Promise.resolve();
  private currentlyOpen: string | null = null;

  constructor(private handle: BrowserHandle) {}

  attach(ws: WebSocket): ClientState {
    const c: ClientState = { ws, activeChat: null };
    this.clients.add(c);
    this.send(c, { kind: 'event', type: 'hello', serverVersion: SERVER_VERSION });
    ws.on('close', () => this.clients.delete(c));
    return c;
  }

  send(c: ClientState, frame: ServerFrame): void {
    if (c.ws.readyState === c.ws.OPEN) {
      c.ws.send(JSON.stringify(frame));
    }
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const c of this.clients) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
  }

  /** Run `fn` with the cloud UI showing `chatId`. Serialized across clients. */
  private async withActiveChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.pageMutex;
    this.pageMutex = next;
    try {
      await prev;
      if (this.currentlyOpen !== chatId) {
        await openSession(this.handle.page, chatId);
        this.currentlyOpen = chatId;
      }
      return await fn();
    } finally {
      release();
    }
  }

  async dispatch(c: ClientState, req: ClientRequest): Promise<ServerReply> {
    switch (req.kind) {
      case 'ping':
        return { id: req.id, kind: 'pong' };

      case 'list': {
        const sessions = await listSessions(this.handle.page);
        const chats: ChatRef[] = sessions.map((s) => ({
          id: s.name,
          label: s.name,
          transport: 'cloud',
          status: s.status,
        }));
        return { id: req.id, kind: 'list', chats, active: c.activeChat };
      }

      case 'use': {
        const sessions = await listSessions(this.handle.page);
        const match = sessions.find((s) => s.name === req.chatId);
        if (!match) return { id: req.id, kind: 'error', message: `no chat: ${req.chatId}` };
        c.activeChat = match.name;
        const ref: ChatRef = {
          id: match.name,
          label: match.name,
          transport: 'cloud',
          status: match.status,
        };
        return { id: req.id, kind: 'use', active: ref };
      }

      case 'status': {
        const id = req.chatId ?? c.activeChat;
        if (!id) return { id: req.id, kind: 'error', message: 'no active chat' };
        const status = await getSessionStatus(this.handle.page, id);
        return {
          id: req.id,
          kind: 'status',
          chat: { id, label: id, transport: 'cloud', status },
        };
      }

      case 'send': {
        if (!c.activeChat) return { id: req.id, kind: 'error', message: 'no active chat' };
        const chatId = c.activeChat;
        await this.withActiveChat(chatId, () => sendMessage(this.handle.page, req.text));
        this.broadcast({ kind: 'event', type: 'message', chatId, text: req.text });
        return { id: req.id, kind: 'ok' };
      }

      case 'latest': {
        if (!c.activeChat) return { id: req.id, kind: 'error', message: 'no active chat' };
        const chatId = c.activeChat;
        const text = await this.withActiveChat(chatId, () => getLatestResponse(this.handle.page));
        return { id: req.id, kind: 'latest', text };
      }
    }
  }
}

async function main() {
  const port = Number(process.env['SCIALECT_PORT'] ?? DEFAULT_PORT);

  console.log('[scialect] launching browser…');
  const handle = await launchBrowser({ headed: true });
  await raiseBrowserToForeground();
  try {
    await gotoClaudeCode(handle.page);
    console.log('[scialect] claude.ai/code loaded.');
  } catch (err) {
    console.error('[scialect] not logged in. The browser is open — sign in, then restart.');
    console.error(String(err));
  }

  const hub = new Hub(handle);
  const wss = new WebSocketServer({ port });
  console.log(`[scialect] ws://127.0.0.1:${port} ready`);

  wss.on('connection', (ws) => {
    const c = hub.attach(ws);
    ws.on('message', async (data) => {
      let req: ClientRequest;
      try {
        req = JSON.parse(data.toString()) as ClientRequest;
      } catch (e) {
        hub.send(c, { id: '?', kind: 'error', message: `bad json: ${(e as Error).message}` });
        return;
      }
      try {
        hub.send(c, await hub.dispatch(c, req));
      } catch (e) {
        hub.send(c, { id: req.id, kind: 'error', message: (e as Error).message });
      }
    });
  });

  const shutdown = async () => {
    console.log('\n[scialect] shutting down…');
    wss.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
