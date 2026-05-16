# scialect

A small TypeScript API for opening a Playwright browser with a persistent
profile, browsing the active Claude Code cloud sessions at
[claude.ai/code](https://claude.ai/code), and observing their status.

The selectors are derived from the helpers in
`../jc0/scripts/claude-tools.js` and the protocol notes in
`../jc0/ref/cloud-guide.md`.

## Setup

```sh
npm install
npx playwright install chromium
```

## Usage

Run the dev server in one terminal — it owns a persistent Playwright browser
and brokers WebSocket clients, with hot-reload of the handler logic:

```sh
npm run dev
```

This is a Vite dev server. The browser stays alive across handler edits;
saves to `src/handlers.mts` or `src/sessions.mts` are picked up on the next
ws message. Use `npm run server` for a plain non-HMR boot.

The first time you start it, claude.ai will redirect to the login page in
the Chromium window it opens. Sign in there. The login cookie is stored in
`~/.scialect/profile` (override with `launchBrowser({ profileDir })`) and is
preserved while the server runs. Subsequent restarts reuse the cookie as
long as the server shuts down cleanly (Ctrl-C is fine — SIGKILL is not).

In another terminal, connect with the REPL client:

```sh
npm run client
```

REPL commands:

```
/list                 list every chat (* = your active one)
/use <name>           switch active chat (use the full session name)
/status [name]        status of active chat, or a named one
/latest               latest assistant reply in active chat
/help                 show this list
/quit                 disconnect
<anything else>       send as a message to active chat
```

Multiple clients can connect simultaneously; each has its own active-chat
selection.

Override the port with `SCIALECT_PORT`; override the client target with
`SCIALECT_URL=ws://host:port`.

## One-shot CLI (no server)

For quick scripted use you can also drive a fresh browser per command:

```sh
npm run demo -- list                          # list every session in the sidebar
npm run demo -- status "1469. Prove ..."      # status for one session
npm run demo -- open    "1469. Prove ..."     # open it & print latest reply
npm run demo -- wait                          # park the browser (for login)
```

Note: these spin up and tear down their own browser each invocation, so the
session cookie may not persist between runs. Prefer the server for any
sustained use.

## Library

```ts
import {
  launchBrowser,
  gotoClaudeCode,
  listSessions,
  openSession,
  sendMessage,
  getLatestResponse,
  getSessionStatus,
} from 'scialect';

const { page, close } = await launchBrowser({ headed: true });
await gotoClaudeCode(page);

for (const s of await listSessions(page)) {
  console.log(s.status, s.name);
}

await openSession(page, '1469. Prove skeletal homology quotient identity');
await sendMessage(page, 'status?');
console.log(await getLatestResponse(page));

await close();
```

## Status classification

`SessionStatus` is one of `running | awaiting | ci | ci-pass | ci-fail | idle
| unknown`. The cloud UI doesn't expose stable test ids, so the classifier
inspects each sidebar item's text, `aria-label`, and `title` and matches
against keyword regexes. When a session comes back as `unknown`, inspect
`SessionSummary.rawSignals` to see what the DOM gave us and tighten the
regex in `src/sessions.mts`.

## Wire protocol

The wire protocol lives in `src/protocol.mts` — JSON frames, request/reply
correlated by `id`, server-pushed events use `kind: "event"`. Currently
only `transport: "cloud"` chats are wired up; tmux-backed local agents are
the planned next transport. On macOS the server raises the Chromium window
with `osascript -e 'tell application "Chromium" to activate'` (falls back
to "Google Chrome").

## Layout

- `src/browser.mts` — persistent-context launcher (`launchBrowser`,
  `gotoClaudeCode`).
- `src/sessions.mts` — sidebar reading + per-session actions, ports the
  selectors from `claude-tools.js`.
- `src/protocol.mts` — ws wire protocol (request/reply + events).
- `src/server.mts` — ws server that owns the Playwright browser.
- `src/client.mts` — REPL client.
- `src/cli.mts` — `list / status / open / wait` one-shot demo.
- `src/index.mts` — public library re-exports.
