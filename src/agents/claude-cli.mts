import { VideoBuffer, escPuts } from 'kvm';
import * as tmux from '../tmux.mts';
import { TuiAgent } from './tui-agent.mts';
import { spawnSync } from 'node:child_process';

export class ClaudeTui extends TuiAgent {
  constructor(target: string) {
    super(target);
  }

  async isPromptBlank(): Promise<boolean> {
    // Capture as plain text (consistent with Codex)
    const rawRes = spawnSync('tmux', ['capture-pane', '-t', this.target, '-p'], { encoding: 'utf8' });
    const raw = rawRes.stdout ?? '';

    const lines = raw.split('\n');

    // Find the two lowest lines that contain long horizontal bars
    const barLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/─/g, '');
      if (lines[i].includes('─') && stripped.trim().length < 15) {
        barLines.push(i);
      }
    }

    if (barLines.length < 2) {
      // Fallback: last line containing ❯ with nothing after it
      for (let i = lines.length - 1; i >= 0; i--) {
        const pos = lines[i].indexOf('❯');
        if (pos !== -1) {
          const after = lines[i].slice(pos + 1);
          return after.trim() === '';
        }
      }
      return false;
    }

    // The input prompt is between the last two bars
    const bottomBar = barLines[barLines.length - 1];
    const secondBottom = barLines[barLines.length - 2];

    for (let i = secondBottom + 1; i < bottomBar; i++) {
      const pos = lines[i].indexOf('❯');
      if (pos !== -1) {
        const after = lines[i].slice(pos + 1);
        return after.trim() === '';
      }
    }

    return false;
  }
}
