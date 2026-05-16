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

## First run — log in

The browser stores its login cookie in `~/.scialect/profile` (override with
`launchBrowser({ profileDir })`). The first time you run anything, claude.ai
will redirect to the login page; sign in, then close and re-run. Subsequent
runs reuse the cookie.

```sh
npm run demo -- wait      # opens the browser, leaves it open for login
# log in inside the window, then Ctrl-C
npm run demo -- list      # should now print your sidebar sessions
```

## CLI

```sh
npm run demo -- list                          # list every session in the sidebar
npm run demo -- status "1469. Prove ..."      # status for one session
npm run demo -- open    "1469. Prove ..."     # open it & print latest reply
npm run demo -- wait                          # park the browser (for login)
```

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

## Server + REPL client

There's also a long-running server that owns one Playwright browser and
brokers multiple WebSocket clients. Each connected client picks its own
"active chat" and types into it.

```sh
npm run server      # opens Chromium, raises it to the foreground (osx),
                    # listens on ws://127.0.0.1:7878
npm run client      # readline REPL — type /help for commands
```

REPL commands:

```
/list                 list every chat (* = your active one)
/use <name>           switch active chat (use the full session name)
/status [name]        status of active chat, or a named one
/latest               latest assistant reply in active chat
/quit                 disconnect
<anything else>       send as a message to active chat
```

The server raises the bundled Chromium window with
`osascript -e 'tell application "Chromium" to activate'` (falls back to
"Google Chrome"). Override the port with `SCIALECT_PORT`; override the
client target with `SCIALECT_URL=ws://host:port`.

The wire protocol lives in `src/protocol.mts` — JSON frames, request/reply
correlated by `id`, server-pushed events use `kind: "event"`. Currently
only `transport: "cloud"` chats are wired up; tmux-backed local agents are
the planned next transport.

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
