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

## Installation

scialect is a Node (>= 20) project; the swarm machinery underneath it — tmux
control, coding-agent prompt handling, the tell-worker handoffs, status
collection and the claude.ai/code browser — lives in the Python package
[tangentswarm](https://github.com/tangentstorm/tangentswarm), which scialect
drives over MCP.

```sh
npm install                  # needs ../platform/kvm (tangentcode/platform) for browse-sorries
npm run setup:swarm          # python3 -m venv .venv && pip install -r requirements.txt
npm run check:swarm          # verify scialect can reach swarm-mcp
```

`requirements.txt` pins tangentswarm to its `mcp-server` branch until
[tangentswarm#1](https://github.com/tangentstorm/tangentswarm/pull/1) is merged
(then switch the pin to `@main` or a tag). Installing tangentswarm anywhere else
works too, as long as `swarm-mcp` / `swarm` are on `PATH` or configured below.

### Where the swarm runs

scialect spawns tangentswarm's MCP server over stdio for every command. By
default that is `<repo>/.venv/bin/swarm-mcp` (else `swarm-mcp` on `PATH`), i.e.
the swarm on this machine. To drive a swarm on another host, point it at an SSH
forced-command key that runs `swarm-mcp` there (see tangentswarm's README):

```sh
export SCIALECT_SWARM_MCP="ssh memnar-mcp"
export SCIALECT_CONTROL_DIR=/home/memnar/ver/scialect   # control dir as seen by that host
```

or in `scialect.json`:

```json
{ "swarm": { "mcpCommand": ["ssh", "memnar-mcp"], "controlDir": "/home/memnar/ver/scialect" } }
```

| setting | env | scialect.json | default |
| --- | --- | --- | --- |
| MCP server command | `SCIALECT_SWARM_MCP` | `swarm.mcpCommand` | `.venv/bin/swarm-mcp`, else `swarm-mcp` |
| control dir (workers.jsonl, rules/) | `SCIALECT_CONTROL_DIR` | `swarm.controlDir` | current directory |
| `swarm` CLI (for-all) | `SCIALECT_SWARM_CLI` | `swarm.cli` | `.venv/bin/swarm`, else `swarm` |
| show swarm-mcp's stderr | `SCIALECT_SWARM_DEBUG=1` | | off |

The control dir is this repository's checkout (or wherever `workers.jsonl`
lives): tangentswarm reads `workers.jsonl`, `known-agents.jsonl` and the
git-committed `rules/*.md` guides from it.

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

`tell-worker` and `local-status` call tangentswarm's `tell_worker` and
`swarm_status` MCP tools; `local-step` reads the status lines, proposes the next
transition, runs the handoff through `tell_worker`, and merges green PRs with
`gh`. `for-all` runs `swarm -c for-all` (streamed output, so it runs locally).
`local-step` and `for-all` read `workers.jsonl` and the workers' `.sci/` files
from the local filesystem, so run them on the swarm host.

## Claude Code cloud sessions

scialect can also work with Claude Code **cloud** sessions at
[claude.ai/code](https://claude.ai/code) (optional; the swarm protocol above
doesn't need it). The Playwright browser, login and the websocket hub now live in
tangentswarm; on the swarm host:

```sh
.venv/bin/playwright install chromium
.venv/bin/swarm cloud login       # headed browser: sign in once (profile in ~/.local/share/tangentswarm)
.venv/bin/swarm cloud serve       # browser + hub on ws://127.0.0.1:5002/ws
```

scialect then reaches the sessions through the `cloud_*` MCP tools:

```sh
npm run client            # REPL: /list /use <name> /status [name] /latest /wait /help /quit
npm run sync-assignees    # fill sorry assignees from session slugs
npm run browse-sorries    # 'c' on a sorry opens its session in the REPL
```

The hub's wire protocol is described in [docs/websocket-agent.md](docs/websocket-agent.md).

## Library

```ts
import { withSwarm } from 'scialect';

await withSwarm(async (swarm) => {
  for (const row of await swarm.swarmStatus()) console.log(row.id, row.state, row.status);
  console.log(await swarm.capturePane('agents:1', 50));
  await swarm.tellAgent('agents:1', 'please re-run lake build');
  for (const s of (await swarm.cloudListSessions()).sessions) console.log(s.status, s.id);
});
```

`SwarmClient` wraps every tangentswarm tool scialect uses (tmux, agents,
`tell_worker`/`swarm_status`, `shell_exec`, `cloud_*`); tool failures throw
`SwarmToolError`.

## Development

```sh
npm run typecheck
npm test                  # unit tests + integration tests against the real swarm-mcp (skipped if not installed)
```

## Layout

- `src/local-step.mts` — orchestrator: advances the swarm one handoff at a time.
- `src/tell-worker.mts` — one state-change handoff (via tangentswarm's `tell_worker`).
- `src/local-status.mts`, `src/swarm-table.mts` — swarm status table (via `swarm_status`).
- `src/for-all.mts` — run a command in every worker repo (via `swarm -c for-all`).
- `src/gh-status.mts`, `bin/check-up-to-date` — PR / CI / branch status across the swarm.
- `src/browse-sorries.mts`, `src/sync-assignees.mts` — the sorry database (Lean formalization tracking).
- `src/check-rule-deps.mts`, `src/rule-deps.mts` — keep the `uses:` annotations in `rules/` honest.
- `src/tangentswarm.mts` — MCP client for tangentswarm (`SwarmClient`, config).
- `src/client.mts` — cloud-session REPL; `src/check-swarm.mts` — connectivity check.
- `rules/` — version-controlled prompt guides copied into `.sci/` per transition.
- `docs/state-machine.md` — the formal swarm state machine and protocol.
- `requirements.txt` — the tangentswarm pin.
