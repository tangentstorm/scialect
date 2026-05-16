import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const DEFAULT_PROFILE_DIR = resolve(homedir(), '.scialect', 'profile');
export const CLAUDE_CODE_URL = 'https://claude.ai/code';

export interface LaunchOptions {
  /** Path to a Chromium user-data-dir. Defaults to ~/.scialect/profile. */
  profileDir?: string;
  /** Show the browser window. Default true — first run needs login. */
  headed?: boolean;
  /** Override the slow-motion delay in ms (useful for debugging). */
  slowMo?: number;
  /** Channel to use. Defaults to bundled Chromium; pass "chrome" to use installed Chrome. */
  channel?: 'chrome' | 'chrome-beta' | 'msedge' | undefined;
  /** Extra Chromium args. */
  args?: string[];
}

export interface BrowserHandle {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launch a Chromium instance with a persistent profile so the Claude Code
 * login cookie survives between runs. Returns the context + a foreground page.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<BrowserHandle> {
  const profileDir = opts.profileDir ?? DEFAULT_PROFILE_DIR;
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headed === false,
    slowMo: opts.slowMo ?? 0,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', ...(opts.args ?? [])],
    ...(opts.channel ? { channel: opts.channel } : {}),
  });

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    close: async () => {
      await context.close();
    },
  };
}

/**
 * Navigate to claude.ai/code and wait for the app shell to render.
 * Throws if the page redirects to login (caller should retry headed for login).
 */
export async function gotoClaudeCode(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.goto(CLAUDE_CODE_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  // Settle redirects (claude.ai/code → /login when logged out).
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
  if (page.url().includes('/login') || (await page.locator('a[href="/login"]').count()) > 0) {
    throw new Error(
      `Not logged in. Run \`npm run demo -- wait\`, complete the login at ${CLAUDE_CODE_URL}, then Ctrl-C and retry.`,
    );
  }
  await page.waitForSelector('div[contenteditable="true"]', { timeout: timeoutMs });
}
