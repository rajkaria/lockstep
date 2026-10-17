/**
 * A unified diff of fixed files, for pull requests from forks: the App cannot push to a
 * fork, so the check run carries the patch (`git apply` it, or copy the lines).
 */

function split(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A hunk: where it starts on each side (0-based) and its lines with their ` `, `-`, `+` prefixes. */
interface Hunk {
  oldFrom: number;
  newFrom: number;
  lines: string[];
}

function header(h: Hunk): string {
  const oldCount = h.lines.filter((l) => !l.startsWith('+')).length;
  const newCount = h.lines.filter((l) => !l.startsWith('-')).length;
  return `@@ -${oldCount ? h.oldFrom + 1 : h.oldFrom},${oldCount} +${newCount ? h.newFrom + 1 : h.newFrom},${newCount} @@`;
}

/**
 * The diff of one file. Fixes replace text within lines, so when both sides have the same
 * number of lines each changed line is its own change (with `context` lines around,
 * merged when close); otherwise one hunk spans from the first to the last difference.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = split(before);
  const b = split(after);
  const hunks: Hunk[] = [];
  if (a.length === b.length) {
    const changed: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
    for (let i = 0; i < changed.length; ) {
      let j = i;
      // Changes closer than two contexts apart share a hunk.
      while (j + 1 < changed.length && changed[j + 1]! - changed[j]! <= 2 * context) j++;
      const first = changed[i]!;
      const last = changed[j]!;
      const from = Math.max(0, first - context);
      const lines = a.slice(from, first).map((l) => ` ${l}`);
      for (let k = first; k <= last; k++) {
        if (a[k] === b[k]) {
          lines.push(` ${a[k]}`);
          continue;
        }
        let m = k;
        while (m + 1 <= last && a[m + 1] !== b[m + 1]) m++;
        for (let x = k; x <= m; x++) lines.push(`-${a[x]}`);
        for (let x = k; x <= m; x++) lines.push(`+${b[x]}`);
        k = m;
      }
      lines.push(...a.slice(last + 1, Math.min(a.length, last + 1 + context)).map((l) => ` ${l}`));
      hunks.push({ oldFrom: from, newFrom: from, lines });
      i = j + 1;
    }
  } else {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length - 1;
    let endB = b.length - 1;
    while (endA >= start && endB >= start && a[endA] === b[endB]) {
      endA--;
      endB--;
    }
    const from = Math.max(0, start - context);
    hunks.push({
      oldFrom: from,
      newFrom: from,
      lines: [
        ...a.slice(from, start).map((l) => ` ${l}`),
        ...a.slice(start, endA + 1).map((l) => `-${l}`),
        ...b.slice(start, endB + 1).map((l) => `+${l}`),
        ...a.slice(endA + 1, Math.min(a.length, endA + 1 + context)).map((l) => ` ${l}`),
      ],
    });
  }
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks.flatMap((h) => [header(h), ...h.lines])].join('\n');
}

/** One patch for several files (paths sorted). */
export function patchOf(changes: ReadonlyMap<string, { before: string; after: string }>): string {
  return [...changes.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([path, c]) => unifiedDiff(path, c.before, c.after))
    .filter(Boolean)
    .join('\n');
}
