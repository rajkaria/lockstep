import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRepo, workingFiles } from '../src/lint/engine.js';
import { RepoFacts } from '../src/lint/facts.js';
import { cliFacts, commanderFlags, type CliCommand, type CliFacts } from '../src/lint/facts-cli.js';

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-cli-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

async function model(files: Record<string, string>): Promise<CliFacts> {
  const dir = await repo(files);
  return cliFacts(new RepoFacts(dir, new Set(await workingFiles(dir))));
}

/** A compact picture of a command tree: `name[aliases] flags :: options` and its subcommands, indented. */
function tree(c: CliCommand, depth = 0): string[] {
  const flags = [c.staticCommands ? '' : '!cmds', c.staticOptions ? '' : '!opts', c.acceptsArgs ? 'args' : '', c.helpCommand ? 'help' : '', c.abbrev ? 'abbrev' : ''].filter(Boolean).join(' ');
  const opts = c.options.map((o) => o.names.join('|') + (o.arity === 1 ? '=' : o.arity === undefined ? '?' : '')).join(' ');
  const head = `${'  '.repeat(depth)}${c.name || '(root)'}${c.aliases.length ? `[${c.aliases.join(',')}]` : ''}${flags ? ` (${flags})` : ''}${opts ? ` :: ${opts}` : ''}`;
  return [head, ...c.commands.flatMap((s) => tree(s, depth + 1))];
}

async function lint(files: Record<string, string>): Promise<string[]> {
  const dir = await repo(files);
  const r = await lintRepo({ dir, repo: 'acme/demo', examples: false, rules: ['cli-command-unknown', 'cli-flag-unknown'] });
  return r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.subject} | ${f.message}${f.evidence ? '' : ''}`);
}

const COMMANDER = {
  'package.json': JSON.stringify({ name: '@acme/tool', bin: { acme: 'dist/cli.js' }, dependencies: { commander: '15' } }),
  'src/cli.ts': [
    "import { Command, Option } from 'commander';",
    "import { syncCommand } from './commands/sync.js';",
    '',
    'const program = new Command();',
    "program.name('acme').version('1.0.0').option('--org <org>', 'graph').option('-q, --quiet');",
    '',
    'program',
    "  .command('index')",
    "  .argument('<repos...>')",
    "  .option('--ref <repo=ref>', 'a ref', collect, [])",
    "  .option('--no-cache')",
    "  .addOption(new Option('-f, --format <fmt>').choices(['text', 'json']))",
    "  .alias('ix')",
    '  .action(() => {});',
    '',
    "const db = program.command('db').description('local database');",
    "db.command('start').option('--port <port>').action(() => {});",
    "db.command('stop').action(() => {});",
    '',
    'program.addCommand(syncCommand());',
    "program.command('plugin', 'run a plugin executable');",
    "program.command('raw').allowUnknownOption().action(() => {});",
    'program.parse();',
    '',
    'function collect(v: string, prev: string[]) {',
    '  return [...prev, v];',
    '}',
  ].join('\n'),
  'src/commands/sync.ts': ["import { Command } from 'commander';", '', 'export function syncCommand() {', "  const cmd = new Command('sync');", "  cmd.option('--dry-run').option('-n, --limit <n>');", '  return cmd;', '}'].join('\n'),
};

describe('CLI definitions, read statically', () => {
  it('models a commander program: chains, variables, imported builders, options, aliases, executable and open subcommands', async () => {
    const cf = await model(COMMANDER);
    const cli = cf.byName.get('acme')!;
    expect(cli.framework).toBe('commander');
    expect(cli.source).toBe('src/cli.ts');
    expect(tree(cli.root)).toEqual([
      'acme (help) :: -V|--version --org= -q|--quiet',
      '  index[ix] (args) :: --ref= --no-cache -f|--format=',
      '  db (help)',
      '    start :: --port=',
      '    stop',
      '  sync :: --dry-run -n|--limit=',
      '  plugin (!cmds !opts)',
      '  raw (!opts)',
    ]);
    // `node dist/cli.js`, `tsx src/cli.ts` and `npx @acme/tool` reach it too.
    expect([...cf.byPath.keys()].sort()).toEqual(['dist/cli.js', 'src/cli.ts']);
    expect(cf.byPackage.get('@acme/tool')).toBe(cli);
  });

  it('reads commander flag strings', () => {
    expect(commanderFlags('-x, --xx <v>')).toEqual({ names: ['-x', '--xx'], arity: 1 });
    expect(commanderFlags('-c|--cheese [type]')).toEqual({ names: ['-c', '--cheese'], arity: undefined });
    expect(commanderFlags('--no-color')).toEqual({ names: ['--no-color'], arity: 0 });
    expect(commanderFlags('--with <dirs...>')).toEqual({ names: ['--with'], arity: undefined });
  });

  it('marks programs it cannot follow: computed names, helpers that receive commands, other frameworks', async () => {
    const cf = await model({
      'package.json': JSON.stringify({ name: 'x', bin: { a: 'a.js', b: 'b.js', c: 'c.js', d: 'd.js' } }),
      'a.js': "const { program } = require('commander');\nfor (const name of ['x', 'y']) program.command(name);\nprogram.command('z');\nprogram.parse();\n",
      'b.js': "import { program } from 'commander';\nimport { addAll } from 'some-plugin';\naddAll(program);\nprogram.parse();\n",
      'c.js': "import cac from 'cac';\nconst cli = cac();\ncli.command('x');\ncli.parse(process.argv);\n",
      'd.js': "#!/usr/bin/env node\nrequire('child_process').spawnSync('native-binary', process.argv.slice(2));\n",
    });
    expect(tree(cf.byName.get('a')!.root)).toEqual(['(root) (!cmds help)', '  z']);
    expect(tree(cf.byName.get('b')!.root)).toEqual(['(root) (!cmds !opts)']);
    expect([...cf.opaque].sort()).toEqual(['c', 'd']);
  });

  it('models click groups across modules, with add_command, custom decorators, cls= and plugin hooks', async () => {
    const cf = await model({
      'pyproject.toml': '[project]\nname = "acme"\n[project.scripts]\nacme = "acme.cli:cli"\nlazy = "acme.lazy:cli"\n',
      'acme/__init__.py': '',
      'acme/cli.py': [
        'import click',
        'from .extra import report',
        '',
        '@click.group(context_settings={"help_option_names": ["-h", "--help"]})',
        '@click.version_option()',
        '@click.option("--verbose/--quiet", "-v")',
        'def cli(verbose):',
        '    pass',
        '',
        '@cli.command()',
        '@click.argument("src")',
        '@click.option("--force", "-f", is_flag=True)',
        '@click.option("--depth", type=int, default=1)',
        'def copy_files(src, force, depth):',
        '    pass',
        '',
        '@cli.group("db")',
        'def database():',
        '    pass',
        '',
        '@database.command("migrate")',
        '@common_options',
        'def migrate():',
        '    pass',
        '',
        'cli.add_command(report, name="report")',
      ].join('\n'),
      'acme/extra.py': 'import click\nfrom .cli import cli\n\n@click.command()\n@click.option("--out")\ndef report(out):\n    pass\n\n@cli.command(name="serve")\n@click.option("--port")\ndef serve_cmd(port):\n    pass\n',
      'acme/lazy.py': 'import click\nfrom .plugins import pm\n\n@click.group(cls=LazyGroup)\ndef cli():\n    pass\n',
    });
    expect(tree(cf.byName.get('acme')!.root)).toEqual([
      'cli :: --version --verbose|--quiet|-v -h --help',
      '  copy-files[copy_files] (args) :: --force|-f --depth=',
      '  db',
      '    migrate (!opts)',
      '  report :: --out=',
      '  serve :: --port=',
    ]);
    // `@cli.group("db")` takes its name; `@common_options` (the project's own decorator) may add options to migrate.
    // A custom group class is open. (`serve`, registered on the other `cli` of this package, is counted too:
    // with re-exports in play, an extra known name is the safe side.)
    expect(tree(cf.byName.get('lazy')!.root)).toEqual(['cli (!cmds !opts)', '  serve :: --port=']);
  });

  it('models typer apps: commands from function names, parameters as options, callbacks, sub-apps, one-command apps', async () => {
    const cf = await model({
      'pyproject.toml': '[project]\nname = "acme"\n[project.scripts]\nacme = "acme.main:app"\nsolo = "acme.solo:main"\n',
      'acme/__init__.py': '',
      'acme/main.py': [
        'from typing import Annotated',
        'import typer',
        'from .users import users_app',
        '',
        'app = typer.Typer(add_completion=False)',
        'app.add_typer(users_app, name="users")',
        '',
        '@app.callback()',
        'def main(verbose: bool = False):',
        '    pass',
        '',
        '@app.command()',
        'def build_site(path: str, dry_run: bool = False, jobs: int = 2, out: Annotated[str, typer.Option("--output", "-o")] = "x"):',
        '    pass',
      ].join('\n'),
      'acme/users.py': 'import typer\n\nusers_app = typer.Typer()\n\n@users_app.command("add")\ndef add_user(name: str, admin: bool = typer.Option(False, "--admin/--no-admin")):\n    pass\n',
      'acme/solo.py': 'import typer\n\napp = typer.Typer()\n\n@app.command()\ndef run(force: bool = False):\n    pass\n\ndef main():\n    app()\n',
    });
    expect(tree(cf.byName.get('acme')!.root)).toEqual([
      '(root) :: --help --verbose|--no-verbose',
      '  build-site[build_site] (args) :: --help --dry-run|--no-dry-run --jobs= --output|-o=',
      '  users :: --help',
      '    add (args) :: --help --admin|--no-admin',
    ]);
    // One command and no callback: the command is the program.
    expect(tree(cf.byName.get('solo')!.root)).toEqual(['(root) (args) :: --help --install-completion --show-completion --help --force|--no-force', '  run :: --help --force|--no-force']);
  });

  it('models argparse: subparsers and aliases, parents, helpers, flags, abbreviations; parse_known_args lets options through', async () => {
    const cf = await model({
      'pyproject.toml': '[project]\nname = "acme"\n[project.scripts]\nacme = "acme.cli:main"\nloose = "acme.loose:main"\n',
      'acme/__init__.py': '',
      'acme/__main__.py': 'from .cli import main\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n',
      'acme/cli.py': [
        'import argparse',
        '',
        'def add_common(p):',
        '    p.add_argument("--json", action="store_true")',
        '',
        'def main(argv=None):',
        '    common = argparse.ArgumentParser(add_help=False)',
        '    common.add_argument("--config")',
        '    parser = argparse.ArgumentParser(prog="acme")',
        '    parser.add_argument("-v", "--verbose", action="count")',
        '    sub = parser.add_subparsers(dest="cmd")',
        '    run = sub.add_parser("run", aliases=["r"], parents=[common])',
        '    run.add_argument("--color", action=argparse.BooleanOptionalAction)',
        '    add_common(run)',
        '    sub.add_parser("list")',
        '    args = parser.parse_args(argv)',
        '    return 0',
      ].join('\n'),
      'acme/loose.py': 'import argparse\n\ndef main():\n    p = argparse.ArgumentParser()\n    p.add_argument("--x")\n    p.parse_known_args()\n',
    });
    const want = [
      '(root) (abbrev) :: -h|--help -v|--verbose',
      '  run[r] (abbrev) :: -h|--help --config= --color|--no-color --json',
      '  list (abbrev) :: -h|--help',
    ];
    expect(tree(cf.byName.get('acme')!.root)).toEqual(want);
    // The common parser has add_help=False but -h stays known anyway.
    expect(tree(cf.byName.get('python -m acme')!.root)).toEqual(want);
    expect(tree(cf.byName.get('loose')!.root)).toEqual(['(root) (!opts abbrev) :: -h|--help --x=']);
  });
});

describe('cli-command-unknown and cli-flag-unknown', () => {
  it('reports unknown subcommands and options of a commander CLI however it is invoked, skipping values', async () => {
    const out = await lint({
      ...COMMANDER,
      'README.md': [
        '```console',
        '$ acme index acme/x --ref acme/x=main --format json',
        '$ acme --org acme db start --port 6380',
        '$ acme db restart',
        '$ acme sync --dry-run --limit=5 --force',
        '$ npx -y @acme/tool indx',
        '$ node dist/cli.js db stop --all',
        '$ npx tsx src/cli.ts -qx index a',
        '$ acme help db',
        '$ acme plugin --anything',
        '$ acme raw --anything',
        '$ acme ix --no-cache --cache',
        '```',
      ].join('\n'),
    });
    expect(out).toEqual([
      'README.md:4:11 cli-command-unknown acme db restart | `acme db` has no command `restart` (commands: start, stop).',
      'README.md:5:33 cli-flag-unknown acme sync --force | `acme sync` has no option `--force`.',
      'README.md:6:21 cli-command-unknown acme indx | `acme` has no command `indx` (commands: index, db, sync, plugin, raw).',
      'README.md:7:28 cli-flag-unknown acme db stop --all | `acme db stop` has no option `--all`.',
      'README.md:8:22 cli-flag-unknown acme -x | `acme` has no option `-x`.',
    ]);
  });

  it('puts close names in the finding for fixes', async () => {
    const dir = await repo({ ...COMMANDER, 'README.md': '`acme snyc --dry-runn`\n' });
    const r = await lintRepo({ dir, repo: 'acme/demo', examples: false, rules: ['cli-command-unknown', 'cli-flag-unknown'] });
    expect(r.findings.map((f) => [f.rule, f.subject, f.evidence?.looked])).toEqual([['cli-command-unknown', 'acme snyc', 'commands of `acme` in src/cli.ts']]);
    const r2 = await lintRepo({ dir: await repo({ ...COMMANDER, 'README.md': '`acme sync --dry-runn`\n' }), repo: 'acme/demo', examples: false, rules: ['cli-flag-unknown'] });
    expect(r2.findings.map((f) => [f.subject, f.evidence?.looked])).toEqual([['acme sync --dry-runn', 'options of `acme sync` in src/cli.ts (--dry-run, --limit, --org, --quiet)']]);
  });

  it('never judges placeholders, pinned versions, log lines, old docs, history notes, or another project\'s same-named tool', async () => {
    const out = await lint({
      ...COMMANDER,
      'docs/a.md': [
        '`acme <command> --help`, `acme index <repo> --<flag>`, `acme $CMD`',
        '`npx @acme/tool@0.9.0 indx` is the old CLI.',
        'It logs `acme serve: listening on :8080`.',
        'The `--fast` option was removed: `acme index --fast` no longer works.',
        '`acme -- --anything`',
      ].join('\n'),
      'docs/v1/usage.md': '`acme oldcmd`\n',
      'examples/demo/package.json': JSON.stringify({ name: 'demo', bin: { demo: 'cli.js' } }),
      'examples/demo/cli.js': "import { program } from 'commander';\nprogram.command('run');\nprogram.parse();\n",
      'docs/b.md': '`demo start`\n',
      'examples/demo/README.md': '`demo start`\n',
    });
    expect(out).toEqual(['examples/demo/README.md:1:7 cli-command-unknown demo start | `demo` has no command `start` (commands: run).']);
  });

  it('checks click, typer and argparse CLIs through their console scripts, uv run and python -m', async () => {
    const out = await lint({
      'pyproject.toml': '[project]\nname = "acme"\n[project.scripts]\nacme = "acme.cli:main"\n',
      'acme/__init__.py': '',
      'acme/__main__.py': 'from .cli import main\nmain()\n',
      'acme/cli.py': [
        'import argparse',
        'def main():',
        '    parser = argparse.ArgumentParser()',
        '    parser.add_argument("--verbose", action="store_true")',
        '    sub = parser.add_subparsers()',
        '    run = sub.add_parser("run")',
        '    run.add_argument("--color", choices=["on", "off"])',
        '    parser.parse_args()',
      ].join('\n'),
      'README.md': ['```sh', 'acme run --col on', 'acme run --colour on', 'uv run acme start', 'python -m acme --verbose run', 'acme --verb run', '```'].join('\n'),
    });
    expect(out).toEqual([
      // argparse accepts unambiguous prefixes (`--col`, `--verb`).
      'README.md:3:10 cli-flag-unknown acme run --colour | `acme run` has no option `--colour`.',
      'README.md:4:13 cli-command-unknown acme start | `acme` has no command `start` (commands: run).',
    ]);
  });

  it('judges a click subcommand\'s options even when plugins may add commands to the group', async () => {
    const out = await lint({
      'pyproject.toml': '[project]\nname = "acme"\n[project.scripts]\nacme = "acme.cli:cli"\n',
      'acme/__init__.py': '',
      'acme/cli.py': 'import click\nfrom .hooks import pm\n\n@click.group()\ndef cli():\n    pass\n\npm.hook.register_commands(cli=cli)\n\n@cli.command()\n@click.option("--limit", type=int)\ndef logs(limit):\n    pass\n',
      'README.md': '`acme logs --limit 3 --json`, `acme plugin-cmd`\n',
    });
    expect(out).toEqual(['README.md:1:22 cli-flag-unknown acme logs --json | `acme logs` has no option `--json`.']);
  });
});
