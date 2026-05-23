import { VideoBuffer, escPuts } from 'kvm';
import * as tmux from '../tmux.mts';
import { TuiAgent } from './tui-agent.mts';

export class ClaudeTui extends TuiAgent {
  constructor(target: string) {
    super(target);
  }

  async isPromptBlank(): Promise<boolean> {
    const raw = await tmux.capturePane(this.target, 50, true);
    const buf = new VideoBuffer(250, 80);
    escPuts(buf, raw);

    // Find the last (most recent) ❯
    let lastPromptY = -1;
    let lastPromptX = -1;

    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < 250; x++) {
        if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '❯') {
          lastPromptY = y;
          lastPromptX = x;
        }
      }
    }

    if (lastPromptY < 0 || lastPromptX < 0) {
      return false;
    }

    // Check for any non-space text after the prompt symbol.
    // If we find real characters, the prompt is not empty.
    for (let x = lastPromptX + 1; x < lastPromptX + 50 && x < 250; x++) {
      const ch = String.fromCodePoint(buf.charCodes[buf.index(x, lastPromptY)] || 32);
      if (ch.trim() !== '') {
        return false; // non-space text found after ❯
      }
    }

    return true; // only spaces or nothing after the prompt symbol
  }
}
