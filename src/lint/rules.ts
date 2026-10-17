import type { RuleId, Severity, Surface } from './types.js';

export interface RuleInfo {
  id: RuleId;
  severity: Severity;
  /** One line: what the rule reports. */
  summary: string;
  /** Why the drift matters to a reader or an agent. */
  why: string;
  /** A stale line the rule reports, and what it says. */
  example: { text: string; message: string };
  surfaces: Surface[];
  /** Whether Staleproof can propose a verified fix. */
  fixable: boolean;
  /** Not implemented yet: listed so configs that name it stay valid. */
  planned?: boolean;
}

const DOC_SURFACES: Surface[] = ['agent', 'readme', 'docs'];

/** Every rule, in the order reports and docs/rules.md list them. */
export const RULES: RuleInfo[] = [
  {
    id: 'path-missing',
    severity: 'error',
    summary: 'A code span names a file or directory of the repository that does not exist.',
    why: 'Readers and coding agents open the path, find nothing, and guess. Moved and deleted files are the most common drift in agent instructions.',
    example: { text: 'Config lives in `src/settings/defaults.ts`.', message: '`src/settings/defaults.ts` does not exist in the repository.' },
    surfaces: DOC_SURFACES,
    fixable: true,
  },
  {
    id: 'line-out-of-range',
    severity: 'warning',
    summary: 'A `path:line` reference points past the end of the file.',
    why: 'Line references rot as files shrink; the reader lands on the wrong code.',
    example: { text: 'See `src/cli.ts:812`.', message: '`src/cli.ts` has 523 lines; line 812 does not exist.' },
    surfaces: DOC_SURFACES,
    fixable: false,
  },
  {
    id: 'link-broken',
    severity: 'error',
    summary: 'A relative link points to a file that does not exist.',
    why: 'Broken links in docs and agent files send readers (and agents following them) nowhere.',
    example: { text: 'Read the [deploy guide](docs/deploy.md).', message: 'The link target `docs/deploy.md` does not exist.' },
    surfaces: DOC_SURFACES,
    fixable: true,
  },
  {
    id: 'anchor-missing',
    severity: 'warning',
    summary: 'A link to `#anchor` matches no heading in the target page.',
    why: 'Renamed headings silently break deep links: the page opens at the top.',
    example: { text: 'See [options](cli.md#global-flags).', message: '`cli.md` has no heading `#global-flags`.' },
    surfaces: DOC_SURFACES,
    fixable: true,
  },
  {
    id: 'command-missing',
    severity: 'error',
    summary: 'A documented command (`npm run x`, `make x`, `just x`, `uv run x`, ...) is not defined by the repository.',
    why: 'Setup and contributing steps are run verbatim, by people and by agents; a renamed script fails the first step.',
    example: { text: 'Run `npm run lint:docs` before pushing.', message: '`lint:docs` is not a script in package.json.' },
    surfaces: DOC_SURFACES,
    fixable: true,
    planned: true,
  },
  {
    id: 'cli-command-unknown',
    severity: 'error',
    summary: "The repository's own CLI is shown with a subcommand it does not have.",
    why: 'CLI docs drift with every rename; users copy the command and get a usage error.',
    example: { text: '`mytool sync --all`', message: '`mytool` has no command `sync` (commands: pull, push).' },
    surfaces: DOC_SURFACES,
    fixable: true,
    planned: true,
  },
  {
    id: 'cli-flag-unknown',
    severity: 'error',
    summary: "The repository's own CLI is shown with an option it does not accept.",
    why: 'Removed and renamed flags are a classic source of copy-paste failures.',
    example: { text: '`mytool push --force-all`', message: '`mytool push` has no option `--force-all`.' },
    surfaces: DOC_SURFACES,
    fixable: true,
    planned: true,
  },
  {
    id: 'env-unused',
    severity: 'warning',
    summary: 'A documented environment variable is never read by the code.',
    why: 'Users set it and nothing changes; usually the variable was renamed.',
    example: { text: 'Set `DATABASE_URI` to your database.', message: '`DATABASE_URI` is documented but no code reads it.' },
    surfaces: [...DOC_SURFACES, 'config'],
    fixable: true,
    planned: true,
  },
  {
    id: 'env-undocumented',
    severity: 'info',
    summary: "The code reads an environment variable the repository's env file does not list.",
    why: 'New settings that never reach `.env.example` are found by reading the source.',
    example: { text: 'process.env.REDIS_TLS', message: '`REDIS_TLS` is read in src/db.ts but not listed in .env.example.' },
    surfaces: ['config'],
    fixable: false,
    planned: true,
  },
  {
    id: 'symbol-missing',
    severity: 'error',
    summary: 'A code span names a member of a repository class or module that does not exist.',
    why: 'Prose that names `Client.query_v2` after it was renamed teaches readers and agents an API that is gone.',
    example: { text: 'Call `Client.query_v2()`.', message: '`Client` has no member `query_v2`.' },
    surfaces: DOC_SURFACES,
    fixable: true,
    planned: true,
  },
  {
    id: 'docstring-param-unknown',
    severity: 'error',
    summary: "A docstring documents a parameter the function's signature does not have.",
    why: 'Docstrings feed IDE hovers, API reference sites and agents; a renamed parameter makes them wrong everywhere.',
    example: { text: 'Args:\n    timeout_ms: ...', message: '`connect` has no parameter `timeout_ms` (parameters: host, port, timeout).' },
    surfaces: ['docstring'],
    fixable: true,
    planned: true,
  },
  {
    id: 'docstring-param-undocumented',
    severity: 'info',
    summary: 'A docstring documents some parameters but not all of them.',
    why: 'Partly documented signatures usually mean a parameter was added without its docs.',
    example: { text: 'def connect(host, port, tls): """Args: host, port"""', message: '`connect` documents host, port but not `tls`.' },
    surfaces: ['docstring'],
    fixable: false,
    planned: true,
  },
  {
    id: 'example-unknown-keyword',
    severity: 'error',
    summary: 'A docs code example passes a keyword argument the function does not accept.',
    why: 'The example raises a TypeError when copied.',
    example: { text: 'Client(hostname="db.local")', message: '`Client` has no parameter `hostname`.' },
    surfaces: ['example'],
    fixable: true,
  },
  {
    id: 'example-too-many-arguments',
    severity: 'error',
    summary: 'A docs code example passes more positional arguments than the function takes.',
    why: 'The example raises a TypeError when copied.',
    example: { text: 'g.query("MATCH (n) RETURN n", {}, 30)', message: '`Graph.query` takes at most 2 positional arguments; the example passes 3.' },
    surfaces: ['example'],
    fixable: false,
  },
  {
    id: 'example-missing-argument',
    severity: 'error',
    summary: 'A docs code example leaves out a required argument.',
    why: 'The example raises a TypeError when copied.',
    example: { text: 'UserList.as_view()', message: '`View.as_view` requires `name`.' },
    surfaces: ['example'],
    fixable: false,
  },
  {
    id: 'example-missing-import',
    severity: 'error',
    summary: 'A docs code example imports a name the package does not export.',
    why: 'The example fails at its first line.',
    example: { text: 'from miniclient import connect', message: '`miniclient` has no `connect`.' },
    surfaces: ['example'],
    fixable: true,
  },
  {
    id: 'example-missing-attribute',
    severity: 'error',
    summary: 'A docs code example calls an attribute the class or module does not have.',
    why: 'The example raises an AttributeError when copied.',
    example: { text: 'client.create_constraint(...)', message: '`FalkorDB` has no attribute `create_constraint`.' },
    surfaces: ['example'],
    fixable: true,
  },
  {
    id: 'example-removed',
    severity: 'error',
    summary: 'A docs code example calls a symbol that was removed.',
    why: 'The example fails when copied.',
    example: { text: 'legacy_connect()', message: '`legacy_connect` was removed.' },
    surfaces: ['example'],
    fixable: true,
  },
];

export const RULE_BY_ID = new Map<RuleId, RuleInfo>(RULES.map((r) => [r.id, r]));

export function isRuleId(x: string): x is RuleId {
  return RULE_BY_ID.has(x as RuleId);
}
