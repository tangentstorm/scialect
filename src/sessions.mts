import type { Page, Locator } from 'playwright';

/**
 * Status the cloud UI advertises for a session in the sidebar.
 * The DOM doesn't expose a stable enum, so we infer from icons + text.
 *
 * - "running":   worker is actively producing tokens
 * - "awaiting":  worker stopped and is waiting for the user (a reply, a permission)
 * - "ci":        a PR is open and CI is mid-flight (yellow indicator)
 * - "ci-pass":   CI is green
 * - "ci-fail":   CI is red
 * - "idle":      session exists but has no active turn
 * - "unknown":   we couldn't classify it — caller should inspect rawSignals
 */
export type SessionStatus =
  | 'running'
  | 'awaiting'
  | 'ci'
  | 'ci-pass'
  | 'ci-fail'
  | 'idle'
  | 'unknown';

export interface SessionSummary {
  /** Visible name in the sidebar, e.g. "1469. Prove skeletal homology quotient identity". */
  name: string;
  /** Best-effort status classification (see SessionStatus). */
  status: SessionStatus;
  /** Whether the session is pinned in the sidebar. */
  pinned: boolean;
  /** Raw text/aria signals we used to classify — handy for debugging selectors. */
  rawSignals: string[];
}

const SIDEBAR_ITEM = '[data-testid="session-list-item"], aside [role="button"], nav [role="button"]';
const CHAT_INPUT = 'div[contenteditable="true"]';
const MESSAGE = '.font-claude-message';

/**
 * Enumerate every session visible in the left sidebar. Best-effort: the cloud
 * UI doesn't ship stable test ids, so we fall back to role-based selectors and
 * classify status from text + aria-label hints.
 */
export async function listSessions(page: Page): Promise<SessionSummary[]> {
  await page.waitForSelector(CHAT_INPUT, { timeout: 30_000 });

  const items = page.locator(SIDEBAR_ITEM);
  const count = await items.count();
  const out: SessionSummary[] = [];

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const summary = await summarizeItem(item);
    if (summary) out.push(summary);
  }
  return out;
}

async function summarizeItem(item: Locator): Promise<SessionSummary | null> {
  const text = (await item.innerText().catch(() => '')).trim();
  if (!text) return null;
  const aria = (await item.getAttribute('aria-label').catch(() => '')) ?? '';
  const title = (await item.getAttribute('title').catch(() => '')) ?? '';

  // Sidebar entries usually render as `<name>\n<status-line>` — first line is the name.
  const name = text.split('\n')[0]?.trim() ?? text;
  const signals = [text, aria, title].filter(Boolean);

  return {
    name,
    status: classifyStatus(signals),
    pinned: /pinned/i.test(aria) || /pinned/i.test(title),
    rawSignals: signals,
  };
}

function classifyStatus(signals: string[]): SessionStatus {
  const blob = signals.join(' | ').toLowerCase();
  if (/(generating|running|working|in progress|thinking)/.test(blob)) return 'running';
  if (/(awaiting|needs (input|reply|response)|paused|input required)/.test(blob)) return 'awaiting';
  if (/(ci\s*pass|checks? pass|green)/.test(blob)) return 'ci-pass';
  if (/(ci\s*fail|checks? fail|red)/.test(blob)) return 'ci-fail';
  if (/(ci|checks? running|pending)/.test(blob)) return 'ci';
  if (/(idle|completed|done|merged)/.test(blob)) return 'idle';
  return 'unknown';
}

/** Click a sidebar entry by exact visible name (matches claude-tools.js#selectSession). */
export async function openSession(page: Page, sessionName: string): Promise<void> {
  await page.locator(`text="${sessionName}"`).first().click();
  await page.waitForSelector(CHAT_INPUT, { timeout: 15_000 });
}

/** Type into the chat input and submit (matches claude-tools.js#sendChatMessage). */
export async function sendMessage(page: Page, message: string): Promise<void> {
  const prompt = page.locator(CHAT_INPUT);
  await prompt.fill(message);
  await prompt.press('Enter');
}

/** Return the most recent assistant message text, or null if none. */
export async function getLatestResponse(page: Page): Promise<string | null> {
  const responses = page.locator(MESSAGE);
  const count = await responses.count();
  if (count === 0) return null;
  return responses.nth(count - 1).innerText();
}

/**
 * Look up a single session's status without selecting it. Useful for polling
 * a known worker without disrupting whichever session is currently open.
 */
export async function getSessionStatus(page: Page, sessionName: string): Promise<SessionStatus> {
  const all = await listSessions(page);
  return all.find((s) => s.name === sessionName)?.status ?? 'unknown';
}
