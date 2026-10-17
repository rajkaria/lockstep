import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { SymbolTable } from '../src/indexer/resolve.js';
import { arityOf } from '../src/indexer/signature.js';
import { extractTs } from '../src/indexer/typescript.js';
import { lintRepo } from '../src/lint/engine.js';
import { diffWith } from '../src/pr/changes.js';
import { analyzeChanges, contentSource, WORKTREE } from '../src/pr/local.js';
import { FIXTURES, testConfig, testGraph } from './helpers.js';

const ARITY = { repo: 'acme/arity', dir: join(FIXTURES, 'ts-arity'), sha: 'fixture' };

const show = (a: { params: { name: string; required: boolean }[]; varArgs: boolean } | undefined) =>
  a ? `${a.params.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')}${a.varArgs ? ' ...' : ''}` : 'unknown';

describe('JS/TS arity', () => {
  it('reads parameters as TypeScript checks them: optional, defaults, rest, destructured, `this`', async () => {
    const mod = await extractTs(
      `export function f(this: Foo, a: string, b?: number, c = 1, { d, e }: Opts = {}, [x]: T, ...rest: string[]) {}
export function g(a: string): void;
export function g(a: number): void;
export function g(a: any) {}
export function h() { return arguments.length; }
export function k() { return function inner() { return arguments; }; }
export const arrow = async (a: string, b: string | undefined) => a;
export const one = x => x;
export class C {
  constructor(private p: string) {}
  m(a: string): void;
  m(a: number): void;
  m(a: any) {}
  @memo()
  dec(a: string) {}
  static s(a: string, b?: string) {}
}
`,
      { module: 'js-p', path: 'src/p.ts' },
    );
    const arity = (q: string) => show(mod.defs.find((d) => d.qualname === `js-p.${q}`)?.arity);
    expect(arity('f')).toBe('a, b?, c?, { d, e }?, [x] ...');
    expect(arity('g')).toBe('a');
    expect(mod.defs.find((d) => d.qualname === 'js-p.g')!.decorators).toEqual(['overload']);
    expect(arity('h')).toBe('unknown');
    expect(arity('k')).toBe('');
    expect(arity('arrow')).toBe('a, b?');
    expect(arity('one')).toBe('unknown');
    expect(arity('C.constructor')).toBe('p');
    expect(mod.defs.find((d) => d.qualname === 'js-p.C.m')!.decorators).toEqual(['overload']);
    expect(arity('C.dec')).toBe('unknown');
    expect(arity('C.s')).toBe('a, b?');
  });

  it('leaves every parameter of a JavaScript file optional', async () => {
    const mod = await extractTs('export function legacy(a, b = 1, ...more) {}', { module: 'js-p.legacy', path: 'src/legacy.js', tsx: true });
    expect(show(mod.defs.find((d) => d.kind === 'function')!.arity)).toBe('a?, b? ...');
  });

  it('records what each call passes: the count, a spread, nothing for a tagged template', async () => {
    const mod = await extractTs("f(1, ...xs);\ntag`x ${1}`;\na?.b(1, 2);\nnew K(1);\nnew K;\ng(/* none */);\n", { module: 'x', path: 'x.ts' });
    expect(mod.calls.map((c) => `${c.text} ${c.args ? `${c.args.positional}${c.args.starArgs ? '+' : ''}` : '-'}`)).toEqual(['f 1+', 'tag -', 'a?.b 2', 'K 1', 'K 0', 'g 0']);
  });

  it('parses stored TypeScript signatures back into an arity', async () => {
    expect(show(await arityOf('async query(q: string, params?: Record<string, unknown>): Promise<unknown[]>', 'ts'))).toBe('q, params?');
    expect(show(await arityOf('function connect(url: string, opts = {}): Client', 'ts'))).toBe('url, opts?');
    expect(show(await arityOf('(host: string, port = 6379) =>', 'ts'))).toBe('host, port?');
    expect(show(await arityOf('static open(name: string): Graph', 'ts'))).toBe('name');
    expect(show(await arityOf('function legacy(a, b)', 'ts', 'src/legacy.js'))).toBe('a?, b?');
  });

  it('flags JS/TS examples that pass too many or too few arguments (lint)', async () => {
    const r = await lintRepo({ dir: ARITY.dir, repo: ARITY.repo });
    expect(r.findings.filter((f) => f.rule.startsWith('example-') && f.path === 'docs/api.md').map((f) => `L${f.line}:${f.column} ${f.rule} ${f.message}`)).toEqual([
      'L6:11 example-too-many-arguments `connect` takes at most 2 arguments; the example passes 3.',
      'L8:1 example-too-many-arguments `Graph.query` takes at most 2 arguments; the example passes 3.',
      'L9:15 example-missing-argument `Graph` requires `name`, which the example does not pass.',
      'L10:1 example-too-many-arguments `Graph.open` takes at most 1 argument; the example passes 2.',
      'L14:1 example-missing-argument `ping` requires `host`, which the example does not pass.',
      'L15:1 example-too-many-arguments `ping` takes at most 2 arguments; the example passes 3.',
      'L17:1 example-too-many-arguments `legacy` takes at most 2 arguments; the example passes 3.',
    ]);
  });

  it('reads a block that lists a package’s functions as names, and leaves older and translated docs alone', async () => {
    const r = await lintRepo({ dir: ARITY.dir, repo: ARITY.repo });
    const others = r.findings.filter((f) => f.rule.startsWith('example-') && f.path !== 'docs/api.md');
    // `a.select(); a.connect(); a.ping();` names three functions; `g.query()` on an object is a call.
    // docs/guide-v1/ (next to docs/guide/) and docs/README_KO.md call `select()` too, and are not judged.
    expect(others.map((f) => `${f.path}:${f.line} ${f.rule}`)).toEqual(['docs/listing.md:21 example-missing-argument']);
  });
});

describe('a value typed with a base class may be a subclass', () => {
  it('leaves calls a subclass override accepts, and attributes a subclass defines, unjudged', async () => {
    const lib = await extractTs(
      `export class Base { run(a: string): void {} stop(): void {} }
export class Fast extends Base { run(a: string, b?: number): void {} turbo(): void {} }
export function make(): Base { return new Fast(); }
`,
      { module: 'js-lib', path: 'src/index.ts' },
    );
    const table = new SymbolTable();
    table.add('acme/lib', lib);
    const ex = await extractTs(
      "import { make } from 'lib';\nconst m = make();\nm.run('a', 2);\nm.run('a', 2, 3);\nm.turbo();\nm.stop(1);\nm.gone();\n",
      { module: 'ex', path: 'docs/a.md' },
    );
    const dispose = table.addEphemeral('acme/docs', ex);
    const found = table.checkModule('acme/docs', ex).map((m) => `${m.line} ${m.kind} ${m.detail}`);
    dispose();
    expect(found).toEqual([
      '4 too-many-arguments `Base.run` takes at most 1 argument; the example passes 3',
      '6 too-many-arguments `Base.stop` takes no arguments; the example passes 1',
      '7 missing-attribute `Base` has no attribute `gone`',
    ]);
  });
});

describe('JS/TS signature changes predict the examples they break (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('jsarity'));
    await indexOrg(graph, [ARITY]);
  });
  afterAll(async () => done());

  it('a new required parameter breaks a call that fit the old signature', async () => {
    const path = 'src/index.ts';
    const original = await readFile(join(ARITY.dir, path), 'utf8');
    const edited = original.replace('export function select(name: string): Graph {', 'export function select(name: string, mode: string): Graph {');
    const all = ['package.json', path, 'src/legacy.js', 'docs/api.md'];
    const src = contentSource(all, [{ path, content: edited }], async (p) => readFile(join(ARITY.dir, p), 'utf8').catch(() => undefined));
    const diff = await diffWith(src, ARITY.repo, 'base', WORKTREE);
    expect(diff.symbols.map((s) => `${s.change} ${s.qualname}`)).toEqual(['signature js-acme-arity.select']);
    const r = await analyzeChanges(graph, testConfig().home, ARITY.repo, diff, { url: 'local', title: 't' });
    expect(r.data.impact.predicted.map((p) => `${p.example} L${p.line} ${p.kind}: ${p.detail}`)).toEqual([
      'acme/arity:docs/api.md:0 L20 missing-argument: `select` requires `mode`, which the example does not pass',
      'acme/arity:docs/guide/index.md:0 L6 missing-argument: `select` requires `mode`, which the example does not pass',
    ]);
  });
});
