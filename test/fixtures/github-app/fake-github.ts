import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import type { PrFindings } from '../../../src/agent/graph-check.js';
import { summarize } from '../../../src/lint/diff.js';
import type { Finding } from '../../../src/lint/types.js';

/**
 * A fake GitHub for the App's tests: the REST endpoints the App calls, kept in memory,
 * plus repositories backed by real git checkouts (tarballs, raw files, compare) for the
 * end-to-end check. Installation tokens are only handed out for a JWT signed with the
 * test key, and every repository call must carry one.
 */

export interface Call {
  method: string;
  url: string;
  path: string;
  body?: any;
  auth?: string;
}

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string };
  performed_via_github_app?: { id: number } | null;
}

export interface FakeCheckRun {
  id: number;
  repo: string;
  created: any;
  updates: any[];
  /** The merged state after every update. */
  state: any;
}

export interface GitRepo {
  dir: string;
  private: boolean;
  installation?: number;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body: string, status = 200) => new Response(body, { status });
const notFound = () => json({ message: 'Not Found' }, 404);

export function testKeys(): { privateKey: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), publicKey };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const gitBuf = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

export class FakeGitHub {
  calls: Call[] = [];
  tokens: string[] = [];
  /** Token lifetime handed out (ms). */
  tokenTtlMs = 3600_000;
  now = () => Date.now();
  checkRuns = new Map<number, FakeCheckRun>();
  /** Comments per `repo#number`. */
  comments = new Map<string, FakeComment[]>();
  reviews: { repo: string; number: number; body: any }[] = [];
  reviewComments = new Map<string, any[]>();
  issues = new Map<string, { number: number; title: string; body: string; state: string; comments: string[] }[]>();
  pulls = new Map<string, any>();
  /** `GET /pulls/{n}/files` answers, per `repo#number`. */
  pullFiles = new Map<string, { filename: string; status: string; patch?: string }[]>();
  /** File contents per `repo@ref:path` (when the repository is not git-backed). */
  files = new Map<string, string>();
  /** Branch heads per `repo:branch`. */
  refs = new Map<string, string>();
  /** Repositories each installation covers. */
  installationRepos = new Map<number, { full_name: string; private: boolean; default_branch: string }[]>();
  /** Which installation covers a repository (`GET /repos/{o}/{r}/installation`). */
  repoInstallation = new Map<string, number>();
  gitRepos = new Map<string, GitRepo>();
  createdTrees = new Map<string, { base: string; entries: any[] }>();
  blobs = new Map<string, string>();
  createdCommits = new Map<string, { tree: string; parents: string[]; message: string }>();
  refUpdates: { repo: string; branch: string; sha: string; force: boolean }[] = [];
  /** Make the next calls matching these fail with a status. */
  failures: { method: string; path: RegExp; status: number }[] = [];
  private nextId = 1000 + Math.floor(Math.random() * 1e6) * 10;

  constructor(
    readonly appId: string,
    readonly publicKey: KeyObject,
    readonly slug = 'staleproof-test',
  ) {}

  get botLogin(): string {
    return `${this.slug}[bot]`;
  }

  /** Requests whose path matches (method optional). */
  find(method: string | undefined, path: RegExp): Call[] {
    return this.calls.filter((c) => (!method || c.method === method) && path.test(c.path));
  }

  private verifyJwt(auth: string | undefined): boolean {
    const token = auth?.replace(/^Bearer /, '') ?? '';
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return false;
    const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), this.publicKey, Buffer.from(s, 'base64url'));
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const nowS = Math.floor(this.now() / 1000);
    return ok && header.alg === 'RS256' && payload.iss === this.appId && payload.exp > nowS && payload.iat <= nowS && payload.exp - payload.iat <= 600;
  }

  private tokenOk(auth: string | undefined): boolean {
    const t = auth?.replace(/^(Bearer|token) /, '');
    return !!t && this.tokens.includes(t);
  }

  private repoFiles(repo: string, ref: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of this.files) {
      const m = /^(.+?)@(.+?):(.+)$/.exec(k);
      if (m && m[1]!.toLowerCase() === repo.toLowerCase() && m[2] === ref) out.set(m[3]!, v);
    }
    return out;
  }

  private gitRepo(repo: string): GitRepo | undefined {
    return this.gitRepos.get(repo.toLowerCase());
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? undefined;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = `${url.pathname}${url.search}`;
    this.calls.push({ method, url: url.href, path: url.host === 'api.github.com' ? path : url.href, body, auth });
    const fail = this.failures.find((f) => f.method === method && f.path.test(path));
    if (fail) {
      this.failures.splice(this.failures.indexOf(fail), 1);
      return json({ message: 'fail' }, fail.status);
    }

    if (url.host === 'codeload.github.com') {
      const m = /^\/([^/]+\/[^/]+)\/tar\.gz\/(.+)$/.exec(url.pathname);
      const r = m && this.gitRepo(m[1]!);
      if (!r || r.private) return text('Not Found', 404);
      return this.archive(r, decodeURIComponent(m![2]!));
    }
    if (url.host === 'raw.githubusercontent.com') {
      const m = /^\/([^/]+\/[^/]+)\/([0-9a-f]{40}|[^/]+)\/(.+)$/.exec(url.pathname);
      const r = m && this.gitRepo(m[1]!);
      if (!r) return text('Not Found', 404);
      if (r.private && !this.tokenOk(auth)) return text('Not Found', 404);
      try {
        return text(git(r.dir, 'show', `${m![2]}:${decodeURIComponent(m![3]!)}`));
      } catch {
        return text('Not Found', 404);
      }
    }
    if (url.host !== 'api.github.com') return text('unexpected host', 599);

    const p = url.pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === 'POST') {
      if (!this.verifyJwt(auth)) return json({ message: 'A JSON web token could not be decoded' }, 401);
      const token = `ghs_test_${m[1]}_${this.tokens.length + 1}`;
      this.tokens.push(token);
      return json({ token, expires_at: new Date(this.now() + this.tokenTtlMs).toISOString() }, 201);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(p))) {
      if (!this.verifyJwt(auth)) return json({ message: 'bad jwt' }, 401);
      const id = this.repoInstallation.get(m[1]!.toLowerCase());
      return id ? json({ id }) : notFound();
    }
    // Everything else acts in repositories: an installation token is required.
    if (!this.tokenOk(auth)) return json({ message: 'Bad credentials' }, 401);

    if (p === '/installation/repositories') {
      const inst = Number(/^ghs_test_(\d+)_/.exec(auth!.replace(/^(Bearer|token) /, ''))?.[1]);
      const repos = this.installationRepos.get(inst) ?? [];
      return json({ total_count: repos.length, repositories: repos });
    }
    m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p);
    if (!m) return notFound();
    const repo = m[1]!;
    const rest = m[2] ?? '';
    const gitRepo = this.gitRepo(repo);
    let x: RegExpExecArray | null;

    if (rest === '' && method === 'GET') {
      const known = gitRepo ?? [...this.installationRepos.values()].flat().find((r) => r.full_name.toLowerCase() === repo.toLowerCase());
      return known ? json({ full_name: repo, private: gitRepo?.private ?? false, default_branch: 'main' }) : notFound();
    }
    if ((x = /^\/tarball\/(.+)$/.exec(rest))) {
      return gitRepo ? this.archive(gitRepo, decodeURIComponent(x[1]!)) : notFound();
    }
    if ((x = /^\/contents\/(.+)$/.exec(rest)) && method === 'GET') {
      const filePath = decodeURIComponent(x[1]!);
      const ref = url.searchParams.get('ref') ?? 'HEAD';
      if (gitRepo) {
        try {
          return text(git(gitRepo.dir, 'show', `${ref}:${filePath}`));
        } catch {
          return notFound();
        }
      }
      const v = this.files.get(`${repo.toLowerCase()}@${ref}:${filePath}`) ?? this.files.get(`${repo}@${ref}:${filePath}`);
      return v === undefined ? notFound() : text(v);
    }
    if (rest === '/check-runs' && method === 'POST') {
      if (!body?.name || !body?.head_sha) return json({ message: 'name and head_sha required' }, 422);
      const id = this.nextId++;
      this.checkRuns.set(id, { id, repo, created: body, updates: [], state: { ...body } });
      return json({ id }, 201);
    }
    if ((x = /^\/check-runs\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const run = this.checkRuns.get(Number(x[1]));
      if (!run) return notFound();
      if (body.output) {
        if (!body.output.title || !body.output.summary) return json({ message: 'output.title and output.summary are required' }, 422);
        if ((body.output.annotations?.length ?? 0) > 50) return json({ message: 'at most 50 annotations per request' }, 422);
        if (body.output.summary.length > 65535) return json({ message: 'summary too long' }, 422);
      }
      if (body.actions) {
        if (body.actions.length > 3) return json({ message: 'at most 3 actions' }, 422);
        for (const a of body.actions) if (a.label.length > 20 || a.description.length > 40 || a.identifier.length > 20) return json({ message: 'action too long' }, 422);
      }
      run.updates.push(body);
      run.state = { ...run.state, ...body, output: { ...run.state.output, ...body.output } };
      return json({ id: run.id });
    }
    if ((x = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const key = `${repo.toLowerCase()}#${x[1]}`;
      const list = this.comments.get(key) ?? [];
      if (method === 'GET') return json(this.page(list, url));
      const c: FakeComment = { id: this.nextId++, body: body.body, user: { login: this.botLogin }, performed_via_github_app: { id: Number(this.appId) } };
      list.push(c);
      this.comments.set(key, list);
      const issue = this.issueList(repo).find((i) => i.number === Number(x![1]));
      issue?.comments.push(body.body);
      return json(c, 201);
    }
    if ((x = /^\/issues\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      for (const list of this.comments.values()) {
        const c = list.find((y) => y.id === Number(x![1]));
        if (c) {
          c.body = body.body;
          return json(c);
        }
      }
      return notFound();
    }
    if (rest === '/issues' && method === 'GET') return json(this.page(this.issueList(repo).filter((i) => i.state === 'open'), url));
    if (rest === '/issues' && method === 'POST') {
      const list = this.issueList(repo);
      const issue = { number: list.length + 1, title: body.title, body: body.body, state: 'open', comments: [] as string[] };
      list.push(issue);
      return json(issue, 201);
    }
    if ((x = /^\/issues\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const issue = this.issueList(repo).find((i) => i.number === Number(x![1]));
      if (!issue) return notFound();
      Object.assign(issue, body);
      return json(issue);
    }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'GET') {
      const pull = this.pulls.get(`${repo.toLowerCase()}#${x[1]}`);
      return pull ? json(pull) : notFound();
    }
    if (rest === '/pulls' && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      return json(this.page([...this.pulls.entries()].filter(([k, v]) => k.startsWith(`${repo.toLowerCase()}#`) && (state === 'all' || v.state === state)).map(([, v]) => v), url));
    }
    if (rest === '/pulls' && method === 'POST') {
      const number = 1 + [...this.pulls.keys()].filter((k) => k.startsWith(`${repo.toLowerCase()}#`)).length;
      const sha = this.refs.get(`${repo.toLowerCase()}:${body.head}`) ?? '';
      const pull = { number, html_url: `https://github.com/${repo}/pull/${number}`, title: body.title, body: body.body, state: 'open', merged_at: null, head: { ref: body.head, sha, repo: { full_name: repo } }, base: { ref: body.base } };
      this.pulls.set(`${repo.toLowerCase()}#${number}`, pull);
      return json(pull, 201);
    }
    if ((x = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const pull = this.pulls.get(`${repo.toLowerCase()}#${x[1]}`);
      if (!pull) return notFound();
      Object.assign(pull, body);
      return json(pull);
    }
    if ((x = /^\/pulls\/(\d+)\/files$/.exec(rest))) {
      const key = `${repo.toLowerCase()}#${x[1]}`;
      const pull = this.pulls.get(key);
      // A git-backed repository's pull request: its files from git, as GitHub lists them.
      const files = this.pullFiles.get(key) ?? (gitRepo && pull ? this.diffFiles(gitRepo, pull.base.sha, pull.head.sha).files : []);
      return json(this.page(files, url));
    }
    if ((x = /^\/pulls\/(\d+)\/comments$/.exec(rest))) {
      const key = `${repo.toLowerCase()}#${x[1]}`;
      const list = this.reviewComments.get(key) ?? [];
      if (method === 'GET') return json(this.page(list, url));
      const c = { id: this.nextId++, ...body, user: { login: this.botLogin } };
      list.push(c);
      this.reviewComments.set(key, list);
      return json(c, 201);
    }
    if ((x = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) && method === 'POST') {
      const key = `${repo.toLowerCase()}#${x[1]}`;
      const list = this.reviewComments.get(key) ?? [];
      for (const c of body.comments ?? []) list.push({ id: this.nextId++, ...c, start_line: c.start_line ?? null, user: { login: this.botLogin } });
      this.reviewComments.set(key, list);
      this.reviews.push({ repo, number: Number(x[1]), body });
      return json({ id: this.nextId++, html_url: `https://github.com/${repo}/pull/${x[1]}#review` });
    }
    if ((x = /^\/pulls\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      for (const list of this.reviewComments.values()) {
        const c = list.find((y) => y.id === Number(x![1]));
        if (c) {
          c.body = body.body;
          return json(c);
        }
      }
      return notFound();
    }
    if ((x = /^\/commits\/([^/]+)\/pulls$/.exec(rest))) {
      return json([...this.pulls.entries()].filter(([k, v]) => k.startsWith(`${repo.toLowerCase()}#`) && v.head.sha === x![1] && v.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()).map(([, v]) => v));
    }
    if ((x = /^\/commits\/([0-9a-f]{40})$/.exec(rest)) && gitRepo) {
      const parents = git(gitRepo.dir, 'rev-list', '--parents', '-n', '1', x[1]!).trim().split(' ').slice(1);
      return json({ sha: x[1], parents: parents.map((sha) => ({ sha })) });
    }
    if ((x = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest)) && gitRepo) {
      const d = this.diffFiles(gitRepo, x[1]!, x[2]!);
      return json({ merge_base_commit: { sha: d.mergeBase }, files: d.files });
    }
    if ((x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const branch = decodeURIComponent(x[1]!);
      let sha = this.refs.get(`${repo.toLowerCase()}:${branch}`);
      if (!sha && gitRepo) {
        try {
          sha = git(gitRepo.dir, 'rev-parse', '--verify', `refs/heads/${branch}`).trim();
        } catch {
          sha = undefined;
        }
      }
      return sha ? json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }) : notFound();
    }
    if ((x = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const branch = decodeURIComponent(x[1]!);
      const key = `${repo.toLowerCase()}:${branch}`;
      let current = this.refs.get(key);
      if (!current && gitRepo) current = git(gitRepo.dir, 'rev-parse', '--verify', `refs/heads/${branch}`).trim();
      const commit = this.createdCommits.get(body.sha);
      if (!body.force && (!commit || !commit.parents.includes(current ?? ''))) return json({ message: 'Update is not a fast forward' }, 422);
      this.refs.set(key, body.sha);
      this.refUpdates.push({ repo, branch, sha: body.sha, force: !!body.force });
      return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      const key = `${repo.toLowerCase()}:${branch}`;
      if (this.refs.has(key)) return json({ message: 'Reference already exists' }, 422);
      this.refs.set(key, body.sha);
      this.refUpdates.push({ repo, branch, sha: body.sha, force: false });
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const sha = createHash('sha1').update(`blob ${body.content}`).digest('hex');
      this.blobs.set(sha, body.content);
      return json({ sha }, 201);
    }
    if ((x = /^\/git\/commits\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const made = this.createdCommits.get(x[1]!);
      if (made) return json({ sha: x[1], tree: { sha: made.tree }, parents: made.parents.map((sha) => ({ sha })) });
      if (gitRepo && /^[0-9a-f]{40}$/.test(x[1]!)) {
        const parents = git(gitRepo.dir, 'rev-list', '--parents', '-n', '1', x[1]!).trim().split(' ').slice(1);
        return json({ sha: x[1], tree: { sha: git(gitRepo.dir, 'rev-parse', `${x[1]}^{tree}`).trim() }, parents: parents.map((sha) => ({ sha })) });
      }
      return json({ sha: x[1], tree: { sha: `t_${x[1]}_` }, parents: [] });
    }
    if ((x = /^\/git\/trees\/(.+)$/.exec(rest)) && method === 'GET') {
      if (gitRepo && /^[0-9a-f]{40}$/.test(x[1]!)) {
        const out = git(gitRepo.dir, 'ls-tree', ...(url.searchParams.get('recursive') ? ['-r'] : []), x[1]!);
        const entries = out.trim().split('\n').filter(Boolean).map((l) => {
          const [meta, path] = l.split('\t') as [string, string];
          const [mode, type, sha] = meta.split(' ') as [string, string, string];
          return { path, type, mode, sha };
        });
        return json({ sha: x[1], truncated: false, tree: entries });
      }
      const tm = /^t_([^_]+)_(.*)$/.exec(x[1]!);
      if (!tm) return notFound();
      const dir = Buffer.from(tm[2]!, 'hex').toString();
      const entries = new Map<string, any>();
      for (const filePath of this.repoFiles(repo, tm[1]!).keys()) {
        if (dir && !filePath.startsWith(`${dir}/`)) continue;
        const rel = dir ? filePath.slice(dir.length + 1) : filePath;
        const [first, ...more] = rel.split('/');
        if (more.length) entries.set(first!, { path: first, type: 'tree', mode: '040000', sha: `t_${tm[1]}_${Buffer.from(dir ? `${dir}/${first}` : first!).toString('hex')}` });
        else entries.set(first!, { path: first, type: 'blob', mode: first!.endsWith('.sh') ? '100755' : '100644', sha: `b_${first}` });
      }
      return json({ sha: x[1], tree: [...entries.values()] });
    }
    if (rest === '/git/trees' && method === 'POST') {
      // Like git, the same tree has the same id.
      const sha = createHash('sha1').update(JSON.stringify([body.base_tree, body.tree])).digest('hex');
      this.createdTrees.set(sha, { base: body.base_tree, entries: body.tree });
      return json({ sha }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      const sha = `c0mmit${this.nextId++}`.padEnd(40, 'a');
      this.createdCommits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha }, 201);
    }
    return json({ message: `fake GitHub has no ${method} ${p}` }, 404);
  };

  /** The files between the merge base of two commits and the second, with their patches (the compare and pull request files views). */
  private diffFiles(r: GitRepo, base: string, head: string): { mergeBase: string; files: { filename: string; status: string; previous_filename?: string; patch: string }[] } {
    const mb = git(r.dir, 'merge-base', base, head).trim();
    const files = git(r.dir, 'diff', '--name-status', '-M', mb, head)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [st, a, b] = line.split('\t') as [string, string, string | undefined];
        const status = st.startsWith('A') ? 'added' : st.startsWith('D') ? 'removed' : st.startsWith('R') ? 'renamed' : 'modified';
        const filename = b ?? a;
        const raw = git(r.dir, 'diff', '-M', mb, head, '--', ...(b ? [a, b] : [a])).split('\n');
        const at = raw.findIndex((l) => l.startsWith('@@'));
        const patch = at < 0 ? '' : raw.slice(at).join('\n');
        return { filename, status, ...(b ? { previous_filename: a } : {}), patch };
      });
    return { mergeBase: mb, files };
  }

  private issueList(repo: string) {
    const key = repo.toLowerCase();
    if (!this.issues.has(key)) this.issues.set(key, []);
    return this.issues.get(key)!;
  }

  private page<T>(list: T[], url: URL): T[] {
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    return list.slice((page - 1) * per, page * per);
  }

  private archive(r: GitRepo, ref: string): Response {
    const sha = git(r.dir, 'rev-parse', ref === 'HEAD' ? 'HEAD' : ref).trim();
    const name = r.dir.split('/').at(-1);
    const body = gitBuf(r.dir, 'archive', '--format=tar.gz', `--prefix=${name}-${sha}/`, sha);
    return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } });
  }
}

/** A pull request object as GitHub sends it (webhook payloads and `GET /pulls/{n}`). */
export function ghPull(o: { repo: string; number: number; base: string; head: string; headRef?: string; headRepo?: string; draft?: boolean; state?: 'open' | 'closed' }) {
  const repository = (full: string) => ({ full_name: full, private: false, default_branch: 'main' });
  return {
    number: o.number,
    html_url: `https://github.com/${o.repo}/pull/${o.number}`,
    title: `Change ${o.number}`,
    body: '',
    user: { login: 'dev' },
    state: o.state ?? 'open',
    draft: o.draft ?? false,
    merged_at: null,
    merge_commit_sha: null,
    base: { sha: o.base, ref: 'main', repo: repository(o.repo) },
    head: { sha: o.head, ref: o.headRef ?? 'feature', repo: repository(o.headRepo ?? o.repo) },
  };
}

/** A new finding as the checker reports it (`i` varies the line, file and fingerprint). */
export function finding(i: number, over: Partial<Finding> = {}): Finding {
  return {
    rule: 'command-missing',
    severity: 'error',
    message: `\`npm run lint:docs${i}\` is not a script in package.json.`,
    path: i % 2 ? 'AGENTS.md' : 'README.md',
    line: 10 + i,
    column: 5,
    endLine: 10 + i,
    endColumn: 25,
    surface: i % 2 ? 'agent' : 'readme',
    subject: `npm run lint:docs${i}`,
    evidence: { looked: 'package.json scripts (build, test, lint-docs)' },
    fingerprint: `fp${i}`.padEnd(40, '0'),
    ...over,
  };
}

export function prFindings(findings: Finding[]): PrFindings {
  return { repo: 'acme/app', base: 'a'.repeat(40), head: 'b'.repeat(40), findings, total: findings.length, fixed: 0, summary: summarize(findings, 4, 1), files: 4, ms: 1 };
}

