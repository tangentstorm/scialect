#!/usr/bin/env node
/**
 * REPL for Claude Code cloud sessions, via tangentswarm's cloud_* MCP tools.
 *
 * Needs `swarm cloud serve` (tangentswarm's browser + websocket hub) running
 * wherever the configured swarm-mcp runs. SCIALECT_USE=<session name> preselects
 * a chat (browse-sorries uses this).
 */
import * as readline from 'node:readline';
import { SwarmClient, type ChatRef } from './tangentswarm.mts';

export const HELP = [
  '  /list                 list every chat (* = active)',
  '  /use <name>           switch active chat',
  '  /status [name]        status of the active chat (or a named one)',
  '  /latest               latest message in the active chat',
  '  /wait [seconds]       wait for the active chat to settle, then print the reply',
  '  /quit                 disconnect',
  '  <anything else>       send as a message to the active chat',
].join('\n');

/** Find a chat by exact id, else by unique prefix. */
export function findChat(chats: ChatRef[], name: string): ChatRef | undefined {
  return chats.find(c => c.id === name) ?? (() => {
    const hits = chats.filter(c => c.id.startsWith(name));
    return hits.length === 1 ? hits[0] : undefined;
  })();
}

async function main(): Promise<void> {
  const swarm = await SwarmClient.connect();
  console.log(`[scialect] connected to tangentswarm (${swarm.config.command.join(' ')})`);
  let active: string | null = null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => { rl.setPrompt(`${active ?? '(no chat)'} > `); rl.prompt(true); };

  const use = async (name: string) => {
    const { sessions } = await swarm.cloudListSessions();
    const hit = findChat(sessions, name);
    if (!hit) { console.log(`[err] no chat named ${JSON.stringify(name)}`); return; }
    active = hit.id;
    console.log(`-> ${hit.label}`);
  };

  console.log('commands: /list  /use <name>  /status [name]  /latest  /wait  /help  /quit');
  const initial = process.env['SCIALECT_USE'];
  if (initial) await use(initial).catch(e => console.log(`[err] ${(e as Error).message}`));
  prompt();

  let closing = false;
  const quit = async () => {
    if (closing) return;
    closing = true;
    rl.close();
    await swarm.close();
    console.log('\n[scialect] disconnected');
    process.exit(0);
  };

  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (!line) return prompt();
    try {
      if (!line.startsWith('/')) {
        if (!active) console.log('[err] no active chat; /use <name> first');
        else { await swarm.cloudSendMessage(active, line); console.log('(sent; /wait for the reply)'); }
        return prompt();
      }
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      switch (cmd) {
        case 'list': {
          const { sessions } = await swarm.cloudListSessions();
          if (sessions.length === 0) console.log('(no chats)');
          for (const c of sessions) console.log(`${c.id === active ? '*' : ' '} [${c.transport}/${c.status ?? '?'}] ${c.label}`);
          break;
        }
        case 'use':
          if (!arg) console.log('usage: /use <chat name>'); else await use(arg);
          break;
        case 'status': {
          const name = arg || active;
          if (!name) { console.log('[err] no active chat'); break; }
          const hit = findChat((await swarm.cloudListSessions()).sessions, name);
          console.log(hit ? `${hit.id}: ${hit.status ?? '?'}` : `[err] no chat named ${JSON.stringify(name)}`);
          break;
        }
        case 'latest':
          if (!active) console.log('[err] no active chat');
          else console.log((await swarm.cloudGetLatestResponse(active)) ?? '(no message yet)');
          break;
        case 'wait': {
          if (!active) { console.log('[err] no active chat'); break; }
          const r = await swarm.cloudWaitForResponse(active, undefined, Number(arg) || 120);
          console.log(`[${r.status}${r.settled ? '' : ', timed out'}] ${r.text ?? '(no message yet)'}`);
          break;
        }
        case 'help':
          console.log(HELP);
          break;
        case 'quit':
        case 'exit':
          return quit();
        default:
          console.log(`unknown command: /${cmd}`);
      }
    } catch (e) {
      console.error('[err]', (e as Error).message);
    }
    prompt();
  });
  rl.on('close', () => { void quit(); });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error((err as Error).message ?? err);
    process.exit(1);
  });
}
