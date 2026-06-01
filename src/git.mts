import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

type GitOptions = {
  cwd?: string | undefined;
  check?: boolean | undefined;
};

async function runGitCmd(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const result: GitResult = { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
    if (opts.check && result.code !== 0) {
      const err = new Error(`git ${args.join(' ')} failed`);
      (err as any).result = result;
      throw err;
    }
    return result;
  } catch (err: any) {
    const result: GitResult = {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      code: err.code ?? 1,
    };
    if (opts.check) {
      const e = new Error(`git ${args.join(' ')} failed`);
      (e as any).result = result;
      throw e;
    }
    return result;
  }
}

export async function clone(repoUrl: string, targetDir: string, check = true): Promise<GitResult> {
  return runGitCmd(['clone', repoUrl, targetDir], { check });
}

export async function checkout(branchName: string, cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['checkout', branchName], { cwd, check });
}

export async function checkoutNewBranch(branchName: string, cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['checkout', '-b', branchName], { cwd, check });
}

export async function checkoutTrackBranch(
  branchName: string,
  remoteBranch: string,
  cwd?: string,
  check = false,
): Promise<GitResult> {
  return runGitCmd(['checkout', '-b', branchName, '--track', remoteBranch], { cwd, check });
}

export async function branchList(cwd?: string, check = true): Promise<GitResult> {
  return runGitCmd(['branch'], { cwd, check });
}

export async function branchShowCurrent(cwd?: string, check = true): Promise<GitResult> {
  return runGitCmd(['branch', '--show-current'], { cwd, check });
}

export async function branchSetUpstream(
  branchName: string,
  remoteBranch: string,
  cwd?: string,
  check = false,
): Promise<GitResult> {
  return runGitCmd(['branch', '--set-upstream-to', remoteBranch, branchName], { cwd, check });
}

export async function branchVerbose(cwd?: string, check = true): Promise<GitResult> {
  return runGitCmd(['branch', '-vv'], { cwd, check });
}

export async function remoteBranches(
  remote = 'origin',
  branchPattern?: string,
  cwd?: string,
  check = true,
): Promise<GitResult> {
  const args = ['ls-remote', '--heads', remote];
  if (branchPattern) args.push(branchPattern);
  return runGitCmd(args, { cwd, check });
}

export async function pull(cwd?: string, ffOnly = true, check = false): Promise<GitResult> {
  const args = ['pull'];
  if (ffOnly) args.push('--ff-only');
  return runGitCmd(args, { cwd, check });
}

export async function push(
  remote = 'origin',
  branch?: string,
  setUpstream = false,
  cwd?: string,
  check = false,
): Promise<GitResult> {
  const args = ['push'];
  if (setUpstream) args.push('-u');
  args.push(remote);
  if (branch) args.push(branch);
  return runGitCmd(args, { cwd, check });
}

export async function configSet(key: string, value: string, cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['config', key, value], { cwd, check });
}

export async function configGet(key: string, cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['config', '--get', key], { cwd, check });
}

export async function status(cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['status'], { cwd, check });
}

export async function diff(cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['diff'], { cwd, check });
}

export async function log(count?: number, format?: string, cwd?: string, check = false): Promise<GitResult> {
  const args = ['log'];
  if (count) args.push('-n', String(count));
  if (format) args.push('--format', format);
  return runGitCmd(args, { cwd, check });
}

export async function add(files: string | string[], cwd?: string, check = false): Promise<GitResult> {
  const fileList = Array.isArray(files) ? files : [files];
  return runGitCmd(['add', ...fileList], { cwd, check });
}

export async function commit(message: string, cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['commit', '-m', message], { cwd, check });
}

export async function fetch(remote = 'origin', branch?: string, cwd?: string, check = false): Promise<GitResult> {
  const args = ['fetch', remote];
  if (branch) args.push(branch);
  return runGitCmd(args, { cwd, check });
}

export async function reset(target: string, mode?: string, cwd?: string, check = false): Promise<GitResult> {
  const args = ['reset'];
  if (mode) args.push(mode);
  args.push(target);
  return runGitCmd(args, { cwd, check });
}

export async function stashSave(message?: string, cwd?: string, check = false): Promise<GitResult> {
  const args = ['stash', 'save'];
  if (message) args.push(message);
  return runGitCmd(args, { cwd, check });
}

export async function stashPop(cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['stash', 'pop'], { cwd, check });
}

export async function stashList(cwd?: string, check = false): Promise<GitResult> {
  return runGitCmd(['stash', 'list'], { cwd, check });
}

export async function setUpstreamTracking(branch: string, remote = 'origin', cwd?: string): Promise<void> {
  await configSet(`branch.${branch}.remote`, remote, cwd);
  await configSet(`branch.${branch}.merge`, `refs/heads/${branch}`, cwd);
}
