import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { Hub } from './src/server.mts';
import { CloudRelay } from './src/cloud-relay.mts';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { ClientRequest } from './src/protocol.mts';
import { getCurrentSwarmState } from './src/swarm.mts';

interface ScialectGlobal {
  hub?: Hub;
}

const g = globalThis as typeof globalThis & { __scialect?: ScialectGlobal };
g.__scialect ??= {};
const slot = g.__scialect;

interface ThinClient {
  ws: any;
  activeChat: string | null;
  subscriptions: Set<string>;
}

function scialectPlugin(): Plugin {
  return {
    name: 'scialect',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

      const cloudRelay = new CloudRelay('ws://127.0.0.1:5003/ws');

      const init = async () => {
        if (slot.hub) return slot.hub;
        const hub = new Hub(null as any, async () => {
          const mod = await import('./src/handlers.mts');
          return mod.dispatch;
        });
        slot.hub = hub;
        return hub;
      };

      slot.initPromise ??= init();

      server.httpServer.once('listening', () => {
        slot.initPromise!
          .then((hub) => {
            const wss = new WebSocketServer({ noServer: true });

            server.httpServer!.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
              const url = req.url ?? '';
              if (!url.split('?')[0]?.endsWith('/ws')) return;

              wss.handleUpgrade(req, socket, head, (ws) => {
                const c: ThinClient = {
                  ws,
                  activeChat: null,
                  subscriptions: new Set(),
                };

                hub.registerClient(c as any);

                ws.send(JSON.stringify({ kind: 'event', type: 'hello', serverVersion: '0.1.0' }));

                ws.on('message', async (data: Buffer) => {
                  let req: ClientRequest;
                  try {
                    req = JSON.parse(data.toString()) as ClientRequest;
                  } catch (e) {
                    ws.send(JSON.stringify({ id: '?', kind: 'error', message: 'bad json' }));
                    return;
                  }

                  if (req.kind === 'subscribe' && req.channel === 'swarm') {
                    c.subscriptions.add('swarm');
                    ws.send(JSON.stringify({ id: req.id, kind: 'ok' }));

                    // Send full current state as initial snapshot (not just deltas)
                    try {
                      const fullState = getCurrentSwarmState();
                      if (Object.keys(fullState).length > 0) {
                        ws.send(JSON.stringify({
                          kind: 'event',
                          type: 'swarm-status',
                          changes: fullState,
                        }));
                      }
                    } catch (err) {
                      console.error('[swarm] failed to send initial snapshot on subscribe:', err);
                    }

                    return;
                  }

                  const reply = await cloudRelay.forward(req);
                  if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(reply));
                  }
                });

                ws.on('close', () => {
                  hub.unregisterClient(c as any);
                });
              });
            });

            const addr = server.httpServer!.address();
            const port = typeof addr === 'object' && addr ? addr.port : '?';
            console.log(`[scialect] ws://127.0.0.1:${port}/ws ready (thin, relaying cloud to 5003)`);

            // Real swarm polling — starts immediately, every 2s.
            // Also prints live table to stdout for tmux watching.
            import('./src/swarm.mts').then(async ({ pollSwarmOnce }) => {
              await pollSwarmOnce().catch(console.error);
              setInterval(() => {
                pollSwarmOnce().catch(console.error);
              }, 2000);
            });
          })
          .catch((err) => {
            slot.initPromise = undefined;
            console.error('[scialect] init failed:', err?.message ?? err);
          });
      });
    },
  };
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5002,
    strictPort: true,
  },
  plugins: [scialectPlugin()],
});
