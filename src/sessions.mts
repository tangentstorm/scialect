import type { Page } from 'playwright';

/**
 * Status the cloud UI advertises for a session in the sidebar.
 * Primary signal is the `<span role="status" aria-label="...">` indicator;
 * PR status (`#NNN · Open|Merged|Closed`) is a secondary signal.
 *
 * - "running":   worker is actively producing tokens ("Running")
 * - "awaiting":  worker stopped and needs user input ("Awaiting input")
 * - "ready":     worker finished and has unread output — blue dot ("Ready")
 * - "ci":        PR open, CI mid-flight
 * - "ci-pass":   CI green
 * - "ci-fail":   CI red
 * - "idle":      no active turn (e.g. merged / closed PRs)
 * - "unknown":   we couldn't classify it — caller should inspect rawSignals
 */
export type SessionStatus =
  | 'running'
  | 'awaiting'
  | 'ready'
  | 'ci'
  | 'ci-pass'
  | 'ci-fail'
  | 'idle'
  | 'unknown';

export interface SessionSummary {
  /** Visible name in the sidebar, e.g. "1469. Prove skeletal homology quotient identity". */
  name: string;
  /** URL slug (the last path segment of claude.ai/code/<slug>), e.g. "session_abc123". */
  slug: string;
  /** Best-effort status classification (see SessionStatus). */
  status: SessionStatus;
  /** Whether the session is pinned in the sidebar. */
  pinned: boolean;
  /** Raw text/aria signals we used to classify — handy for debugging selectors. */
  rawSignals: string[];
}

const CHAT_INPUT = 'div[contenteditable="true"]';
const MESSAGE = '.font-claude-message';

// Each session row sits inside `<div data-row-key="code:session_...">`; the
// main click target is the inner `button[data-row-main-button]`. The chrome
// rows ("New session", "Routines", etc.) use the same button selector but
// don't have a `code:session_` parent.
const SESSION_ROW = '[data-row-key^="code:session_"]';

/**
 * Enumerate every session visible in the left sidebar. Does everything in
 * a single page-context evaluate to avoid per-row playwright round-trips —
 * for 100+ rows the round-trip cost is dominant.
 */
export async function listSessions(page: Page): Promise<SessionSummary[]> {
  await page.waitForSelector(CHAT_INPUT, { timeout: 30_000 });

  const raw = await page.evaluate((rowSel: string) => {
    const rows = Array.from(document.querySelectorAll(rowSel)) as HTMLElement[];
    return rows.map((row) => {
      const text = (row.innerText ?? '').trim();
      const name = text.split('\n')[0]?.trim() ?? text;
      const rowKey = row.getAttribute('data-row-key') ?? '';
      const fromKey = rowKey.startsWith('code:') ? rowKey.slice('code:'.length) : '';
      const anchor = row.querySelector('a[href*="/code/"]') as HTMLAnchorElement | null;
      const href = anchor?.getAttribute('href') ?? '';
      const fromHref = href ? (href.split('/code/')[1] ?? '').split(/[?#]/)[0] : '';
      const slug = fromHref || fromKey;
      const kindEl = row.querySelector('[data-kind]');
      const kind = kindEl?.getAttribute('data-kind') ?? null;
      const indicator = row.querySelector('[role="status"], [role="img"]');
      const indicatorLabel = indicator?.getAttribute('aria-label') ?? null;
      const ariaLabels = Array.from(row.querySelectorAll('[aria-label]'))
        .map((el) => el.getAttribute('aria-label') ?? '')
        .filter(Boolean);
      return { text, name, slug, kind, indicatorLabel, ariaLabels };
    });
  }, SESSION_ROW);

  return raw
    .filter((r) => r.text.length > 0)
    .map((r) => {
      const signals = [
        r.text,
        ...(r.kind ? [`kind=${r.kind}`] : []),
        ...(r.indicatorLabel ? [`indicator=${r.indicatorLabel}`] : []),
        ...r.ariaLabels,
      ];
      return {
        name: r.name,
        slug: r.slug,
        status: classifyStatus(r.kind, r.indicatorLabel, signals),
        pinned: false,
        rawSignals: signals,
      };
    });
}

function classifyStatus(
  kind: string | null,
  indicatorLabel: string | null,
  signals: string[],
): SessionStatus {
  // Trust the explicit indicator kind.
  if (kind === 'ready') return 'ready';
  if (kind === 'awaiting') return 'awaiting';
  if (kind === 'running') return 'running';
  // Idle rows have role="img" aria-label="Idle" with no data-kind child.
  if (indicatorLabel === 'Idle') return 'idle';
  if (indicatorLabel === 'Running') return 'running';
  if (indicatorLabel === 'Awaiting input') return 'awaiting';
  if (indicatorLabel === 'Ready') return 'ready';

  // Fall back to PR / text heuristics for anything else.
  const blob = signals.join(' | ').toLowerCase();
  if (/·\s*merged|·\s*closed/.test(blob)) return 'idle';
  if (/·\s*open/.test(blob)) return 'ci';
  if (/(ci\s*pass|checks? pass)/.test(blob)) return 'ci-pass';
  if (/(ci\s*fail|checks? fail)/.test(blob)) return 'ci-fail';
  if (/(ci|checks? running|pending)/.test(blob)) return 'ci';
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
  return await page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="epitaxy-virtual-transcript"]');
    if (transcript) {
      const bodies = transcript.querySelectorAll('.epitaxy-markdown');
      if (bodies.length > 0) {
        const last = bodies[bodies.length - 1] as HTMLElement;
        const txt = (last.innerText ?? last.textContent ?? '').trim();
        if (txt) return txt;
      }
    }
    // Legacy/alternate UIs.
    for (const sel of ['.font-claude-message', '.font-claude-response']) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        const last = els[els.length - 1] as HTMLElement;
        const txt = (last.innerText ?? last.textContent ?? '').trim();
        if (txt) return txt;
      }
    }
    return null;
  });
}

/**
 * Look up a single session's status without selecting it. Useful for polling
 * a known worker without disrupting whichever session is currently open.
 */
export async function getSessionStatus(page: Page, sessionName: string): Promise<SessionStatus> {
  const all = await listSessions(page);
  return all.find((s) => s.name === sessionName)?.status ?? 'unknown';
}
