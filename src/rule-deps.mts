/**
 * rule-deps — shared helpers for the `uses:` dependency annotations on the
 * guides in rules/.
 *
 * A guide may declare, in a frontmatter block, the other rules/ files it
 * references so that when one guide is copied to an agent we can copy its
 * dependencies too:
 *
 *     ---
 *     uses: [commit-guide.md, status-guide.md]
 *     ---
 *
 * Both the inline list form above and the YAML block form are accepted:
 *
 *     ---
 *     uses:
 *       - commit-guide.md
 *       - status-guide.md
 *     ---
 */

/** Split leading `---\n...\n---` frontmatter (if any) from the body. */
export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: null, body: text };
  return { fm: m[1]!, body: text.slice(m[0].length) };
}

/** Parse a `uses:` list (inline `[a, b]` or `- a` block form) out of frontmatter text. */
export function parseUses(fm: string | null): string[] {
  if (!fm) return [];

  const inline = fm.match(/^uses:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]!
      .split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  const block = fm.match(/^uses:\s*\n((?:\s*-\s*.+\n?)+)/m);
  if (block) {
    return block[1]!
      .split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  return [];
}

/** Parse the declared `uses:` dependencies directly from a guide's full text. */
export function usesOf(text: string): string[] {
  return parseUses(splitFrontmatter(text).fm);
}

/**
 * Given a starting guide name and a function that returns the content of a
 * guide (or null if it does not exist), return the transitive closure of
 * `uses:` dependencies, NOT including the starting guide itself. Cycles and
 * missing guides are handled gracefully. The returned order is deterministic
 * (breadth-first, alphabetical within a level).
 */
export function resolveDependencies(
  start: string,
  getContent: (name: string) => string | null,
): string[] {
  const seen = new Set<string>([start]);
  const result: string[] = [];
  let frontier = [start];

  while (frontier.length) {
    const next: string[] = [];
    for (const name of frontier) {
      const content = getContent(name);
      if (content === null) continue;
      for (const dep of usesOf(content).sort()) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        result.push(dep);
        next.push(dep);
      }
    }
    frontier = next;
  }

  return result;
}
