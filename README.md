# scialect

A tool for organizing parallel work on large formal proofs (and other
long-running engineering tasks) with a swarm of collaborating coding agents.

A single **coordinator** keeps the big-picture view while several **workers**
each develop and prove their own module on their own branch. A deterministic
orchestrator brokers every handoff between them, so the coordinator's context
window stays focused on review and integration rather than implementation
detail.

## How it works

Everything runs on an explicit, concurrent state machine. Workers and the
coordinator each report a single status line; the orchestrator polls those
lines and drives the next handoff. The full protocol — worker and coordinator
states, the legal transitions between them, and the command that triggers each
one — is specified in **[docs/state-machine.md](docs/state-machine.md)**. Read
that first; it is the heart of the system.

In short:

- A worker moves through `IDLE → ASSIGNED → WORKING`, then signals one of
  `READY` (code complete, ready for review), `SUGGEST` (next task planned,
  ready for approval), or `BLOCKED` (stuck, triage report written).
- The coordinator reviews and writes a decision — `ACCEPT`, `PREPARE`,
  `ADJUST`, or `REJECT` — back to its status line.
- The orchestrator reads that decision and triggers the matching transition,
  resetting the coordinator to `IDLE` for the next review.

State is exchanged through plain files in each worker's repo (`.sci/status-line`,
`goal.md`, `task.md`), so the workers themselves can be any coding agent.

## The orchestrator

Handoffs are driven by two scripts:

```sh
npm run tell-worker -- <worker> <verb>     # send a single token / state change
npm run local-step                          # advance the swarm one step
```

`local-step` copies the version-controlled prompt guides from `rules/` into each
worker's `.sci/` directory as it runs, so each agent is prompted with the right
guide for its current transition (`proving-guide.md`, `review-guide.md`,
`rebase-guide.md`, and so on). See
[docs/state-machine.md §4](docs/state-machine.md#4-handoff-coordination-commands-local-step--tell-worker)
for the full command/guide mapping.

Workers run as local processes (e.g. one Claude Code agent per repo working copy
under tmux). Supporting commands:

```sh
npm run local-status      # show the current status line of every worker
npm run for-all -- ...     # run a command across all worker repos
npm run gh-status          # PR / CI status across the swarm
```

## Optional: Playwright cloud transport

In addition to local workers, scialect can drive Claude Code **cloud** sessions
at [claude.ai/code](https://claude.ai/code) through a persistent Playwright
browser. This is an optional component — the swarm protocol above does not
require it — useful when some workers run in the cloud rather than locally.

### Setup

```sh
npm install
npx playwright install chromium
```

### Server + client

Run the dev server in one terminal — it owns a persistent Playwright browser and
brokers WebSocket clients, with hot-reload of the handler logic:

```sh
npm run dev
```

This is a Vite dev server. The browser stays alive across handler edits; saves to
`src/handlers.mts` or `src/sessions.mts` are picked up on the next ws message.
Use `npm run server` for a plain non-HMR boot.

The first time you start it, claude.ai will redirect to the login page in the
Chromium window it opens. Sign in there. The login cookie is stored in
`~/.scialect/profile` (override with `launchBrowser({ profileDir })`) and is
preserved while the server runs. Subsequent restarts reuse the cookie as long as
the server shuts down cleanly (Ctrl-C is fine — SIGKILL is not).

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
selection. Override the port with `SCIALECT_PORT`; override the client target
with `SCIALECT_URL=ws://host:port`.

### One-shot CLI (no server)

For quick scripted use you can also drive a fresh browser per command:

```sh
npm run demo -- list                          # list every session in the sidebar
npm run demo -- status "1469. Prove ..."      # status for one session
npm run demo -- open    "1469. Prove ..."     # open it & print latest reply
npm run demo -- wait                          # park the browser (for login)
```

Note: these spin up and tear down their own browser each invocation, so the
session cookie may not persist between runs. Prefer the server for any sustained
use.

### Library

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

Session status is classified as one of `running | awaiting | ci | ci-pass |
ci-fail | idle | unknown`. The cloud UI exposes no stable test ids, so the
classifier inspects each sidebar item's text, `aria-label`, and `title` against
keyword regexes; when a session comes back `unknown`, inspect
`SessionSummary.rawSignals` and tighten the regex in `src/sessions.mts`. The wire
protocol lives in `src/protocol.mts` (JSON frames, request/reply correlated by
`id`, server-pushed events use `kind: "event"`).

## Layout

- `src/local-step.mts` — orchestrator: advances the swarm one handoff at a time.
- `src/tell-worker.mts` — sends a single state-change token to a worker/coordinator.
- `rules/` — version-controlled prompt guides copied into `.sci/` per transition.
- `docs/state-machine.md` — the formal swarm state machine and protocol.
- `src/local-status.mts`, `src/for-all.mts`, `src/gh-status.mts` — swarm status helpers.
- `src/browser.mts` — persistent-context Playwright launcher (`launchBrowser`, `gotoClaudeCode`).
- `src/sessions.mts` — sidebar reading + per-session actions for the cloud transport.
- `src/protocol.mts` — ws wire protocol (request/reply + events).
- `src/server.mts` — ws server that owns the Playwright browser.
- `src/client.mts` — REPL client.
- `src/cli.mts` — `list / status / open / wait` one-shot demo.
- `src/index.mts` — public library re-exports.
