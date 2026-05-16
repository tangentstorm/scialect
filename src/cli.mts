#!/usr/bin/env node
import { launchBrowser, gotoClaudeCode } from './browser.mts';
import {
  listSessions,
  openSession,
  getLatestResponse,
  getSessionStatus,
} from './sessions.mts';

const [, , cmd = 'list', ...rest] = process.argv;

async function main() {
  const handle = await launchBrowser({ headed: true });
  try {
    await gotoClaudeCode(handle.page);

    switch (cmd) {
      case 'list': {
        const sessions = await listSessions(handle.page);
        if (sessions.length === 0) {
          console.log('(no sessions found in sidebar)');
        } else {
          for (const s of sessions) {
            const pin = s.pinned ? '📌' : '  ';
            console.log(`${pin} [${s.status.padEnd(8)}] ${s.name}`);
          }
        }
        break;
      }

      case 'status': {
        const name = rest.join(' ').trim();
        if (!name) throw new Error('usage: cli status "<session name>"');
        console.log(await getSessionStatus(handle.page, name));
        break;
      }

      case 'open': {
        const name = rest.join(' ').trim();
        if (!name) throw new Error('usage: cli open "<session name>"');
        await openSession(handle.page, name);
        const latest = await getLatestResponse(handle.page);
        console.log(latest ?? '(no assistant message yet)');
        break;
      }

      case 'wait': {
        // Keep the browser open until Ctrl-C — useful for first-run login.
        console.log('Browser open. Log in to claude.ai/code, then Ctrl-C to exit.');
        await new Promise(() => {});
        break;
      }

      default:
        console.error(`unknown command: ${cmd}`);
        console.error('commands: list | status <name> | open <name> | wait');
        process.exit(2);
    }
  } finally {
    if (cmd !== 'wait') await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
