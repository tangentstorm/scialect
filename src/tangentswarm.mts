/**
 * Client for tangentswarm (https://github.com/tangentstorm/tangentswarm).
 *
 * scialect no longer drives tmux, coding agents, git handoffs or the
 * claude.ai/code browser itself. tangentswarm does, and scialect talks to it
 * as an MCP client: it spawns `swarm-mcp` over stdio and calls its tools. The
 * command is configurable, so the swarm can be local (`swarm-mcp`) or on another
 * host behind an SSH forced command (`ssh memnar-mcp`).
 *
 * Configuration, highest precedence first:
 *   SCIALECT_SWARM_MCP    command line for the MCP server, e.g. "ssh memnar-mcp"
 *   SCIALECT_CONTROL_DIR  control dir *as seen by the server* (workers.jsonl, rules/)
 *   scialect.json         { "swarm": { "mcpCommand": [...], "controlDir": "...", "cli": [...] } }
 *   defaults              <repo>/.venv/bin/swarm-mcp if present, else `swarm-mcp`;
 *                         control dir = process.cwd()
 *
 * Commands that don't fit MCP (interactive, streaming output: for-all) run the
 * `swarm` CLI instead; SCIALECT_SWARM_CLI / swarm.cli configure it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------- types

export interface TmuxSession { name: string; id: string; windows: number; attached: number; created: number }

export interface TmuxPane {
  session: string; window_index: number; window_name: string; pane_index: number; pane_id: string;
  active: boolean; window_active: boolean; current_command: string; current_path: string;
  width: number; height: number; pid: number; dead: boolean;
}

export interface SwarmRow { id: string; agent: string; state: string; health: string; status: string }

export interface AgentStatus {
  target: string; agent: string | null; prompt_blank: boolean | null; supported: boolean;
  current_command?: string; current_path?: string; last_lines: string[];
}

export interface TellWorkerResult { ok: boolean; log: string[]; error?: string }

/** A claude.ai/code session as reported by tangentswarm's cloud hub (same shape as scialect's old protocol). */
export interface ChatRef { id: string; label: string; transport: 'cloud' | 'tmux'; status?: string; slug?: string }

export interface CloudWaitResult { status: string; text: string | null; settled: boolean; elapsed_sec: number }

// ---------------------------------------------------------------- config

export interface SwarmConfig {
  /** argv for the MCP server, e.g. ['swarm-mcp'] or ['ssh', 'memnar-mcp']. */
  command: string[];
  /** control dir on the server side (workers.jsonl, known-agents.jsonl, git-tracked rules/). */
  controlDir: string;
  /** argv prefix for the `swarm` CLI (local only). */
  cli: string[];
}

interface FileConfig { swarm?: { mcpCommand?: string[] | string; controlDir?: string; cli?: string[] | string } }

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Split a command line on whitespace, honouring '...' and "..." quoting. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3] ?? ''));
  }
  return out;
}

function asArgv(v: string[] | string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const argv = Array.isArray(v) ? v : splitCommand(v);
  return argv.length ? argv : undefined;
}

function readFileConfig(cwd: string): FileConfig {
  const p = resolve(cwd, 'scialect.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) as FileConfig; } catch { return {}; }
}

export function loadSwarmConfig(opts: { env?: NodeJS.ProcessEnv; cwd?: string; repoRoot?: string } = {}): SwarmConfig {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const file = readFileConfig(cwd).swarm ?? {};
  const venv = (name: string) => {
    const p = resolve(repoRoot, '.venv', 'bin', name);
    return existsSync(p) ? [p] : undefined;
  };
  return {
    command: asArgv(env['SCIALECT_SWARM_MCP']) ?? asArgv(file.mcpCommand) ?? venv('swarm-mcp') ?? ['swarm-mcp'],
    controlDir: env['SCIALECT_CONTROL_DIR'] || file.controlDir || cwd,
    cli: asArgv(env['SCIALECT_SWARM_CLI']) ?? asArgv(file.cli) ?? venv('swarm') ?? ['swarm'],
  };
}

// ---------------------------------------------------------------- client

export class SwarmToolError extends Error {
  constructor(readonly tool: string, message: string) {
    super(`${tool}: ${message}`);
    this.name = 'SwarmToolError';
  }
}

type ToolContent = { type: string; text?: string };

/** Decode a tool result: JSON text becomes an object, other text is returned as a string. */
export function decodeToolResult(tool: string, result: { content?: unknown; isError?: boolean; structuredContent?: unknown }): unknown {
  const content = (Array.isArray(result.content) ? result.content : []) as ToolContent[];
  const text = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('');
  if (result.isError) throw new SwarmToolError(tool, text || 'tool failed');
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

export class SwarmClient {
  private constructor(private readonly client: Client, readonly config: SwarmConfig) {}

  static async connect(config: SwarmConfig = loadSwarmConfig()): Promise<SwarmClient> {
    const [command, ...args] = config.command;
    if (!command) throw new Error('empty swarm-mcp command');
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
    const client = new Client({ name: 'scialect', version: '0.2.0' });
    // swarm-mcp logs go to stderr; keep them
    // off the terminal unless asked for.
    transport.stderr?.on('data', (chunk: Buffer) => {
      if (process.env['SCIALECT_SWARM_DEBUG']) process.stderr.write(chunk);
    });
    try {
      await client.connect(transport);
    } catch (err) {
      throw new Error(`could not start tangentswarm MCP server (${config.command.join(' ')}): ${(err as Error).message}\n` +
        'Install it with `npm run setup:swarm` or set SCIALECT_SWARM_MCP (see README).');
    }
    return new SwarmClient(client, config);
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) clean[k] = v;
    const result = await this.client.callTool({ name: tool, arguments: clean }, undefined, { timeout: 15 * 60_000 });
    return decodeToolResult(tool, result as never) as T;
  }

  async toolNames(): Promise<string[]> {
    return (await this.client.listTools()).tools.map(t => t.name);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ---- tmux
  async listSessions(): Promise<TmuxSession[]> { return (await this.call<{ sessions: TmuxSession[] }>('list_sessions')).sessions; }
  async listPanes(target?: string, all = false): Promise<TmuxPane[]> {
    return (await this.call<{ panes: TmuxPane[] }>('list_panes', { target, all })).panes;
  }
  async capturePane(target: string, historyLines?: number, escapes = false): Promise<string> {
    return String(await this.call('capture_pane', { target, history_lines: historyLines, escapes }));
  }
  async sendKeys(target: string, text: string, opts: { enter?: boolean; literal?: boolean } = {}): Promise<void> {
    await this.call('send_keys', { target, text, enter: opts.enter ?? true, literal: opts.literal ?? true });
  }
  async newSession(name: string, cwd?: string, command?: string): Promise<TmuxPane> { return this.call('new_session', { name, cwd, command }); }
  async newWindow(session: string, name?: string, cwd?: string, command?: string): Promise<TmuxPane> {
    return this.call('new_window', { session, name, cwd, command });
  }

  // ---- agents
  async agentStatus(target: string): Promise<AgentStatus> { return this.call('agent_status', { target }); }
  async paneReady(target: string, probe = false): Promise<{ ready: boolean | null; agent: string | null }> {
    return this.call('pane_ready', { target, probe });
  }
  async waitForIdle(target: string, timeoutSec = 120): Promise<{ idle: boolean; waited_sec: number }> {
    return this.call('wait_for_idle', { target, timeout_sec: timeoutSec });
  }
  async tellAgent(target: string, text: string, opts: { newConversation?: boolean; requireEmptyPrompt?: boolean } = {}): Promise<unknown> {
    return this.call('tell_agent', { target, text, new_conversation: opts.newConversation ?? false,
      require_empty_prompt: opts.requireEmptyPrompt ?? true });
  }

  // ---- swarm state machine
  async swarmStatus(controlDir = this.config.controlDir): Promise<SwarmRow[]> {
    return (await this.call<{ workers: SwarmRow[] }>('swarm_status', { control_dir: controlDir })).workers;
  }
  async tellWorker(worker: string, verb: string, arg?: string, controlDir = this.config.controlDir): Promise<TellWorkerResult> {
    return this.call('tell_worker', { control_dir: controlDir, worker, verb, arg });
  }

  // ---- claude.ai/code cloud sessions (needs `swarm cloud serve` on the server side)
  async cloudListSessions(): Promise<{ active: string | null; sessions: ChatRef[] }> { return this.call('cloud_list_sessions'); }
  async cloudSendMessage(sessionId: string, text: string): Promise<void> { await this.call('cloud_send_message', { session_id: sessionId, text }); }
  async cloudGetLatestResponse(sessionId: string): Promise<string | null> {
    return (await this.call<{ text: string | null }>('cloud_get_latest_response', { session_id: sessionId })).text;
  }
  async cloudWaitForResponse(sessionId: string, text?: string, timeoutSec = 120, pollMs = 1500): Promise<CloudWaitResult> {
    return this.call('cloud_wait_for_response', { session_id: sessionId, text, timeout_sec: timeoutSec, poll_ms: pollMs });
  }
}

/** Connect, run `fn`, and always close the connection. */
export async function withSwarm<T>(fn: (swarm: SwarmClient) => Promise<T>, config?: SwarmConfig): Promise<T> {
  const swarm = await SwarmClient.connect(config);
  try {
    return await fn(swarm);
  } finally {
    await swarm.close();
  }
}
