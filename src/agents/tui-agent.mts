import * as tmux from '../tmux.mts';

async function _sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Base class for TUI-based agents (Claude, Codex, etc.).
 * Provides a default implementation of `ensurePromptIsEmpty()` that uses
 * a non-destructive space probe to distinguish placeholder/suggestion text
 * from real user input.
 */
export abstract class TuiAgent {
  constructor(protected readonly target: string) {}

  /**
   * Returns true if the prompt area is literally blank
   * (i.e. the line after the prompt symbol contains no non-whitespace characters).
   */
  abstract isPromptBlank(): Promise<boolean>;

  /**
   * Ensures the prompt is empty (no real user input).
   *
   * Logic:
   * - If the prompt is already blank, return true.
   * - Otherwise send a space.
   * - If the prompt is now blank, it means the previous text was filler → return true.
   * - Otherwise there is real input → return false.
   * - Always backspace afterward to clean up the probe character.
   */
  async ensurePromptIsEmpty(maxWaitMs = 5000): Promise<boolean> {
    // Quick check before probing
    if (await this.isPromptBlank()) {
      return true;
    }

    // Send space as a probe
    await tmux.sendKeys(this.target, ' ', false);
    await _sleep(500);

    // Check if the space cleared the line (i.e. previous content was filler)
    const nowBlank = await this.isPromptBlank();

    // Always undo the space
    await tmux.sendKeys(this.target, 'BSpace', false);
    await _sleep(100);

    return nowBlank;
  }
}
