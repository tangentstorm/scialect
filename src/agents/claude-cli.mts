import { VideoBuffer, escPuts } from 'kvm';
import * as tmux from '../tmux.mts';

export class ClaudeTui {
  constructor(private target: string) {}

  async isAtPrompt(): Promise<boolean> {
    const raw = await tmux.capturePane(this.target, 50, true);
    const buf = new VideoBuffer(250, 80);
    escPuts(buf, raw);

    const seps: number[] = [];
    for (let y = 0; y < buf.height; y++) {
      let d = 0;
      for (let x = 0; x < buf.width; x++) {
        if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '─') d++;
      }
      if (d >= 20) seps.push(y);
    }

    for (const sepY of seps) {
      for (let dy = 1; dy <= 3; dy++) {
        const y = sepY + dy;
        if (y >= buf.height) continue;

        let px = -1;
        for (let x = 0; x < buf.width; x++) {
          if (String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32) === '❯') {
            px = x;
            break;
          }
        }
        if (px === -1) continue;

        let rx = -1;
        for (let x = px; x < buf.width; x++) {
          if (buf.bgs[buf.index(x, y)] !== 0) {
            rx = x;
            break;
          }
        }

        if (rx === -1) {
          let after = '';
          for (let x = px + 1; x < Math.min(px + 20, buf.width); x++) {
            after += String.fromCodePoint(buf.charCodes[buf.index(x, y)] || 32);
          }
          return after.trim().length < 2;
        }

        return (rx - px) <= 3;
      }
    }
    return false;
  }
}
