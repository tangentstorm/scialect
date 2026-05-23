import * as tmux from '../tmux.mts';
import { VideoBuffer, escPuts } from 'kvm';
import { TuiAgent } from './tui-agent.mts';
import { spawnSync } from 'node:child_process';

export class CodexTui extends TuiAgent {
  constructor(target: string) {
    super(target);
  }

  async isPromptBlank(): Promise<boolean> {
    // Capture the visible screen as plain text — this is now the source of truth
    const rawRes = spawnSync('tmux', ['capture-pane', '-t', this.target, '-p'], { encoding: 'utf8' });
    const raw = rawRes.stdout ?? '';

    const lines = raw.split('\n');

    // Find the last line that contains a › (this should be the live input prompt)
    let promptLineIndex = -1;
    let promptLine = '';

    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('›')) {
        promptLineIndex = i;
        promptLine = lines[i];
        break;
      }
    }

    if (promptLineIndex === -1) {
      return false;
    }

    // Check if there is any non-whitespace after the first › on this line
    const firstPromptPos = promptLine.indexOf('›');
    if (firstPromptPos === -1) {
      return false;
    }

    const after = promptLine.slice(firstPromptPos + 1);
    return after.trim() === '';
  }
}
