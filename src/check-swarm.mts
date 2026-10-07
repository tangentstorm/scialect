#!/usr/bin/env node
/**
 * check-swarm — verify scialect can reach tangentswarm's MCP server and that it
 * offers every tool scialect uses.
 */
import { SwarmClient, loadSwarmConfig } from './tangentswarm.mts';

export const REQUIRED_TOOLS = [
  'list_sessions', 'list_panes', 'capture_pane', 'send_keys', 'shell_exec',
  'agent_status', 'pane_ready', 'wait_for_idle', 'tell_agent', 'swarm_status', 'tell_worker',
  'cloud_list_sessions', 'cloud_send_message', 'cloud_get_latest_response', 'cloud_wait_for_response',
];

async function main(): Promise<void> {
  const config = loadSwarmConfig();
  console.log(`swarm-mcp command: ${config.command.join(' ')}`);
  console.log(`control dir:       ${config.controlDir}`);
  const swarm = await SwarmClient.connect(config);
  try {
    const tools = await swarm.toolNames();
    const missing = REQUIRED_TOOLS.filter(t => !tools.includes(t));
    console.log(`tools:             ${tools.length} (${missing.length ? `MISSING: ${missing.join(', ')}` : 'all required tools present'})`);
    const sessions = await swarm.listSessions();
    console.log(`tmux sessions:     ${sessions.map(s => s.name).join(', ') || '(none)'}`);
    if (missing.length) process.exitCode = 1;
  } finally {
    await swarm.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error((err as Error).message ?? err);
    process.exit(1);
  });
}
