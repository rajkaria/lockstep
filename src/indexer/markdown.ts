/**
 * A tolerant scanner for Markdown and MDX. Strict MDX parsers reject real-world
 * docs (Mintlify components, stray braces); Lockstep only needs headings, fenced
 * code, inline code and links, which a line scanner gets right.
 */

export interface MdSection {
  /** Slug used in URLs (`#connect`); empty for the preamble before the first heading. */
  anchor: string;
  title: string;
  /** 0 for the preamble, else the heading level. */
  level: number;
  headingPath: string[];
  lineno: number;
  endLineno: number;
  /** The section's own Markdown (until the next heading of any level), heading line included. */
  body: string;
  inlineCode: { text: string; line: number }[];
  links: MdLink[];
}

export interface MdLink {
  target: string;
  line: number;
}

export interface MdExample {
  /** Position of the fenced block in the file (0-based). */
  index: number;
  lang: string;
  /** Fence info string after the language. */
  meta: string;
  code: string;
  /** Line of the first code line (1-based). */
  lineno: number;
  endLineno: number;
  sectionAnchor: string;
}

export interface MdDoc {
  path: string;
  title: string;
  sections: MdSection[];
  examples: MdExample[];
}

const LANG_ALIASES: Record<string, string> = {
  py: 'python',
  python3: 'python',
  py3: 'python',
  pycon: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  shellscript: 'bash',
  js: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  cypher: 'cypher',
  opencypher: 'cypher',
};

export function normalizeLang(raw: string): string {
  const l = raw.trim().toLowerCase().replace(/^\{?\.?/, '').replace(/[}].*$/, '');
  return LANG_ALIASES[l] ?? l;
}

export function scanMarkdown(path: string, text: string): MdDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  let title = '';
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^title:\s*["']?(.*?)["']?\s*$/.exec(l);
        if (m) title = m[1]!;
      }
      start = end + 1;
    }
  }

  const sections: MdSection[] = [];
  const examples: MdExample[] = [];
  const slugCounts = new Map<string, number>();
  const stack: string[] = [];

  let current: MdSection = newSection('', title, 0, [], start + 1);
  let fence: { char: string; len: number; indent: number; lang: string; meta: string; startLine: number; code: string[] } | null =
    null;

  const closeSection = (endLine: number) => {
    current.endLineno = endLine;
    current.body = lines.slice(current.lineno - 1, endLine).join('\n').trim();
    const hasContent = current.level > 0 || current.body.length > 0;
    if (hasContent) sections.push(current);
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    if (fence) {
      const close = new RegExp(`^\\s*${escape(fence.char)}{${fence.len},}\\s*$`);
      if (close.test(line)) {
        examples.push({
          index: examples.length,
          lang: fence.lang,
          meta: fence.meta,
          code: dedent(fence.code, fence.indent),
          lineno: fence.startLine + 1,
          endLineno: lineNo - 1,
          sectionAnchor: current.anchor,
        });
        fence = null;
      } else {
        fence.code.push(line);
      }
      continue;
    }

    const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)\s*(.*)$/.exec(line);
    if (open && !(open[2]![0] === '`' && open[4]!.includes('`'))) {
      fence = {
        char: open[2]![0]!,
        len: open[2]!.length,
        indent: open[1]!.length,
        lang: normalizeLang(open[3] ?? ''),
        meta: (open[4] ?? '').trim(),
        startLine: lineNo,
        code: [],
      };
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      closeSection(lineNo - 1);
      const level = heading[1]!.length;
      const { text: headingText, id } = cleanHeading(heading[2]!);
      stack.length = level - 1;
      stack[level - 1] = headingText;
      const base = id ?? slugify(headingText);
      const n = slugCounts.get(base) ?? 0;
      slugCounts.set(base, n + 1);
      const anchor = n === 0 ? base : `${base}-${n}`;
      if (!title && level === 1) title = headingText;
      current = newSection(anchor, headingText, level, stack.filter(Boolean), lineNo);
      continue;
    }

    for (const m of line.matchAll(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g)) {
      current.inlineCode.push({ text: m[2]!.trim(), line: lineNo });
    }
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      current.links.push({ target: m[1]!, line: lineNo });
    }
    for (const m of line.matchAll(/\bhref=["']([^"']+)["']/g)) {
      current.links.push({ target: m[1]!, line: lineNo });
    }
  }
  if (fence) {
    // Unclosed fence: keep what we have rather than dropping the example.
    examples.push({
      index: examples.length,
      lang: fence.lang,
      meta: fence.meta,
      code: dedent(fence.code, fence.indent),
      lineno: fence.startLine + 1,
      endLineno: lines.length,
      sectionAnchor: current.anchor,
    });
  }
  closeSection(lines.length);

  if (!title) title = path.split('/').pop()!.replace(/\.(md|mdx)$/i, '');
  for (const s of sections) if (s.level === 0) s.title = title;
  for (const s of sections) if (s.level === 0) s.headingPath = [title];
  return { path, title, sections, examples };
}

function newSection(anchor: string, title: string, level: number, headingPath: string[], lineno: number): MdSection {
  return { anchor, title, level, headingPath, lineno, endLineno: lineno, body: '', inlineCode: [], links: [] };
}

/** Strip inline formatting and an explicit `{#id}` from a heading. */
function cleanHeading(raw: string): { text: string; id?: string } {
  let id: string | undefined;
  const text = raw
    .replace(/\s*\{#([\w-]+)\}\s*$/, (_, x: string) => {
      id = x;
      return '';
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    // Emphasis only at word boundaries, so snake_case names keep their underscores.
    .replace(/(^|\s)([*_]{1,3})([^*_\s][^*_]*?)\2(?=\s|$|[.,:;!?)])/g, '$1$3')
    .trim();
  return { text, id };
}

/** GitHub/Mintlify-style heading slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function dedent(lines: string[], fenceIndent: number): string {
  const strip = Math.min(
    fenceIndent,
    ...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length),
  );
  return lines.map((l) => l.slice(Number.isFinite(strip) ? strip : 0)).join('\n');
}

function escape(c: string): string {
  return c.replace(/[`~]/g, (x) => `\\${x}`);
}

export interface SpanIdent {
  ident: string;
  /** Written as a call: `select_graph()`. */
  called: boolean;
}

const NOT_CODE_PREFIX = /^(pip|pip3|npm|npx|pnpm|yarn|uv|docker|git|curl|wget|redis-cli|brew|poetry|conda|cd|ls|export|python|python3|node)\s/;
/** Cypher procedures look like dotted identifiers (`db.idx.fulltext.queryNodes`, `algo.BFS`). */
const CYPHER_PROC = /^(algo|dbms|apoc|gds|GRAPH|graph)\.|^db\.(idx|meta|labels|indexes|constraints|propertyKeys|relationshipTypes)\b/;

/**
 * The code identifier an inline code span names, if it names one:
 * `Graph.ro_query` → Graph.ro_query, `db.select_graph("x")` → db.select_graph (called),
 * `select_graph()` → select_graph (called). Shell commands, paths, flags, URLs,
 * Cypher procedures, constants and prose phrases name nothing.
 */
export function identifiersIn(span: string): SpanIdent[] {
  const s = span.trim();
  if (NOT_CODE_PREFIX.test(s)) return [];
  const m = /^([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)*)\s*(\(.*\))?\s*$/s.exec(s);
  if (!m) return [];
  const ident = m[1]!;
  if (/^[A-Z0-9_]+$/.test(ident)) return []; // CONFIG_KEYS / Cypher keywords
  if (CYPHER_PROC.test(ident)) return [];
  return [{ ident, called: m[2] !== undefined }];
}

/** Package names a span or command points at: `pip install graphrag-sdk` → graphrag_sdk, `falkordb` → falkordb. */
export function packagesNamedIn(span: string): string[] {
  const s = span.trim();
  const install =
    /^(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\s+(.*)$/.exec(s) ?? /^(?:poetry|uv)\s+add\s+(.*)$/.exec(s);
  const names = install
    ? install[1]!.split(/\s+/).filter((x) => x && !x.startsWith('-'))
    : /^[a-z_][a-z0-9_-]*$/.test(s)
      ? [s]
      : [];
  return names
    .map((n) => n.replace(/^["']|["']$/g, '').replace(/[\[<>=!~;].*$/, '').replace(/-/g, '_').toLowerCase())
    .filter(Boolean);
}
