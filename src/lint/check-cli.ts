import type { RawFinding } from './engine.js';
import { historical, isPlaceholder, pageCommands, PY_TOOLS, type CommandCheckContext, type ShellCommand, type Word } from './check-commands.js';
import { cliFacts, type CliCommand, type CliFacts, type CliOption, type OwnCli } from './facts-cli.js';
import { closeNames, listNames, scriptFacts, upward, type ScriptFacts } from './facts-scripts.js';
import type { ScannedDoc } from './scan.js';

/**
 * `cli-command-unknown` and `cli-flag-unknown`: the repository's own CLI (a package.json
 * `bin`, a `[project.scripts]` entry point, `python -m pkg`, `npx <bin>`, `node dist/cli.js`)
 * shown in docs with a subcommand or an option its definition does not have. Only fully
 * static definitions are judged (src/lint/facts-cli.ts).
 */

/** Pages of an old version's docs. */
export const OLD_DOCS = /(^|\/)(versioned_docs|versioned_sidebars|legacy|archive[sd]?|v\d+(\.\d+)*|migrations?)\//i;

const EXAMPLE_DIR = /(^|\/)(examples?|samples?|tests?|benchmarks?|demos?|fixtures?|playground)\//;

interface Invocation {
  cli: OwnCli;
  /** The words that name the program (`npx -y staleproof`, `python -m pkg`). */
  prog: Word[];
  args: Word[];
}

const VERSIONED = /^(@?[^@\s]+)@(.+)$/;

/** The own CLI a command line runs, if any, and its arguments. */
function invocation(words: Word[], cf: CliFacts, sf: ScriptFacts, cmd: ShellCommand): Invocation | undefined {
  const at = (i: number) => words[i]?.text ?? '';
  const named = (name: string): OwnCli | undefined => {
    const m = VERSIONED.exec(name);
    // A pinned version (`npx tool@1.2.0`) is that version's CLI, not the code here.
    if (m && !/^(latest|next|canary|beta)$/.test(m[2]!)) return undefined;
    const bare = m ? m[1]! : name;
    return cf.byName.get(bare) ?? cf.byPackage.get(bare);
  };
  const from = (i: number, cli: OwnCli | undefined): Invocation | undefined => (cli ? { cli, prog: words.slice(0, i + 1), args: words.slice(i + 1) } : undefined);
  const head = at(0);
  const direct = cf.byName.get(head);
  if (direct) return from(0, direct);
  /** Skip a runner's options (and the values of those that take one). */
  const skip = (i: number, valueFlags: RegExp): number => {
    while (i < words.length && at(i).startsWith('-') && at(i) !== '--') i += valueFlags.test(at(i)) && !at(i).includes('=') ? 2 : 1;
    if (at(i) === '--') i++;
    return i;
  };
  if (head === 'npx' || head === 'bunx' || head === 'pnpx') {
    let i = 1;
    let pkg: string | undefined;
    while (at(i).startsWith('-') && at(i) !== '--') {
      if (/^(-p|--package)$/.test(at(i))) pkg = at(++i);
      else if (at(i).startsWith('--package=')) pkg = at(i).slice(10);
      else if (/^(-c|--call)$/.test(at(i))) return undefined;
      i++;
    }
    if (at(i) === '--') i++;
    if (pkg && !named(pkg)) return undefined;
    if (/^(tsx|ts-node|node)$/.test(at(i))) return scriptRun(words, i, cf);
    return from(i, named(at(i)));
  }
  if ((head === 'npm' && /^(exec|x)$/.test(at(1))) || (head === 'pnpm' && /^(exec|dlx)$/.test(at(1))) || (head === 'yarn' && /^(dlx|exec)$/.test(at(1))) || (head === 'bun' && at(1) === 'x')) {
    const i = skip(2, /^(-p|--package|-c|--call|-C|--dir|--filter|-F)$/);
    if (/^(tsx|ts-node|node)$/.test(at(i))) return scriptRun(words, i, cf);
    return from(i, named(at(i)));
  }
  if ((head === 'pnpm' || head === 'yarn') && cf.byName.has(at(1))) {
    // `yarn tool sub` runs the bin unless a script of that name exists.
    const pkgs = cmd.cwd ? upward(cmd.cwd.dir).map((d) => sf.packageByDir.get(d)).filter((p) => !!p) : [];
    if (pkgs.some((p) => p.scripts.has(at(1)))) return undefined;
    return from(1, cf.byName.get(at(1)));
  }
  if ((head === 'pnpm' || head === 'yarn') && /^(tsx|ts-node|node)$/.test(at(1))) return scriptRun(words, 1, cf);
  if (head === 'uvx' || head === 'pipx' || (head === 'uv' && /^(run|tool)$/.test(at(1))) || ((head === 'poetry' || head === 'hatch' || head === 'pdm') && at(1) === 'run')) {
    let i = head === 'uvx' ? 1 : head === 'pipx' ? (at(1) === 'run' ? 2 : -1) : head === 'uv' && at(1) === 'tool' ? (at(2) === 'run' ? 3 : -1) : 2;
    if (i < 0) return undefined;
    let fromPkg: string | undefined;
    while (at(i).startsWith('-') && at(i) !== '--') {
      if (at(i) === '-m' || at(i) === '--module') return from(i + 1, cf.byName.get(`python -m ${at(i + 1)}`));
      if (at(i) === '--from') fromPkg = at(++i);
      else if (/^(--with|-w|--with-editable|--with-requirements|--extra|--group|--only-group|--package|--directory|--project|--python|-p|--env-file|--index|--index-url|-e|--env|--spec)$/.test(at(i))) i++;
      i++;
    }
    if (at(i) === '--') i++;
    if (fromPkg && VERSIONED.test(fromPkg.replace(/\[.*\]/, '')) && !/@latest$/.test(fromPkg)) return undefined;
    if (/^(python(\d(\.\d+)?)?)$/.test(at(i)) && at(i + 1) === '-m') return from(i + 2, cf.byName.get(`python -m ${at(i + 2)}`));
    const name = at(i).replace(/\[.*\]$/, '');
    if (PY_TOOLS.has(name) && !cf.byName.has(name)) return undefined;
    return from(i, named(name));
  }
  if (/^(python(\d(\.\d+)?)?|py)$/.test(head)) {
    let i = 1;
    while (at(i).startsWith('-') && at(i) !== '-m') i += /^-[XW]$/.test(at(i)) ? 2 : 1;
    if (at(i) !== '-m') return undefined;
    return from(i + 1, cf.byName.get(`python -m ${at(i + 1)}`));
  }
  if (/^(node|tsx|ts-node|bun|deno|esno|jiti)$/.test(head)) return scriptRun(words, 0, cf);
  return undefined;
}

/** `node dist/cli.js`, `tsx src/cli.ts`, `bun run src/cli.ts`: the bin or source file of an own CLI. */
function scriptRun(words: Word[], i: number, cf: CliFacts): Invocation | undefined {
  const at = (k: number) => words[k]?.text ?? '';
  let k = i + 1;
  if (at(k) === 'run') k++;
  while (at(k).startsWith('-') && at(k) !== '--') k += /^(-r|--require|--import|--loader|--env-file|--tsconfig|--conditions|-C)$/.test(at(k)) ? 2 : 1;
  if (/^(-e|--eval|-p|--print)$/.test(at(k - 1))) return undefined;
  const cli = cf.byPath.get(at(k).replace(/^\.\//, ''));
  return cli ? { cli, prog: words.slice(0, k + 1), args: words.slice(k + 1) } : undefined;
}

const ALWAYS_KNOWN = new Set(['--help', '-h', '--version', '-V']);

/** The option `name` among a command and its parents (argparse also takes unambiguous prefixes). */
function findOption(chain: CliCommand[], name: string): CliOption | 'known' | undefined {
  for (const c of chain) for (const o of c.options) if (o.names.includes(name)) return o;
  if (ALWAYS_KNOWN.has(name)) return 'known';
  // `--no-x` for `--x` and the reverse: some frameworks accept it, and accepting it is the safe side.
  const neg = name.startsWith('--no-') ? `--${name.slice(5)}` : name.startsWith('--') ? `--no-${name.slice(2)}` : undefined;
  if (neg) for (const c of chain) for (const o of c.options) if (o.names.includes(neg)) return { names: [name], arity: 0 };
  if (name.startsWith('--') && chain.some((c) => c.abbrev)) {
    for (const c of chain) for (const o of c.options) if (o.names.some((n) => n.startsWith(name))) return o;
  }
  return undefined;
}

function subcommand(cmd: CliCommand, name: string): CliCommand | undefined {
  return cmd.commands.find((c) => c.name === name || c.aliases.includes(name));
}

function longNames(chain: CliCommand[]): string[] {
  return [...new Set(chain.flatMap((c) => c.options.flatMap((o) => o.names)))].filter((n) => n.startsWith('--') && !ALWAYS_KNOWN.has(n));
}

/** Judge one invocation: walk the subcommands, then check every option against the command reached. */
function judgeInvocation(inv: Invocation): RawFinding[] {
  const out: RawFinding[] = [];
  const { cli, args } = inv;
  let cmd = cli.root;
  const chain: CliCommand[] = [cli.root];
  const path = [cli.name];
  let argsSeen = false;
  let unsure = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (t === '--') break;
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      const name = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
      if (w.dynamic || /[<>{}[\]|]|\.\.\./.test(name)) continue;
      let opt = findOption(chain, name);
      let unknown: string | undefined;
      if (!opt && !name.startsWith('--') && name.length > 2) {
        // A cluster of short flags (`-abc`), or a short option with its value attached (`-ofile`).
        for (let k = 1; k < name.length; k++) {
          const o = findOption(chain, `-${name[k]}`);
          if (!o) {
            unknown = `-${name[k]}`;
            break;
          }
          opt = 'known';
          if (o !== 'known' && o.arity !== 0) break;
        }
      } else if (!opt) unknown = name;
      // Options of an open command (unknown options allowed, helpers we cannot follow) are not judged.
      // commander parses a program's options anywhere on the line; click, typer and argparse parse each
      // level's options right after its name, so there only the command reached (and passthrough above it) matters.
      const judged = cli.framework === 'commander' || cli.framework === 'yargs' ? chain.every((c) => c.staticOptions) : cmd.staticOptions && chain.every((c) => !c.passthrough);
      if (unknown && judged) {
        const longs = longNames(chain);
        const close = closeNames(unknown, longs);
        out.push({
          rule: 'cli-flag-unknown',
          span: w,
          subject: `${path.join(' ')} ${unknown}`,
          message: `\`${path.join(' ')}\` has no option \`${unknown}\`.`,
          looked: `options of \`${path.join(' ')}\` in ${cli.source} (${listNames(longs, 10)})`,
          target: cli.source,
          ...(close.length ? { candidates: close } : {}),
        });
        continue;
      }
      if (!opt || opt === 'known') continue;
      if (opt.arity === undefined) unsure = true;
      else if (opt.arity === 1 && !t.includes('=') && (name.startsWith('--') || name.length === 2)) {
        // The next word is the value; a value that names a subcommand makes the parse ambiguous.
        if (args[i + 1] && subcommand(cmd, args[i + 1]!.text)) unsure = true;
        i++;
      }
      continue;
    }
    // A positional word: a subcommand while the command has some and no argument came first.
    if (argsSeen || unsure || !cmd.commands.length) {
      argsSeen = true;
      continue;
    }
    if (isPlaceholder(w)) return out;
    const sub = subcommand(cmd, t);
    if (sub) {
      if (cmd.chain) unsure = true;
      cmd = sub;
      chain.unshift(sub);
      path.push(t);
      continue;
    }
    if (t === 'help' && cmd.helpCommand) return out;
    // `tool serve: listening on ...` is a log line, not a command.
    if (!cmd.staticCommands || cmd.acceptsArgs || /[^\w:.-]|:$/.test(t)) return out;
    const names = cmd.commands.flatMap((c) => [c.name, ...c.aliases]);
    const close = closeNames(t, names);
    out.push({
      rule: 'cli-command-unknown',
      span: w,
      subject: `${path.join(' ')} ${t}`,
      message: `\`${path.join(' ')}\` has no command \`${t}\` (commands: ${listNames(cmd.commands.map((c) => c.name), 12)}).`,
      looked: `commands of \`${path.join(' ')}\` in ${cli.source}`,
      target: cli.source,
      ...(close.length ? { candidates: close } : {}),
    });
    return out;
  }
  return out;
}

export async function checkCli(doc: ScannedDoc, ctx: CommandCheckContext): Promise<RawFinding[]> {
  if (OLD_DOCS.test(doc.path)) return [];
  const cf = await cliFacts(ctx.facts);
  if (!cf.byName.size) return [];
  const sf = await scriptFacts(ctx.facts);
  const out: RawFinding[] = [];
  for (const cmd of pageCommands(doc, ctx)) {
    const inv = invocation(cmd.words, cf, sf, cmd);
    if (!inv) continue;
    // An example's or a test's own CLI is judged only on pages next to it.
    if (EXAMPLE_DIR.test(`${inv.cli.dir}/`) && !doc.path.startsWith(`${inv.cli.dir}/`)) continue;
    for (const f of judgeInvocation(inv)) if (!historical(doc, f.span as Word, cmd.inline)) out.push(f);
  }
  return out;
}
