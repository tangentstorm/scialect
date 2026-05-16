import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import {
  Hub,
  attachWebsocketUpgrade,
  startBrowser,
  type DispatchLoader,
} from './src/server.mts';
import type { BrowserHandle } from './src/browser.mts';
import type { dispatch as DispatchFn } from './src/handlers.mts';

/**
 * Long-lived state stashed on globalThis so Vite's plugin reloads (when you
 * edit vite.config.mts itself, for example) don't relaunch Chromium.
 */
interface ScialectGlobal {
  handle?: BrowserHandle;
  hub?: Hub;
  initPromise?: Promise<{ handle: BrowserHandle; hub: Hub }>;
}
const g = globalThis as typeof globalThis & { __scialect?: ScialectGlobal };
g.__scialect ??= {};
const slot = g.__scialect;

function scialectPlugin(): Plugin {
  return {
    name: 'scialect',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

      // Build a loader that always returns the current dispatch from Vite's
      // SSR module graph. Edits to handlers.mts / sessions.mts invalidate
      // the cached version automatically.
      const loadDispatch: DispatchLoader = async () => {
        const mod = (await server.ssrLoadModule('/src/handlers.mts')) as {
          dispatch: typeof DispatchFn;
        };
        return mod.dispatch;
      };

      const init = async () => {
        if (slot.hub) return { handle: slot.handle!, hub: slot.hub };
        const handle = await startBrowser();
        const hub = new Hub(handle, loadDispatch);
        slot.handle = handle;
        slot.hub = hub;
        return { handle, hub };
      };

      slot.initPromise ??= init();

      server.httpServer.once('listening', () => {
        slot.initPromise!
          .then(({ hub }) => {
            attachWebsocketUpgrade(server.httpServer!, hub, '/ws');
            const addr = server.httpServer!.address();
            const port = typeof addr === 'object' && addr ? addr.port : '?';
            console.log(`[scialect] ws://127.0.0.1:${port}/ws ready`);
          })
          .catch((err) => {
            slot.initPromise = undefined; // allow retry on next reload
            console.error('[scialect] browser startup failed:', err?.message ?? err);
          });
      });

      // Surface hot-reloads of the handler module so it's obvious when a
      // save took effect.
      server.watcher.on('change', (file) => {
        if (file.endsWith('handlers.mts') || file.endsWith('sessions.mts')) {
          console.log(`[scialect] reloaded ${file.split('/').pop()}`);
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 7878,
    strictPort: true,
  },
  plugins: [scialectPlugin()],
});
