#!/usr/bin/env node
/**
 * MCP (stdio) server that exposes scialect's cloud sessions as tools.
 *
 * Sits in front of the existing scialect ws server (default
 * ws://127.0.0.1:5002/ws). Each tool call translates to one or more ws
 * round-trips. The user must have `npm run server` (or `npm run dev`)
 * running separately.
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DEFAULT_PORT,
  type ChatRef,
  type ClientRequest,
  type ServerFrame,
  type ServerReply,
} from './protocol.mts';

// --------- ws client ----------

const WS_URL = globalThis.process.env['SCIALECT_URL']
  ?? `ws://127.0.0.1:${DEFAULT_PORT}/ws`;

let ws: WebSocket | null = null;
let openPromise: Promise<void> | null = null;
const pending = new Map<string, (r: ServerReply) => void>();

function connect(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  if (openPromise) return openPromise;
  ws = new WebSocket(WS_URL);
  ws.addEventListener('message', (ev) => {
    let frame: ServerFrame;
    try { frame = JSON.parse(String(ev.data)) as ServerFrame; } catch { return; }
    if (frame.kind === 'event') return;
    const cb = pending.get(frame.id);
    if (cb) { pending.delete(frame.id); cb(frame); }
  });
  ws.addEventListener('close', () => {
    ws = null;
    openPromise = null;
    for (const cb of pending.values()) {
      cb({ id: '?', kind: 'error', message: 'ws closed' });
    }
    pending.clear();
  });
  openPromise = new Promise<void>((res, rej) => {
    ws!.addEventListener('open', () => res(), { once: true });
    ws!.addEventListener('error', () => rej(new Error(`ws connect failed: ${WS_URL}`)), { once: true });
  });
  return openPromise;
}

type ClientRequestBody = { [K in ClientRequest as K['kind']]: Omit<K, 'id'> }[ClientRequest['kind']];

function call<T extends ServerReply>(
  body: ClientRequestBody,
  timeoutMs = 60_000,
): Promise<T> {
  return connect().then(() => new Promise<T>((res, rej) => {
    const id = randomUUID();
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`ws timeout after ${timeoutMs}ms for ${body.kind}`));
    }, timeoutMs);
    pending.set(id, (r) => { clearTimeout(t); res(r as T); });
    ws!.send(JSON.stringify({ ...body, id } as ClientRequest));
  }));
}

function expectKind<K extends ServerReply['kind']>(
  r: ServerReply,
  kind: K,
): Extract<ServerReply, { kind: K }> {
  if (r.kind === kind) return r as Extract<ServerReply, { kind: K }>;
  if (r.kind === 'error') throw new Error(`scialect error: ${r.message}`);
  throw new Error(`unexpected reply kind: ${r.kind}`);
}

// --------- helpers ----------

function summarizeChat(c: ChatRef): string {
  const status = c.status ? ` [${c.status}]` : '';
  const slug = c.slug ? ` (${c.slug})` : '';
  return `${c.id}${status}${slug}`;
}

function asTextResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}

const TRANSIENT_STATUSES = new Set<string>(['running', 'awaiting', 'unknown']);

async function pollUntilSettled(
  sessionId: string,
  baselineText: string | null,
  timeoutMs: number,
  pollMs: number,
): Promise<{ status: string; text: string | null; settled: boolean; elapsedMs: number }> {
  const started = Date.now();
  while (true) {
    const status = expectKind(
      await call<ServerReply>({ kind: 'status', chatId: sessionId }),
      'status',
    ).chat.status ?? 'unknown';
    // Read latest only when status looks settled to avoid grabbing
    // partial messages mid-stream.
    if (!TRANSIENT_STATUSES.has(status)) {
      const r = expectKind(
        await call<ServerReply>({ kind: 'latest' }),
        'latest',
      );
      const text = r.text;
      const changed = text !== null && text !== baselineText;
      if (changed) {
        return { status, text, settled: true, elapsedMs: Date.now() - started };
      }
    }
    if (Date.now() - started > timeoutMs) {
      const r = expectKind(
        await call<ServerReply>({ kind: 'latest' }),
        'latest',
      );
      return { status, text: r.text, settled: false, elapsedMs: Date.now() - started };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

// --------- MCP server ----------

const server = new McpServer({
  name: 'scialect',
  version: '0.1.0',
});

server.registerTool(
  'list_sessions',
  {
    title: 'List cloud sessions',
    description:
      'Enumerate every Claude Code cloud session visible in the sidebar. ' +
      'Returns each session\'s id (the visible name, used as the handle for ' +
      'other tools), status, and URL slug.',
    inputSchema: {},
  },
  async () => {
    const r = expectKind(await call<ServerReply>({ kind: 'list' }), 'list');
    const lines = [
      `${r.chats.length} cloud session(s)${r.active ? `, active: ${r.active}` : ''}`,
      '',
      ...r.chats.map((c) => `- ${summarizeChat(c)}`),
    ];
    return asTextResult(lines.join('\n'));
  },
);

server.registerTool(
  'send_message',
  {
    title: 'Send a prompt to a cloud session',
    description:
      'Switch the active chat to `sessionId` and send `text` to it. The ' +
      '`sessionId` is the visible name returned by list_sessions ' +
      '(e.g. "1469. Prove skeletal homology quotient identity"). Returns ' +
      'immediately once the message is submitted; use wait_for_response to ' +
      'block until the assistant replies.',
    inputSchema: {
      sessionId: z.string().describe('Session handle (the `id` from list_sessions).'),
      text: z.string().describe('Message body to send.'),
    },
  },
  async ({ sessionId, text }) => {
    expectKind(await call<ServerReply>({ kind: 'use', chatId: sessionId }), 'use');
    expectKind(await call<ServerReply>({ kind: 'send', text }), 'ok');
    return asTextResult(`sent to ${sessionId}`);
  },
);

server.registerTool(
  'get_latest_response',
  {
    title: 'Read the latest transcript message',
    description:
      'Switch to `sessionId` and return the text of the most recent message ' +
      'in its transcript. NOTE: this returns the last message regardless of ' +
      'author, so it may echo your own outgoing message if called immediately ' +
      'after send_message. Use wait_for_response if you want to block until ' +
      'the assistant has actually replied.',
    inputSchema: {
      sessionId: z.string().describe('Session handle (the `id` from list_sessions).'),
    },
  },
  async ({ sessionId }) => {
    expectKind(await call<ServerReply>({ kind: 'use', chatId: sessionId }), 'use');
    const r = expectKind(await call<ServerReply>({ kind: 'latest' }), 'latest');
    return asTextResult(r.text ?? '(no message in transcript)');
  },
);

server.registerTool(
  'wait_for_response',
  {
    title: 'Send a message and wait for the assistant reply',
    description:
      'Switch to `sessionId`, optionally send `text` (omit to just wait for ' +
      'an existing pending turn), then poll the session\'s status until it ' +
      'leaves running/awaiting AND the transcript\'s last message differs ' +
      'from the baseline captured before sending. Returns the new message ' +
      'text. If the timeout elapses first, returns whatever latest reads ' +
      'with a note that the wait did not complete.',
    inputSchema: {
      sessionId: z.string().describe('Session handle (the `id` from list_sessions).'),
      text: z.string().optional().describe('Message to send before waiting. Omit to wait on an existing turn.'),
      timeoutSec: z.number().int().positive().max(600).default(120)
        .describe('Hard timeout in seconds. Default 120, max 600.'),
      pollMs: z.number().int().min(250).max(10_000).default(1500)
        .describe('Polling interval in milliseconds.'),
    },
  },
  async ({ sessionId, text, timeoutSec, pollMs }) => {
    expectKind(await call<ServerReply>({ kind: 'use', chatId: sessionId }), 'use');
    const baseline = expectKind(
      await call<ServerReply>({ kind: 'latest' }),
      'latest',
    ).text;
    if (text != null) {
      expectKind(await call<ServerReply>({ kind: 'send', text }), 'ok');
    }
    const result = await pollUntilSettled(sessionId, baseline, timeoutSec * 1000, pollMs);
    if (result.settled) {
      return asTextResult(
        `[settled in ${result.elapsedMs}ms, status=${result.status}]\n\n${result.text ?? ''}`,
      );
    }
    return asTextResult(
      `[timeout after ${result.elapsedMs}ms, status=${result.status}, response may be incomplete]\n\n${result.text ?? '(no transcript)'}`,
    );
  },
);

// --------- main ----------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // McpServer.connect resolves once the transport is wired; the server then
  // runs until the parent closes stdin.
}

main().catch((err) => {
  globalThis.process.stderr.write(`[scialect-mcp] fatal: ${(err as Error).message}\n`);
  globalThis.process.exit(1);
});
