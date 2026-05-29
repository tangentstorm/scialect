/**
 * Wire protocol between scialect server and client(s).
 *
 * Every frame is a single JSON object on its own ws message. Each request
 * carries an `id`; the matching reply echoes it. Server-pushed events have
 * no `id` and use `kind: "event"`.
 *
 * A "chat" is a backend conversation — currently either a Claude Code cloud
 * session (transport: "cloud") or a local tmux pane (transport: "tmux",
 * planned). Each connected client has its own active-chat selection;
 * switching only affects that client.
 */

export type Transport = 'cloud' | 'tmux';

export interface ChatRef {
  /** Stable id used by the protocol — for cloud chats this is the session name. */
  id: string;
  /** Human-readable label shown in the REPL. */
  label: string;
  transport: Transport;
  /** Last known status string; format depends on transport. */
  status?: string;
  /** URL slug for cloud chats (the path segment after /code/); undefined for tmux. */
  slug?: string;
}

// ---------------- client → server ----------------

export type ClientRequest =
  | { id: string; kind: 'list' }
  | { id: string; kind: 'use'; chatId: string }
  | { id: string; kind: 'send'; text: string }
  | { id: string; kind: 'status'; chatId?: string }
  | { id: string; kind: 'latest' }
  | { id: string; kind: 'ping' }
  | { id: string; kind: 'subscribe'; channel: string }
  | { id: string; kind: 'swarm-status' }
  | { id: string; kind: 'register'; workerType: 'cloud-browser' };

// ---------------- server → client ----------------

export type ServerReply =
  | { id: string; kind: 'ok' }
  | { id: string; kind: 'list'; chats: ChatRef[]; active: string | null }
  | { id: string; kind: 'use'; active: ChatRef }
  | { id: string; kind: 'status'; chat: ChatRef }
  | { id: string; kind: 'latest'; text: string | null }
  | { id: string; kind: 'pong' }
  | { id: string; kind: 'swarm-status'; changes: Record<string, WorkerState> }
  | { id: string; kind: 'error'; message: string };

export type ServerEvent =
  | { kind: 'event'; type: 'hello'; serverVersion: string }
  | { kind: 'event'; type: 'chat-update'; chat: ChatRef }
  | { kind: 'event'; type: 'message'; chatId: string; text: string }
  | { kind: 'event'; type: 'swarm-status'; changes: Record<string, WorkerState> };

export interface WorkerState {
  agent: string;
  state: string;
  status: string;
}

export type ServerFrame = ServerReply | ServerEvent;

export const DEFAULT_PORT = 5002;
