import * as tmux from '../tmux.mts';
import { VideoBuffer, escPuts } from 'kvm';
import { TuiAgent } from './tui-agent.mts';
import { spawnSync } from 'node:child_process';

export class CodexTui extends TuiAgent {
  constructor(target: string) {
    super(target);
  }

  async isPromptBlank(): Promise<boolean> {
    // Capture the visible screen, sized to the actual pane dimensions.
    const sizeRes = spawnSync('tmux', ['display-message', '-t', this.target, '-p', '#{pane_width} #{pane_height}'], { encoding: 'utf8' });
    const [w, h] = sizeRes.stdout.trim().split(/\s+/).map(n => parseInt(n, 10));
    const paneWidth  = Math.max(40, w || 120);
    const paneHeight = Math.max(10, h || 30);

    const rawRes = spawnSync('tmux', ['capture-pane', '-t', this.target, '-p', '-e'], { encoding: 'utf8' });
    const raw = rawRes.stdout ?? '';
    const buf = new VideoBuffer(paneWidth + 4, paneHeight + 4);
    escPuts(buf, raw);

    // Find the bottom-most › on the visible screen (highest y)
    let lastPromptY = -1;
    let lastPromptX = -1;

    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '›') {
          if (y > lastPromptY) {
            lastPromptY = y;
            lastPromptX = x;
          }
        }
      }
    }

    if (lastPromptY < 0 || lastPromptX < 0) {
      return false;
    }

    // Return true only if there is no non-whitespace text after the prompt symbol.
    let afterText = '';
    for (let x = lastPromptX + 1; x < buf.width; x++) {
      afterText += String.fromCodePoint(buf.charCodes[buf.index(x, lastPromptY)] || 32);
    }

    return afterText.trim() === '';
  }
}
