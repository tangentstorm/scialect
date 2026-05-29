# scialect websocket protocol (agent reference)

This document is the on-disk reference for any AI agent running on this
machine that needs to drive scialect's websocket server. It is a protocol
manual, not a tutorial.

The canonical schema lives in `src/protocol.mts`. If anything here disagrees
with that file, the file wins.

## 1. Connection

- Default endpoint: `ws://127.0.0.1:5002/ws`.
- Override with `SCIALECT_URL=ws://host:port/path`.
- The same endpoint is exposed by both the standalone server (`npm run server`)
  and the Vite dev plugin (`npm run dev`); the latter hot-reloads
  `src/handlers.mts` and `src/sessions.mts` but not the protocol surface.
- The server may need ~5–15 seconds to finish bringing up Playwright on first
  connect. The open handshake itself completes quickly; the first request
  may block until the headed Chromium has loaded `claude.ai/code`. Set
  request timeouts to at least 30 seconds.
- Only `127.0.0.1` is bound by default. There is no authentication. Treat
  the endpoint as local-only.
- Multiple clients may connect simultaneously. Each client's selected
  "active chat" is independent; broadcast events go to all clients.

## 2. Framing

Every websocket message is a single JSON object on its own frame. There is
no binary mode, no batching, no streaming.

Three frame families:

| family       | shape                                            | direction       |
| ------------ | ------------------------------------------------ | --------------- |
| request      | `{ "id": "<uuid>", "kind": "...", ... }`         | client → server |
| reply        | `{ "id": "<same uuid>", "kind": "...", ... }`    | server → client |
| event        | `{ "kind": "event", "type": "...", ... }`        | server → client |

Rules:

- The client picks `id` (any unique string; UUIDs are conventional). The
  server echoes the same `id` in the matching reply.
- One reply per request. The reply's `kind` is either the action's success
  kind (e.g. `list`, `use`, `latest`) or `error`.
- Events have no `id` and always carry `kind: "event"`. They are broadcast,
  not solicited.
- Malformed JSON triggers an error reply with `id: "?"` and a message
  describing the parse failure. Do not rely on `?` matching any of your
  pending requests.

## 3. Shared types

### `Transport`

```ts
type Transport = "cloud" | "tmux";
```

Only `"cloud"` is currently implemented; `"tmux"` is reserved.

### `ChatRef`

```ts
interface ChatRef {
  id: string;        // protocol-level handle. For cloud chats this is the
                     // visible session name (sidebar label).
  label: string;     // human-readable; equal to `id` for cloud chats today.
  transport: Transport;
  status?: string;   // last known status. For cloud, see SessionStatus below.
  slug?: string;     // URL slug (path segment after /code/); cloud only.
}
```

Use `id` as the canonical handle when sending requests like `use` or
`status`. `slug` is informational (build a chat URL with
`https://claude.ai/code/${slug}`).

### `SessionStatus` (cloud only; appears as `ChatRef.status`)

| value     | meaning |
| --------- | ------- |
| `running` | worker is actively producing tokens |
| `awaiting`| worker stopped, needs user input |
| `ready`   | worker finished, has unread output (blue dot in UI) |
| `ci`      | PR open, CI mid-flight |
| `ci-pass` | PR CI green |
| `ci-fail` | PR CI red |
| `idle`    | no active turn (merged/closed PRs, or just dormant) |
| `unknown` | could not classify; selector may have drifted |

## 4. Requests

All requests carry `id: string`. The `kind` field is required and selects
the variant.

### 4.1 `ping`

```json
{ "id": "<uuid>", "kind": "ping" }
```

Reply: `pong`. Cheap liveness check; does not touch the Playwright page.

### 4.2 `list`

```json
{ "id": "<uuid>", "kind": "list" }
```

Enumerates every visible session in the sidebar. May take a few seconds on
first call (waits for the chat input to mount).

Reply: `list` with `chats: ChatRef[]` and `active: string | null`. `active`
is the `id` of *this client's* currently selected chat, or null.

### 4.3 `use`

```json
{ "id": "<uuid>", "kind": "use", "chatId": "<ChatRef.id>" }
```

Selects a chat as active *for this client only*. Does not navigate the
Playwright page yet — navigation is lazy and happens on the next request
that needs the page (`send`, `latest`).

Reply: `use` with `active: ChatRef`. If `chatId` does not match a current
sidebar entry, reply is `error` with `message: "no chat: <chatId>"`.

### 4.4 `status`

```json
{ "id": "<uuid>", "kind": "status" }
// or
{ "id": "<uuid>", "kind": "status", "chatId": "<ChatRef.id>" }
```

Returns a single `ChatRef` with a freshly classified `status`. With no
`chatId`, uses this client's active chat; without one, replies `error`
("no active chat"). Implementation runs a `list` under the hood, so cost
is comparable.

Reply: `status` with `chat: ChatRef`.

### 4.5 `send`

```json
{ "id": "<uuid>", "kind": "send", "text": "<message body>" }
```

Sends `text` to this client's active chat. The Playwright page is
navigated to that chat first if not already there. Page navigation is
mutex-serialized across all clients, so concurrent sends to different
chats interleave correctly but not in parallel.

Reply: `ok` on success; `error` if no active chat is set.

Side effect: the server broadcasts a `message` event to all connected
clients (including the sender) recording `chatId` and `text`. The sender
should ignore its own echo if needed.

### 4.6 `latest`

```json
{ "id": "<uuid>", "kind": "latest" }
```

Returns the text of the most recent message in the active chat's
transcript. Reads `[data-testid="epitaxy-virtual-transcript"]
.epitaxy-markdown:last-child` (claude.ai's current design system) with a
fallback to legacy `.font-claude-message` / `.font-claude-response`.

Reply: `latest` with `text: string | null`. `null` means no transcript was
found (empty chat, selector drift, or page not navigated yet).

NOTE: the returned text is the *last* message in the transcript — which
may be the user's outgoing message, not the assistant's reply. There is
currently no author-role filter. If you sent a message and immediately
called `latest`, you will likely see your own text echoed back. Poll
periodically and look for change, or wait for the chat's `status` to
return to `idle`/`ready` before reading.

### 4.7 `subscribe`

```json
{ "id": "<uuid>", "kind": "subscribe", "channel": "swarm" }
```

Subscribes this client to updates about the local workers (the same data
shown by `npm run local-status`).

Currently the only supported value is `channel: "swarm"`.

Reply: `ok` on success. The server immediately sends a `swarm-status` event
containing the **full current state** (as `changes`), followed by future delta
updates (see §6.4).

### 4.8 `swarm-status` (request)

```json
{ "id": "<uuid>", "kind": "swarm-status" }
```

Returns the current full swarm state (same shape as the `swarm-status` event).
This can be called at any time (does not require prior subscription).

Reply example:
```json
{
  "id": "<uuid>",
  "kind": "swarm-status",
  "changes": {
    "jc0": { "agent": "codex", "state": "READY", "status": "up to date" },
    "jc3": { "agent": "claude", "state": "WORKING", "status": "ahead 0, behind 3" }
  }
}
```

## 5. Replies

| `kind`      | extra fields                                | meaning |
| ----------- | ------------------------------------------- | ------- |
| `ok`        | —                                           | request succeeded with no payload |
| `list`      | `chats: ChatRef[]`, `active: string \| null`| response to `list` |
| `use`       | `active: ChatRef`                           | response to `use` |
| `status`    | `chat: ChatRef`                             | response to `status` |
| `latest`    | `text: string \| null`                      | response to `latest` |
| `pong`         | —                                           | response to `ping` |
| `subscribe`    | —                                           | response to `subscribe` |
| `swarm-status` | `changes: Record<string, WorkerState>`      | response to `swarm-status` request (full current state) |
| `error`        | `message: string`                           | failure of any request |

Every reply (including `error`) carries the originating request's `id`,
except the parse-failure case noted in §2 where `id: "?"`.

## 6. Events

Events are server-pushed; agents should attach a message handler that
checks `kind === "event"` before reply-matching by id.

### 6.1 `hello`

```json
{ "kind": "event", "type": "hello", "serverVersion": "<semver>" }
```

Sent once per connection, immediately after the websocket opens. Use to
detect compatible server versions.

### 6.2 `chat-update`

```json
{ "kind": "event", "type": "chat-update", "chat": { ...ChatRef } }
```

Reserved. Not currently emitted by the server. If/when implemented, it
will signal that a chat's `status` or other metadata changed.

### 6.3 `message`

```json
{ "kind": "event", "type": "message", "chatId": "<id>", "text": "<body>" }
```

Emitted after every successful `send`. Broadcast to all clients including
the original sender. Currently only records *outgoing* messages, not
assistant responses.

### 6.4 `swarm-status`

```json
{
  "kind": "event",
  "type": "swarm-status",
  "changes": {
    "jc3": {
      "agent": "claude",
      "state": "WORKING",
      "status": "ahead 0, behind 3"
    },
    "jc1": {
      "agent": "codex",
      "state": "READY",
      "status": "up to date"
    }
  }
}
```

Pushed to clients that have subscribed with `channel: "swarm"` (see §4.7).

- On first subscribe, the server sends one `swarm-status` event with the
  **full current state** of all workers (in the `changes` field).
- Subsequent events contain only deltas (workers that changed since the
  previous poll).

Each worker entry always contains its **complete current state** (as seen by
`local-status`).

This is the primary mechanism for external orchestrators or managers to
react to worker progress without polling.

## 7. Concurrency and ordering

- Requests from a single client are processed in arrival order, but the
  server does not pipeline replies — it awaits each `dispatch` call to
  complete before reading the next request from that connection.
- Across clients, requests run in parallel except for the page mutex used
  by `withActiveChat` (entered by `send` and `latest`). Two `send`s for
  different chats serialize through this mutex; two `list` or `status`
  calls do not.
- There is no fairness guarantee on the mutex.

## 8. Errors and recovery

- `error` replies carry a `message`. Common cases: `no active chat`,
  `no chat: <id>`, `bad json: ...`, Playwright timeouts.
- If `latest` returns `null` repeatedly, the active page may not have
  navigated; calling `use` again or sending a `status` request forces
  re-evaluation.
- The server does not heartbeat. If you need liveness, send `ping` on a
  timer.
- Connection close codes are unmodified ws defaults. Reconnecting from
  scratch is cheap (~1 ws handshake; sessions persist server-side because
  scialect holds one Playwright browser process).

## 9. Minimal connection recipe (TypeScript)

```ts
import { randomUUID } from "node:crypto";

const ws = new WebSocket(process.env.SCIALECT_URL ?? "ws://127.0.0.1:5002/ws");
const pending = new Map<string, (r: unknown) => void>();

ws.addEventListener("message", (ev) => {
  const f = JSON.parse(String(ev.data));
  if (f.kind === "event") return;            // ignore or route separately
  pending.get(f.id)?.(f);
  pending.delete(f.id);
});

function call<T>(body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error("timeout")); }, timeoutMs);
    pending.set(id, (r) => { clearTimeout(t); res(r as T); });
    ws.send(JSON.stringify({ ...body, id }));
  });
}

await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
const list = await call<{ chats: { id: string }[] }>({ kind: "list" });
```

## 10. Versioning

- `serverVersion` is sent in the `hello` event. Treat it as semver.
- Breaking protocol changes will bump the major component. Additive
  fields (e.g. the recently added `ChatRef.slug`) are minor bumps; old
  clients that ignore unknown fields keep working.
- There is no client→server version negotiation; assume the server is at
  least as new as the schema in `src/protocol.mts` at your checkout.
