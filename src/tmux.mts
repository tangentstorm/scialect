import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runTmux(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('tmux', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.code ?? 1,
    };
  }
}

export async function hasSession(sessionName: string): Promise<boolean> {
  const res = await runTmux(['has-session', '-t', sessionName]);
  return res.code === 0;
}

export async function newSession(
  sessionName: string,
  directory: string,
  shell = '${SHELL:-bash}',
): Promise<CommandResult> {
  return runTmux(['new-session', '-d', '-s', sessionName, '-c', directory, shell]);
}

export async function renameWindow(target: string, name: string): Promise<CommandResult> {
  return runTmux(['rename-window', '-t', target, name]);
}

export async function sendKeys(target: string, keys: string, enter = true): Promise<CommandResult> {
  const cmd = ['send-keys', '-t', target, keys];
  if (enter) cmd.push('Enter');
  return runTmux(cmd);
}

export async function runCommand(command: string): Promise<CommandResult> {
  const parts = command.trim().split(/\s+/);
  try {
    const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

export async function runTmuxCommand(sessionName: string, command: string): Promise<CommandResult> {
  const parts = command.trim().split(/\s+/);
  const args = [...parts];
  if (!args.includes('-t')) {
    args.push('-t', sessionName);
  }
  return runTmux(args);
}

export async function nextWindow(sessionName: string): Promise<CommandResult> {
  return runTmux(['next-window', '-t', sessionName]);
}

export async function listPanes(sessionName: string, formatStr?: string): Promise<CommandResult> {
  const args = ['list-panes', '-t', sessionName];
  if (formatStr) args.push('-F', formatStr);
  return runTmux(args);
}

export async function splitWindow(
  target: string,
  splitType: '-h' | '-v',
  directory: string,
  shell = '${SHELL:-bash}',
): Promise<CommandResult> {
  return runTmux(['split-window', splitType, '-t', target, '-c', directory, shell]);
}

export async function selectPane(target: string): Promise<CommandResult> {
  return runTmux(['select-pane', '-t', target]);
}

export async function killPane(target: string): Promise<CommandResult> {
  return runTmux(['kill-pane', '-t', target]);
}

export async function switchClient(target: string): Promise<CommandResult> {
  return runTmux(['switch-client', '-t', target]);
}

export async function newWindow(...args: string[]): Promise<CommandResult> {
  return runTmux(['new-window', ...args]);
}

export async function killSession(...args: string[]): Promise<CommandResult> {
  return runTmux(['kill-session', ...args]);
}

export async function listSessions(formatStr?: string): Promise<CommandResult> {
  const args = ['list-sessions'];
  if (formatStr) args.push('-F', formatStr);
  return runTmux(args);
}

export async function attachSession(sessionName: string, unicode = true): Promise<string[]> {
  const cmd = ['tmux'];
  if (unicode) cmd.push('-u');
  cmd.push('attach-session', '-t', sessionName);
  return cmd;
}
