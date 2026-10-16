/**
 * A tolerant scanner for reStructuredText (Sphinx docs), producing the same shape as
 * the Markdown scanner: sections (from underlined/overlined titles), code examples
 * (`.. code-block:: python`, `.. testcode::`, `.. doctest::`, `::` literal blocks,
 * `>>>` doctest blocks), inline code (``literals`` and API roles like
 * :meth:`Session.get`) and links (:doc:, :ref:). Like the Markdown scanner it reads
 * lines, so real-world docs with unknown directives never fail to index.
 */
import { slugify, type ExampleDirective, type MdDoc, type MdExample, type MdSection } from './markdown.js';

const ADORNMENT = /^([=\-~^"'`#*+:.<>_!$%&,;/?@\\|])\1{2,}\s*$/;
const CODE_DIRECTIVE = /^(\s*)\.\.\s+(code-block|code|sourcecode|testcode|doctest|testsetup|ipython|jupyter-execute)::\s*(\S*)\s*$/;
const ANY_DIRECTIVE = /^\s*\.\.\s+[\w:-]+::/;
const LABEL = /^\.\.\s+_([^:]+):\s*$/;
const ROLE = /:(?:py:)?(func|meth|class|attr|obj|exc|data|mod|const|doc|ref|any)?:`([^`]+)`/g;
const SKIP_COMMENT = /^\.\.\s+(?:staleproof\s*:\s*(skip|no-run|ignore|expect-error|raises)|skip\s*:\s*next\b.*)\s*$/i;

/** Lines that look like Python: a doctest prompt, an import, an assignment or a call. */
export function looksLikePython(code: string): boolean {
  if (/^\s*>>>/m.test(code)) return true;
  return /^\s*(import \w|from [\w.]+ import |[\w.]+\s*=\s*\S|[\w.]+\(|async def |def |class \w|with \w|for \w+ in )/m.test(code);
}

function lineIndent(l: string): number {
  return /^\s*/.exec(l)![0].length;
}

function directiveBefore(lines: string[], at: number): ExampleDirective | undefined {
  for (let j = at - 1; j >= 0; j--) {
    const prev = lines[j]!.trim();
    if (!prev) continue;
    const m = SKIP_COMMENT.exec(prev);
    if (!m) return undefined;
    return m[1] && /expect|raises/i.test(m[1]) ? 'expect-error' : 'skip';
  }
  return undefined;
}

/** The indented block after `start` (blank lines inside allowed), dedented; [code, firstLine, lastLine] (0-based). */
function indentedBlock(lines: string[], start: number, parentIndent: number): { code: string; first: number; last: number } | undefined {
  let i = start;
  while (i < lines.length && !lines[i]!.trim()) i++;
  if (i >= lines.length || lineIndent(lines[i]!) <= parentIndent) return undefined;
  const first = i;
  let last = i;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    if (lineIndent(l) <= parentIndent) break;
    last = i;
  }
  const block = lines.slice(first, last + 1);
  const strip = Math.min(...block.filter((l) => l.trim()).map(lineIndent));
  return { code: block.map((l) => l.slice(strip)).join('\n'), first, last };
}

const LANGS: Record<string, string> = { py: 'python', python3: 'python', pycon: 'python', py3: 'python', ipython: 'python', sh: 'bash', shell: 'bash', console: 'bash', bash: 'bash' };

export function scanRst(path: string, text: string): MdDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: MdSection[] = [];
  const examples: MdExample[] = [];
  const styles: string[] = [];
  const stack: string[] = [];
  const slugCounts = new Map<string, number>();
  const labels = new Map<string, string>();
  let pendingLabels: string[] = [];
  let title = '';
  let highlight = 'python';
  let current: MdSection = newSection('', '', 0, [], 1);
  const consumed = new Set<number>();

  const closeSection = (endLine: number) => {
    current.endLineno = endLine;
    current.body = lines.slice(current.lineno - 1, endLine).join('\n').trim();
    // A preamble of only labels, comments and directives (`.. _label:`, `.. module::`) is not prose.
    const prose = current.body.split('\n').filter((l) => l.trim() && !/^\s*\.\.\s/.test(l) && !/^\s+:/.test(l));
    if (current.level > 0 || prose.length > 0) sections.push(current);
  };
  const addExample = (lang: string, meta: string, block: { code: string; first: number; last: number }, at: number) => {
    examples.push({
      index: examples.length,
      lang,
      meta,
      code: block.code,
      lineno: block.first + 1,
      endLineno: block.last + 1,
      sectionAnchor: current.anchor,
      ...(directiveBefore(lines, at) ? { directive: directiveBefore(lines, at) } : {}),
    });
    for (let k = block.first; k <= block.last; k++) consumed.add(k);
  };

  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue;
    const line = lines[i]!;

    // Section title: text underlined (optionally overlined) with one punctuation character.
    const next = lines[i + 1];
    const over = ADORNMENT.test(line) && lines[i + 2] !== undefined && ADORNMENT.test(lines[i + 2]!) && lines[i + 1]!.trim() && lines[i + 2]![0] === line[0];
    const under = line.trim() && !ADORNMENT.test(line) && lineIndent(line) === 0 && next !== undefined && ADORNMENT.test(next) && next.trim().length >= Math.min(line.trim().length, 3);
    if (over || under) {
      const headingText = (over ? lines[i + 1]! : line).trim().replace(/``([^`]*)``/g, '$1').replace(ROLE, (_, _r, t: string) => t.replace(/^[~!]/, ''));
      const style = `${over ? 'o' : 'u'}${(over ? line : next!)[0]}`;
      if (!styles.includes(style)) styles.push(style);
      const level = styles.indexOf(style) + 1;
      closeSection(i);
      stack.length = level - 1;
      stack[level - 1] = headingText;
      const base = slugify(headingText);
      const n = slugCounts.get(base) ?? 0;
      slugCounts.set(base, n + 1);
      const anchor = n === 0 ? base : `${base}-${n}`;
      if (!title) title = headingText;
      current = newSection(anchor, headingText, level, stack.filter(Boolean), i + 1);
      for (const l of pendingLabels) labels.set(l, anchor);
      pendingLabels = [];
      i += over ? 2 : 1;
      continue;
    }

    const label = LABEL.exec(line.trim());
    if (label) {
      pendingLabels.push(label[1]!.trim().toLowerCase());
      continue;
    }
    const hl = /^\s*\.\.\s+highlight::\s*(\S+)/.exec(line);
    if (hl) {
      highlight = LANGS[hl[1]!.toLowerCase()] ?? hl[1]!.toLowerCase();
      continue;
    }

    const code = CODE_DIRECTIVE.exec(line);
    if (code) {
      const indent = code[1]!.length;
      // Skip the directive's options (`:linenos:`, `:caption: x`).
      let j = i + 1;
      while (j < lines.length && /^\s+:[\w-]+:/.test(lines[j]!)) j++;
      const block = indentedBlock(lines, j, indent);
      if (block) {
        const kind = code[2]!;
        const raw = (code[3] ?? '').toLowerCase();
        const lang = ['testcode', 'doctest', 'testsetup', 'ipython', 'jupyter-execute'].includes(kind) ? 'python' : (LANGS[raw] ?? (raw || highlight));
        addExample(lang, kind === 'code-block' || kind === 'code' || kind === 'sourcecode' ? '' : kind, block, i);
        i = block.last;
      }
      continue;
    }

    // `Paragraph::` or a lone `::` introduces a literal block in the default highlight language.
    if (/::\s*$/.test(line) && !ANY_DIRECTIVE.test(line)) {
      const block = indentedBlock(lines, i + 1, lineIndent(line));
      if (block) {
        const lang = /^\s*\$ /m.test(block.code) ? 'bash' : highlight === 'python' ? (looksLikePython(block.code) ? 'python' : 'text') : highlight;
        addExample(lang, 'literal', block, i);
        i = block.last;
        // The paragraph's own text still counts below for inline code.
      }
    }

    // A doctest block: a paragraph starting with `>>>` at the current indentation.
    if (/^\s*>>>\s/.test(line)) {
      const indent = lineIndent(line);
      let j = i;
      while (j + 1 < lines.length && lines[j + 1]!.trim() && lineIndent(lines[j + 1]!) >= indent) j++;
      const block = { code: lines.slice(i, j + 1).map((l) => l.slice(indent)).join('\n'), first: i, last: j };
      addExample('python', 'doctest', block, i);
      i = j;
      continue;
    }

    for (const m of line.matchAll(/``([^`]+)``/g)) current.inlineCode.push({ text: m[1]!.trim(), line: i + 1 });
    for (const m of line.matchAll(ROLE)) {
      const role = m[1] ?? 'any';
      const target = m[2]!.replace(/^.*<([^>]+)>\s*$/, '$1').replace(/^[~!.]+/, '').trim();
      if (role === 'doc' || role === 'ref') {
        current.links.push({ target: role === 'doc' ? target : `#${target.toLowerCase()}`, line: i + 1 });
      } else if (role !== 'mod') {
        current.inlineCode.push({ text: role === 'func' || role === 'meth' ? `${target.replace(/\(\)$/, '')}()` : target, line: i + 1 });
      }
    }
  }
  closeSection(lines.length);

  if (!title) title = path.split('/').pop()!.replace(/\.rst$/i, '');
  for (const s of sections) {
    if (s.level === 0) {
      s.title = title;
      s.headingPath = [title];
    }
    // :ref: targets are labels; resolve them to the anchor of the section the label precedes.
    s.links = s.links.map((l) => (l.target.startsWith('#') && labels.has(l.target.slice(1)) ? { ...l, target: `#${labels.get(l.target.slice(1))}` } : l));
  }
  return { path, title, sections, examples };
}

function newSection(anchor: string, title: string, level: number, headingPath: string[], lineno: number): MdSection {
  return { anchor, title, level, headingPath, lineno, endLineno: lineno, body: '', inlineCode: [], links: [] };
}
