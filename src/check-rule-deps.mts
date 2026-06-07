#!/usr/bin/env node
/**
 * check-rule-deps — validate the `uses:` dependency annotations in rules/*.md.
 *
 * Each guide in rules/ may declare a frontmatter block listing the other
 * rules/ files it references, so that when one guide is copied to an agent we
 * can copy its dependencies too:
 *
 *     ---
 *     uses: [commit-guide.md, status-guide.md]
 *     ---
 *
 * This script keeps that annotation honest. It scans every rules/*.md file and
 * reports four kinds of problem:
 *
 *   1. MISSING  — a rules/ file is referenced in the prose but absent from `uses:`.
 *   2. EXTRA    — a `uses:` entry is never actually referenced in the prose.
 *   3. DANGLING — a `uses:` entry (or prose reference) points at a file that
 *                 does not exist in rules/.
 *   4. UNLINKED — (with --links) a *.md reference in the prose is a bare path,
 *                 not wrapped in a markdown link or inline-code span.
 *
 * References are detected both as plain `rules/foo.md` / `/rules/foo.md` paths
 * and as `.sci/foo.md` paths, since guides are copied into a worker's .sci/
 * directory under the same basename when handed off.
 *
 * Exit code is non-zero if any problem (other than --links warnings, which are
 * advisory unless --strict) is found, so this can gate CI.
 *
 * Usage:
 *   tsx src/check-rule-deps.mts [--links] [--strict] [--fix] [rulesDir]
 *
 *   --links   also check that every *.md reference is wrapped in a markdown
 *             link [..](..) or an inline-code span `..` (reported as UNLINKED).
 *   --strict  treat UNLINKED warnings as failures too.
 *   --fix     rewrite `uses:` lists to match the prose (adds MISSING, drops
 *             EXTRA). Does not touch prose or UNLINKED issues.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter, parseUses } from "./rule-deps.mts";

type Problem = {
  file: string;
  kind: "MISSING" | "EXTRA" | "DANGLING" | "UNLINKED";
  detail: string;
};

const args = process.argv.slice(2);
const checkLinks = args.includes("--links");
const strict = args.includes("--strict");
const fix = args.includes("--fix");
const rulesDir = args.find((a) => !a.startsWith("--")) ?? "rules";

if (!existsSync(rulesDir)) {
  console.error(`Error: rules directory not found: ${rulesDir}`);
  process.exit(2);
}

const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
const ruleSet = new Set(ruleFiles);

/**
 * Find references to rules/ files in the body prose, returning the set of
 * basenames referenced.
 *
 * Two reference forms count as rules dependencies:
 *   - explicit `rules/foo.md` or `/rules/foo.md` paths — always a rules ref
 *     (if foo.md is absent from rules/, that is a genuine DANGLING reference);
 *   - `.sci/foo.md` paths — the form a guide takes once copied into a worker's
 *     .sci/ directory, BUT only when foo.md actually exists in rules/. Worker
 *     runtime-state files (.sci/task.md, .sci/goal.md, .sci/result.md, etc.)
 *     are created per-worker and have no rules/ counterpart, so they are not
 *     copyable dependencies and are deliberately ignored here.
 */
function findRuleRefs(body: string): Set<string> {
  const refs = new Set<string>();

  const rulesRe = /\/?rules\/([A-Za-z0-9_-]+\.md)/g;
  let m: RegExpExecArray | null;
  while ((m = rulesRe.exec(body)) !== null) {
    refs.add(m[1]!);
  }

  const sciRe = /\.sci\/([A-Za-z0-9_-]+\.md)/g;
  while ((m = sciRe.exec(body)) !== null) {
    if (ruleSet.has(m[1]!)) refs.add(m[1]!);
  }

  return refs;
}

/**
 * Find *.md references in prose that are NOT wrapped in a markdown link
 * [text](...path...) or an inline-code span `...path...`. Returns the raw
 * matched path strings.
 */
function findUnlinkedMd(body: string): string[] {
  const unlinked: string[] = [];
  // Any token ending in .md, possibly path-qualified.
  const re = /(?<![`\[(/\w-])((?:\/?[\w./-]*\/)?[\w-]+\.md)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const path = m[1]!;
    const idx = m.index;
    // Look at the characters immediately around the match to classify context.
    const before = body.slice(Math.max(0, idx - 1), idx);
    const after = body.slice(idx + path.length, idx + path.length + 1);
    const inCode = before === "`" || after === "`";
    // Markdown link target: ](path) or [path]
    const linkTarget = before === "(" || before === "[";
    // Scan backwards on the line for an enclosing inline-code span.
    const lineStart = body.lastIndexOf("\n", idx) + 1;
    const lineHead = body.slice(lineStart, idx);
    const backticksBefore = (lineHead.match(/`/g) ?? []).length;
    const insideSpan = backticksBefore % 2 === 1;
    if (inCode || linkTarget || insideSpan) continue;
    unlinked.push(path);
  }
  return unlinked;
}

const problems: Problem[] = [];
const fixes: { file: string; newText: string }[] = [];

for (const file of ruleFiles) {
  const fullPath = join(rulesDir, file);
  const text = readFileSync(fullPath, "utf8");
  const { fm, body } = splitFrontmatter(text);

  const declared = parseUses(fm);
  const refs = findRuleRefs(body);
  refs.delete(file); // a guide referencing itself is not a dependency

  // 1. MISSING: referenced in prose but not declared.
  for (const ref of refs) {
    if (!declared.includes(ref)) {
      problems.push({ file, kind: "MISSING", detail: ref });
    }
  }
  // 2. EXTRA: declared but never referenced in prose.
  for (const dep of declared) {
    if (!refs.has(dep)) {
      problems.push({ file, kind: "EXTRA", detail: dep });
    }
  }
  // 3. DANGLING: declared or referenced target does not exist.
  for (const target of new Set([...declared, ...refs])) {
    if (!ruleSet.has(target)) {
      problems.push({ file, kind: "DANGLING", detail: target });
    }
  }
  // 4. UNLINKED (opt-in).
  if (checkLinks) {
    for (const path of findUnlinkedMd(body)) {
      problems.push({ file, kind: "UNLINKED", detail: path });
    }
  }

  // --fix: reconcile `uses:` with the actual prose references (existing only).
  if (fix) {
    const wanted = [...refs].filter((r) => ruleSet.has(r)).sort();
    const current = [...declared].sort();
    const same = wanted.length === current.length && wanted.every((w, i) => w === current[i]);
    if (!same) {
      const newText = rewriteUses(text, fm, body, wanted);
      fixes.push({ file, newText });
    }
  }
}

/** Produce file text with the `uses:` annotation set to `wanted` (or removed if empty). */
function rewriteUses(raw: string, fm: string | null, body: string, wanted: string[]): string {
  const usesLine = wanted.length ? `uses: [${wanted.join(", ")}]` : null;

  if (fm === null) {
    // No frontmatter yet — add one if we have deps.
    if (!usesLine) return raw;
    return `---\n${usesLine}\n---\n\n${body.replace(/^\n+/, "")}`;
  }

  // Strip any existing uses: (inline or block) from the frontmatter.
  let newFm = fm
    .replace(/^uses:\s*\[[^\]]*\]\s*\n?/m, "")
    .replace(/^uses:\s*\n(?:\s*-\s*.+\n?)+/m, "");
  if (usesLine) newFm = `${usesLine}\n${newFm}`.replace(/\n+$/, "\n");
  newFm = newFm.replace(/\n+$/, "");

  if (newFm.trim() === "") {
    // Frontmatter became empty — drop it entirely.
    return body.replace(/^\n+/, "");
  }
  return `---\n${newFm}\n---\n${body}`;
}

if (fix && fixes.length) {
  for (const { file, newText } of fixes) {
    writeFileSync(join(rulesDir, file), newText);
    console.log(`fixed uses: in ${file}`);
  }
}

// Report.
const order = { MISSING: 0, EXTRA: 1, DANGLING: 2, UNLINKED: 3 } as const;
problems.sort((a, b) => a.file.localeCompare(b.file) || order[a.kind] - order[b.kind]);

const failKinds = new Set<Problem["kind"]>(["MISSING", "EXTRA", "DANGLING"]);
if (strict) failKinds.add("UNLINKED");

let hadFailure = false;
if (problems.length === 0) {
  console.log(`OK — ${ruleFiles.length} rule files, dependency annotations consistent.`);
} else {
  const explain: Record<Problem["kind"], string> = {
    MISSING: "referenced in prose but not in `uses:`",
    EXTRA: "in `uses:` but not referenced in prose",
    DANGLING: "target file does not exist in rules/",
    UNLINKED: "*.md reference not wrapped in a link or `code` span",
  };
  for (const p of problems) {
    const mark = failKinds.has(p.kind) ? "✗" : "⚠";
    if (failKinds.has(p.kind)) hadFailure = true;
    console.log(`${mark} ${p.file}: ${p.kind} ${p.detail}  (${explain[p.kind]})`);
  }
}

process.exit(hadFailure ? 1 : 0);
