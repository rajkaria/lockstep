import type { ParsedRepo } from '../indexer/index.js';
import type { PyDef, PyModule } from '../indexer/python.js';
import { trustsSignature } from '../indexer/signature.js';
import type { RawFinding } from './engine.js';
import { closeNames, codeDoc, docParams, signatureParams, type DocParam, type PageFinding, type SigParams } from './facts-docstrings.js';
import { isSuppressed, type ScannedDoc } from './scan.js';

/** Markers the TypeScript reader puts in `decorators` that are not decorators. */
const TS_MARKERS = new Set(['internal', 'private', 'property', 'staticmethod']);
/** Never expected in a parameter list's docs. */
const RECEIVERS = new Set(['self', 'cls']);

interface Subject {
  def: PyDef;
  /** The function whose signature the docstring describes (a class docstring describes `__init__`). */
  sig: PyDef;
  label: string;
  /** The first parameter is the receiver (a method's `self`, a class's `__init__`). */
  bound: boolean;
}

/** What the docstring of `def` describes, if its signature can be trusted. */
function subjectOf(def: PyDef, mod: PyModule): Subject | undefined {
  const ts = mod.lang === 'ts';
  const owner = def.parent && def.parent !== mod.module ? def.parent.slice(def.parent.lastIndexOf('.') + 1) : undefined;
  if (def.kind === 'class') {
    // A class docstring's `Args:` describe the constructor, when the class defines it itself.
    if (ts || def.decorators.length) return undefined;
    const init = mod.defs.find((d) => d.qualname === `${def.qualname}.__init__`);
    return init ? { def, sig: init, label: def.name, bound: true } : undefined;
  }
  if (def.kind !== 'function' && def.kind !== 'method') return undefined;
  const label = owner && def.kind === 'method' ? `${owner}.${def.name}` : def.name;
  const isStatic = def.decorators.includes('staticmethod');
  return { def, sig: def, label, bound: !ts && def.kind === 'method' && !isStatic };
}

/** A decorator may change what the function accepts; overloads have several signatures. */
function trusted(s: Subject, mod: PyModule, source: string): boolean {
  const ts = mod.lang === 'ts';
  const decorators = ts ? s.sig.decorators.filter((d) => !TS_MARKERS.has(d)) : s.sig.decorators;
  if (!trustsSignature(decorators)) return false;
  if (!ts) return mod.defs.filter((d) => d.qualname === s.sig.qualname).length === 1;
  // TypeScript overload signatures (`function f(a: string): void;`) next to the implementation.
  const name = s.sig.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fn = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${name}\\s*[<(]`, 'gm');
  if (s.sig.kind === 'function') return (source.match(fn) ?? []).length <= 1;
  // Methods: overload signatures in the same class body.
  const cls = mod.defs.find((d) => d.qualname === s.sig.parent);
  const lines = source.split('\n').slice(cls ? cls.lineno - 1 : 0, s.sig.endLineno);
  const method = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|declare)\\s+)*${name}\\s*\\??\\s*[<(]`);
  return lines.filter((l) => method.test(l)).length <= 1;
}

/** The docstring with its parameter entries' names blanked: what its prose says. */
function docWithoutEntries(text: string, params: DocParam[]): string {
  const lines = text.split('\n');
  for (const p of params) {
    const l = lines[p.line];
    if (l !== undefined) lines[p.line] = l.slice(0, p.column) + ' '.repeat(p.stars.length + p.name.length) + l.slice(p.column + p.stars.length + p.name.length);
  }
  return lines.join('\n');
}

/** 1-based line and columns of a documented name in the code file. */
function locate(p: DocParam, s: Subject, lines: string[]): RawFinding['span'] {
  const docLines = s.def.docText!.split('\n');
  const lineNo = s.def.docLine! + p.line;
  const text = lines[lineNo - 1] ?? '';
  const written = `${p.stars}${p.name}`;
  // Later lines of a docstring are the source lines themselves; the first starts after the quotes.
  const offset = p.line === 0 ? Math.max(0, text.indexOf(docLines[0]!)) : 0;
  let at = text.indexOf(written, offset + p.column);
  if (at < 0) at = text.indexOf(written);
  const column = at >= 0 ? at + 1 : 1;
  return { text: written, line: lineNo, column, endColumn: column + written.length };
}

/** The finding is silenced by a comment on its line, or on the `def` (or the line before it and its decorators). */
function silenced(doc: ScannedDoc, s: Subject, rule: RawFinding['rule']): boolean {
  if (isSuppressed(doc, s.def.lineno, rule)) return true;
  for (let l = s.def.lineno - 1; l >= 1; l--) {
    if (!/^\s*@/.test(doc.lines[l - 1] ?? '')) break;
    if (isSuppressed(doc, l, rule)) return true;
  }
  return false;
}

/**
 * `docstring-param-unknown` and `docstring-param-undocumented`: every docstring of the
 * repository's own code (Python Google/NumPy/Sphinx docstrings, JSDoc/TSDoc comments)
 * against the signature it describes. Findings are located in the code file.
 */
export async function checkDocstrings(p: ParsedRepo, read: (path: string) => Promise<string | undefined>): Promise<PageFinding[]> {
  const out: PageFinding[] = [];
  for (const mod of p.modules) {
    const lang = mod.lang === 'ts' ? 'ts' : mod.lang === undefined || mod.lang === 'python' ? 'python' : undefined;
    if (!lang) continue;
    const documented = mod.defs.filter((d) => d.docText && d.docLine && (lang === 'ts' ? /@(param|arg|argument)\b/.test(d.docText) : /(Args|Arguments|Parameters|Params|Kwargs|Other Parameters|Other Args)\s*:?\s*\n|:(param|parameter|arg|argument|key|keyword|type)\s/.test(d.docText)));
    if (!documented.length) continue;
    const source = await read(mod.path);
    if (source === undefined) continue;
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const page = { target: { path: mod.path, surface: 'docstring' as const }, doc: codeDoc(mod.path, source), text: source };
    for (const def of documented) {
      const s = subjectOf(def, mod);
      if (!s || !trusted(s, mod, source)) continue;
      const sig = signatureParams(s.sig.signature, lang);
      if (!sig || sig.destructured) continue;
      const doc = docParams(def.docText!, lang);
      if (!doc.params.length) continue;
      for (const f of judge(s, sig, doc.params, doc.keywordSection, lines, mod.path, docWithoutEntries(def.docText!, doc.params))) {
        if (!silenced(page.doc, s, f.rule)) out.push({ page, f });
      }
    }
  }
  return out;
}

function judge(s: Subject, sig: SigParams, params: DocParam[], keywordSection: boolean, lines: string[], path: string, docText: string): RawFinding[] {
  const out: RawFinding[] = [];
  const declared = sig.names.slice(s.bound ? 1 : 0);
  // `_controller`: a parameter marked unused keeps its documented name.
  const known = new Set([...sig.names, ...sig.names.map((n) => n.replace(/^_+/, '')), ...(sig.varArgs ? [sig.varArgs] : []), ...(sig.varKw ? [sig.varKw] : [])]);
  // `(args: { ulid: string; model: string })` documented as `@param ulid`: the properties of an inline object type.
  const fields = new Set(Object.values(sig.types ?? {}).flatMap((t) => (t.startsWith('{') ? [...t.matchAll(/[{;,\s](?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/g)].map((m) => m[1]!) : [])));
  const looked = `the signature of \`${s.label}\` (${path}:${s.sig.lineno})`;
  const shownParams = [...declared, ...(sig.varArgs ? [`*${sig.varArgs}`] : []), ...(sig.varKw ? [`**${sig.varKw}`] : [])];
  const named = params.filter((x) => !x.dotted);
  // `@param options.tools` documents `options`, through its properties.
  const documentedNames = new Set([...named.map((x) => x.name), ...params.filter((x) => x.dotted).map((x) => x.name.split(/[.[]/)[0]!)]);
  // A context the framework injects (pydantic-ai's `RunContext`, an MCP `Context`) is not the caller's to pass.
  const injected = (n: string) => /^(?:\w+\.)*(?:RunContext|Context|ToolContext|CallbackContext)\b/.test(sig.types?.[n] ?? '');
  const undocumented = declared.filter((n) => !documentedNames.has(n) && !RECEIVERS.has(n) && !n.startsWith('_') && !injected(n));

  // Names the signature lacks. `*args`/`...rest` may take any of them; `**kwargs` the keyword ones
  // (all of them, unless a separate keyword section says which are keywords).
  const renamed = new Set<string>();
  // A bare `_` parameter takes any documented name.
  if (!sig.varArgs && (!sig.varKw || keywordSection) && !sig.names.some((n) => /^_+\d*$/.test(n))) {
    for (const x of named) {
      if (known.has(x.name) || fields.has(x.name) || (sig.varKw && x.section === 'keyword')) continue;
      const candidates = [...new Set([...closeNames(x.name, undocumented), ...closeNames(x.name, declared)])];
      if (undocumented.length === 1 && !candidates.includes(undocumented[0]!)) candidates.push(undocumented[0]!);
      if (candidates.length === 1 && undocumented.includes(candidates[0]!)) renamed.add(candidates[0]!);
      out.push({
        rule: 'docstring-param-unknown',
        span: locate(x, s, lines),
        subject: `${s.label}(${x.name})`,
        message: `\`${s.label}\` has no parameter \`${x.name}\` (parameters: ${shownParams.join(', ') || 'none'}).`,
        looked,
        target: `${path}:${s.sig.lineno}`,
        ...(candidates.length ? { candidates } : {}),
      });
    }
  }

  // Some parameters documented, others not (a parameter added without its docs). A docstring that
  // documents only a few on purpose is not that; nor is a parameter its prose already names.
  const prose = new Set(undocumented.filter((n) => new RegExp(`(?<![\\w.])${n}(?![\\w])`).test(docText)));
  const judged = declared.filter((n) => !RECEIVERS.has(n) && !n.startsWith('_') && !injected(n));
  const covered = judged.filter((n) => documentedNames.has(n) || prose.has(n)).length;
  const documentsSome = declared.some((n) => documentedNames.has(n)) && covered * 2 >= judged.length;
  if (documentsSome) {
    const first = named.find((x) => declared.includes(x.name)) ?? named[0]!;
    const docs = declared.filter((n) => documentedNames.has(n));
    for (const n of undocumented) {
      if (renamed.has(n) || prose.has(n)) continue;
      out.push({
        rule: 'docstring-param-undocumented',
        span: locate(first, s, lines),
        subject: `${s.label}(${n})`,
        message: `\`${s.label}\` documents ${docs.join(', ')} but not \`${n}\`.`,
        looked,
        target: `${path}:${s.sig.lineno}`,
      });
    }
  }
  return out;
}
