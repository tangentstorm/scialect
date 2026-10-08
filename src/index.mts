/**
 * scialect library surface.
 *
 * Swarm control (tmux, coding agents, state-machine handoffs) and Claude Code
 * cloud sessions are provided by tangentswarm; this re-exports scialect's MCP
 * client for it.
 */
export {
  SwarmClient,
  SwarmToolError,
  withSwarm,
  loadSwarmConfig,
  splitCommand,
  type SwarmConfig,
  type TmuxSession,
  type TmuxPane,
  type SwarmRow,
  type AgentStatus,
  type TellWorkerResult,
  type ChatRef,
  type CloudWaitResult,
} from './tangentswarm.mts';

export { formatSwarmTable, printSwarmTable } from './swarm-table.mts';
