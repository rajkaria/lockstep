import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyFile, git } from '../indexer/repo.js';
import { workingFiles } from '../lint/engine.js';
import { isAgentFile } from '../lint/files.js';
import { gitRoot } from '../lint/sources.js';

export type Language = 'Python' | 'TypeScript' | 'JavaScript' | 'Go';

/** What `staleproof init` finds in a repository before it offers anything. */
export interface Detected {
  root: string;
  /** `owner/name` from the origin remote. */
  repo?: string;
  languages: Language[];
  /** Top-level folders of docs pages. */
  docsDirs: string[];
  agentFiles: string[];
  /** The root README, when there is one. */
  readme?: string;
  python: boolean;
  /** `package.json` at the root. */
  node: boolean;
  /** Staleproof is a dependency of the root package (`npx --no-install` finds it). */
  staleproofDependency: boolean;
  preCommitConfig?: string;
  lefthook?: string;
  husky: boolean;
  claude: boolean;
  cursor: boolean;
  /** A separate docs repository the README links to (a guess: init asks before using it). */
  docsRepoGuess?: string;
}

const DOCS_DIR = /^(docs?|documentation|website|site|guides?|book)$/i;

function originRepo(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** A GitHub repository the README links to that looks like this project's docs (`acme/docs`, `acme/x-docs`, `acme/acme.github.io`). */
export function guessDocsRepo(readme: string, repo?: string): string | undefined {
  const owner = repo?.split('/')[0]?.toLowerCase();
  for (const m of readme.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/)#?\s"'>]|$)/g)) {
    const name = `${m[1]}/${m[2]}`;
    if (repo && name.toLowerCase() === repo.toLowerCase()) continue;
    if (owner && m[1]!.toLowerCase() !== owner) continue;
    if (/(^|[-_.])(docs?|documentation|website|site)$|\.github\.io$/i.test(m[2]!)) return name;
  }
  return undefined;
}

export async function detect(dir: string): Promise<Detected> {
  const root = (await gitRoot(dir)) ?? dir;
  const files = await workingFiles(root);
  const has = (p: string) => files.includes(p) || existsSync(join(root, p));
  const origin = (await git(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  const repo = originRepo(origin);

  const kinds = new Set(files.map((f) => classifyFile(f)));
  const ext = (re: RegExp) => files.some((f) => re.test(f) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(f));
  const languages: Language[] = [];
  if (kinds.has('python') || has('pyproject.toml') || has('setup.py')) languages.push('Python');
  if (ext(/\.(ts|tsx|mts|cts)$/)) languages.push('TypeScript');
  if (ext(/\.(js|jsx|mjs|cjs)$/) && !languages.includes('TypeScript')) languages.push('JavaScript');
  if (ext(/\.go$/)) languages.push('Go');

  const docsDirs = [...new Set(files.filter((f) => /\.(md|mdx|rst)$/i.test(f) && f.includes('/')).map((f) => f.split('/')[0]!))].filter((d) => DOCS_DIR.test(d)).sort();
  const agentFiles = files.filter((f) => isAgentFile(f)).sort();
  const readme = files.find((f) => /^readme\.(md|mdx|rst)$/i.test(f));
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    // No package.json, or not JSON.
  }
  const lefthook = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml'].find(has);
  const isDir = (p: string) => {
    try {
      return statSync(join(root, p)).isDirectory();
    } catch {
      return false;
    }
  };
  const readmeText = readme ? await readFile(join(root, readme), 'utf8').catch(() => '') : '';
  return {
    root,
    ...(repo ? { repo } : {}),
    languages,
    docsDirs,
    agentFiles,
    ...(readme ? { readme } : {}),
    python: languages.includes('Python'),
    node: has('package.json'),
    staleproofDependency: !!(pkg.dependencies?.staleproof ?? pkg.devDependencies?.staleproof),
    ...(has('.pre-commit-config.yaml') ? { preCommitConfig: '.pre-commit-config.yaml' } : {}),
    ...(lefthook ? { lefthook } : {}),
    husky: isDir('.husky'),
    claude: has('CLAUDE.md') || isDir('.claude'),
    cursor: has('.cursorrules') || isDir('.cursor'),
    ...(guessDocsRepo(readmeText, repo) ? { docsRepoGuess: guessDocsRepo(readmeText, repo) } : {}),
  };
}
