import { VideoBuffer, escPuts } from 'kvm';
import * as tmux from '../tmux.mts';
import { TuiAgent } from './tui-agent.mts';

export class ClaudeTui extends TuiAgent {
  constructor(target: string) {
    super(target);
  }

  async isPromptBlank(): Promise<boolean> {
    const raw = await tmux.capturePane(this.target, 60, true);
    const buf = new VideoBuffer(300, 80);
    escPuts(buf, raw);

    // Find the lowest long horizontal bar
    let bottomBarY = -1;
    for (let y = buf.height - 1; y >= 0; y--) {
      let barCount = 0;
      for (let x = 0; x < 300; x++) {
        if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '─') barCount++;
      }
      if (barCount >= 30) {
        bottomBarY = y;
        break;
      }
    }

    if (bottomBarY < 0) return false;

    // Look a few lines above the bottom bar for the live ❯
    let promptY = -1;
    let promptX = -1;

    for (let dy = 1; dy <= 5 && bottomBarY - dy >= 0; dy++) {
      const y = bottomBarY - dy;
      for (let x = 0; x < 300; x++) {
        if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '❯') {
          promptY = y;
          promptX = x;
          break;
        }
      }
      if (promptY !== -1) break;
    }

    if (promptY === -1 || promptX === -1) return false;

    // Exact same rule as Codex: return true only if there is no non-whitespace after the ❯
    for (let x = promptX + 1; x < promptX + 100 && x < 300; x++) {
      const ch = String.fromCodePoint(buf.charCodes[buf.index(x, promptY)] || 32);
      if (ch.trim() !== '') {
        return false;
      }
    }

    return true;
  }
}
