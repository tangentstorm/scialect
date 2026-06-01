#!/usr/bin/env node
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { launchBrowser, gotoClaudeCode, type BrowserHandle } from './browser.mts';
import { openSession } from './sessions.mts';
import {
  DEFAULT_PORT,
  type ClientRequest,
  type ServerFrame,
  type WorkerState,
} from './protocol.mts';
import type { ClientState, DispatchDeps, dispatch as DispatchFn } from './handlers.mts';

const execp = promisify(exec);
export const SERVER_VERSION = '0.1.0';

let currentHub: Hub | null = null;

export function emitSwarmStatus(changes: Record<string, import('./protocol.mts').WorkerState>) {
  if (currentHub) {
    currentHub.emitSwarmStatus(changes);
  }
}

/**
 * Bring the Chromium window to the front on macOS. Playwright launches
 * bundled Chromium (process name "Chromium"); fall back to "Google Chrome"
 * if that fails so it works either way.
 */
export async function raiseBrowserToForeground(): Promise<void> {
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

interface InternalClient extends ClientState {
  ws: WebSocket;
}

/** Resolves the current dispatch function — swappable for HMR. */
export type DispatchLoader = () => Promise<typeof DispatchFn>;

export class Hub {
  private clients = new Set<InternalClient>();
  private browserWorkers = new Set<InternalClient>(); // connected browser worker clients
  private pageMutex: Promise<void> = Promise.resolve();
  private currentlyOpen: string | null = null;
  private handle: BrowserHandle | null;

  constructor(
    handle: BrowserHandle | null,
    private loadDispatch: DispatchLoader,
  ) {
    this.handle = handle;
    currentHub = this;
  }

  /** Browser handle, asserted non-null on the full browser-attach path. */
  private requireHandle(): BrowserHandle {
    if (!this.handle) throw new Error('Hub has no browser handle (browserless orchestrator mode)');
    return this.handle;
  }

  // Used by the thin orchestrator (5002) to register clients for swarm-status delivery
  // without going through the full browser attach path.
  registerClient(c: InternalClient): void {
    this.clients.add(c);
  }

  unregisterClient(c: InternalClient): void {
    this.clients.delete(c);
  }

  attach(ws: WebSocket): void {
    const c: InternalClient = { ws, activeChat: null, subscriptions: new Set() };
    this.clients.add(c);
    this.send(c, { kind: 'event', type: 'hello', serverVersion: SERVER_VERSION });
    ws.on('close', () => {
      this.clients.delete(c);
      this.browserWorkers.delete(c);
    });
    ws.on('message', async (data) => {
      let req: ClientRequest;
      try {
        req = JSON.parse(data.toString()) as ClientRequest;
      } catch (e) {
        this.send(c, { id: '?', kind: 'error', message: `bad json: ${(e as Error).message}` });
        return;
      }
      if (req.kind === 'register' && req.workerType === 'cloud-browser') {
        this.browserWorkers.add(c);
        console.log('[Hub] Registered new cloud-browser worker');
        this.send(c, { id: req.id, kind: 'ok' });
        return;
      }

      try {
        const dispatch = await this.loadDispatch();
        this.send(c, await dispatch(this.deps(), c, req));
      } catch (e) {
        this.send(c, { id: req.id, kind: 'error', message: (e as Error).message });
      }
    });
  }

  private deps(): DispatchDeps {
    return {
      page: this.requireHandle().page,
      withActiveChat: (chatId, fn) => this.withActiveChat(chatId, fn),
      broadcast: (frame) => this.broadcast(frame),
    };
  }

  private send(c: InternalClient, frame: ServerFrame): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(frame));
  }

  broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const c of this.clients) {
      if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
    }
  }

  private async withActiveChat<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.pageMutex;
    this.pageMutex = next;
    try {
      await prev;
      if (this.currentlyOpen !== chatId) {
        await openSession(this.requireHandle().page, chatId);
        this.currentlyOpen = chatId;
      }
      return await fn();
    } finally {
      release();
    }
  }

  /** Send a swarm-status update only to clients subscribed to "swarm". */
  emitSwarmStatus(changes: Record<string, WorkerState>): void {
    if (Object.keys(changes).length === 0) return;

    const frame: ServerFrame = {
      kind: 'event',
      type: 'swarm-status',
      changes,
    };
    const payload = JSON.stringify(frame);

    for (const c of this.clients) {
      if (c.subscriptions?.has('swarm') && c.ws.readyState === c.ws.OPEN) {
        c.ws.send(payload);
      }
    }
  }
}

/**
 * Launch the Playwright browser and navigate to claude.ai/code. Used by both
 * the standalone server and the Vite plugin.
 */
export async function startBrowser(): Promise<BrowserHandle> {
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
  return handle;
}

/**
 * Attach a noServer ws on the given http server, upgrading only requests
 * to `path` (default "/ws"). Used by the Vite plugin so /ws sits next to
 * Vite's own http endpoints on a single port.
 */
export function attachWebsocketUpgrade(
  httpServer: HttpServer,
  hub: Hub,
  path = '/ws',
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url ?? '';
    // url may have query string; match path prefix
    if (!url.split('?')[0]?.endsWith(path)) return;
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
  });
  return wss;
}

// ---------------- standalone entrypoint ----------------

async function main() {
  const port = Number(process.env['SCIALECT_PORT'] ?? DEFAULT_PORT);
  const handle = await startBrowser();
  // No HMR in standalone mode: load dispatch once.
  const { dispatch } = await import('./handlers.mts');
  const hub = new Hub(handle, async () => dispatch);
  // Match the Vite plugin's path so clients work against either server.
  const wss = new WebSocketServer({ port, path: '/ws' });
  console.log(`[scialect] ws://127.0.0.1:${port}/ws ready`);
  wss.on('connection', (ws) => hub.attach(ws));

  const shutdown = async () => {
    console.log('\n[scialect] shutting down…');
    wss.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only run main when invoked directly (not when imported by the Vite plugin).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('server.mts') ||
  process.argv[1]?.endsWith('server.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
