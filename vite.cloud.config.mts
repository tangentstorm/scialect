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
 * Cloud server (the original Playwright + browser automation server).
 * Run with: npm run cloud
 */
interface ScialectGlobal {
  handle?: BrowserHandle;
  hub?: Hub;
  initPromise?: Promise<{ handle: BrowserHandle; hub: Hub }>;
}

const g = globalThis as typeof globalThis & { __scialectCloud?: ScialectGlobal };
g.__scialectCloud ??= {};
const slot = g.__scialectCloud;

function cloudPlugin(): Plugin {
  return {
    name: 'scialect-cloud',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (!server.httpServer) return;

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
            console.log(`[scialect-cloud] ws://127.0.0.1:${port}/ws ready`);
          })
          .catch((err) => {
            slot.initPromise = undefined;
            console.error('[scialect-cloud] browser startup failed:', err?.message ?? err);
          });
      });

      server.watcher.on('change', (file) => {
        if (file.endsWith('handlers.mts') || file.endsWith('sessions.mts')) {
          console.log(`[scialect-cloud] reloaded ${file.split('/').pop()}`);
        }
      });
    },
  };
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5003,
    strictPort: true,
  },
  plugins: [cloudPlugin()],
});
