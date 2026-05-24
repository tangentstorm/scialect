/**
 * Hot-reloadable request dispatch. All websocket message handling lives here.
 * Edit this (or sessions.mts) and Vite will pick up changes without restarting
 * Playwright. Do NOT keep module-level state here — it gets wiped on reload.
 */
import type { Page } from 'playwright';
import {
  listSessions,
  openSession,
  sendMessage,
  getLatestResponse,
  getSessionStatus,
} from './sessions.mts';
import type {
  ChatRef,
  ClientRequest,
  ServerFrame,
  ServerReply,
} from './protocol.mts';

export interface ClientState {
  activeChat: string | null;
  subscriptions: Set<string>; // e.g. "swarm"
}

export interface DispatchDeps {
  page: Page;
  /** Run fn with the cloud UI showing chatId. Serialized by the caller. */
  withActiveChat: <T>(chatId: string, fn: () => Promise<T>) => Promise<T>;
  /** Broadcast an event to every connected client. */
  broadcast: (frame: ServerFrame) => void;
}

export async function dispatch(
  deps: DispatchDeps,
  c: ClientState,
  req: ClientRequest,
): Promise<ServerReply> {
  switch (req.kind) {
    case 'ping':
      return { id: req.id, kind: 'pong' };

    case 'list': {
      const sessions = await listSessions(deps.page);
      const chats: ChatRef[] = sessions.map((s) => ({
        id: s.name,
        label: s.name,
        transport: 'cloud',
        status: s.status,
        slug: s.slug,
      }));
      return { id: req.id, kind: 'list', chats, active: c.activeChat };
    }

    case 'use': {
      const sessions = await listSessions(deps.page);
      const match = sessions.find((s) => s.name === req.chatId);
      if (!match) return { id: req.id, kind: 'error', message: `no chat: ${req.chatId}` };
      c.activeChat = match.name;
      const ref: ChatRef = {
        id: match.name,
        label: match.name,
        transport: 'cloud',
        status: match.status,
        slug: match.slug,
      };
      return { id: req.id, kind: 'use', active: ref };
    }

    case 'status': {
      const id = req.chatId ?? c.activeChat;
      if (!id) return { id: req.id, kind: 'error', message: 'no active chat' };
      const status = await getSessionStatus(deps.page, id);
      return {
        id: req.id,
        kind: 'status',
        chat: { id, label: id, transport: 'cloud', status },
      };
    }

    case 'send': {
      if (!c.activeChat) return { id: req.id, kind: 'error', message: 'no active chat' };
      const chatId = c.activeChat;
      await deps.withActiveChat(chatId, () => sendMessage(deps.page, req.text));
      deps.broadcast({ kind: 'event', type: 'message', chatId, text: req.text });
      return { id: req.id, kind: 'ok' };
    }

    case 'latest': {
      if (!c.activeChat) return { id: req.id, kind: 'error', message: 'no active chat' };
      const chatId = c.activeChat;
      const text = await deps.withActiveChat(chatId, () => getLatestResponse(deps.page));
      return { id: req.id, kind: 'latest', text };
    }

    case 'subscribe': {
      if (!c.subscriptions) c.subscriptions = new Set();
      c.subscriptions.add(req.channel);
      return { id: req.id, kind: 'ok' };
    }
  }
}
