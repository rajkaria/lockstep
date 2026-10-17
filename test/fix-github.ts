import { createHash } from 'node:crypto';

/**
 * An in-memory GitHub for the suggestion poster and the fix pull request: the REST
 * endpoints they call, with the state they change, and a log of every request. Any write
 * to a ref outside `staleproof/` fails the test.
 */

export interface FakeComment {
  id: number;
  body: string;
  path: string;
  /** null: outdated (the lines changed since). */
  line: number | null;
  start_line: number | null;
  commit_id: string;
  user: { login: string };
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  html_url: string;
}

export interface FakeState {
  defaultBranch: string;
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, { base: string; entries: { path: string; mode: string; sha: string }[] }>;
  blobs: Map<string, string>;
  pulls: FakePull[];
  issueComments: { issue: number; body: string }[];
  /** Review comments by pull request number. */
  reviewComments: FakeComment[];
  reviews: { id: number; pull: number; commit_id: string; body: string; event: string; comments: number }[];
  /** `files[].patch` by pull request number. */
  prFiles: Map<number, { filename: string; status: string; patch?: string }[]>;
  /** `GET /pulls/{n}` answers. */
  prInfo: Map<number, { base: { sha: string; ref: string }; head: { sha: string; ref: string }; title?: string }>;
  /** false: the repository does not let GitHub Actions create pull requests (GitHub's default), so `POST /pulls` is refused. */
  actionsMayOpenPulls: boolean;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export function fakeGitHub(repo = 'acme/app', login = 'github-actions[bot]') {
  const state: FakeState = {
    defaultBranch: 'main',
    refs: new Map(),
    commits: new Map(),
    trees: new Map(),
    blobs: new Map(),
    pulls: [],
    issueComments: [],
    reviewComments: [],
    reviews: [],
    prFiles: new Map(),
    prInfo: new Map(),
    actionsMayOpenPulls: true,
  };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let nextId = 100;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  const notFound = () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  const api = `/repos/${repo}`;

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    const q = url.searchParams;
    calls.push({ method, path: `${path}${url.search}`, ...(body !== undefined ? { body } : {}) });
    if (!path.startsWith(api)) return notFound();
    const rest = path.slice(api.length);
    let m: RegExpExecArray | null;

    if (rest === '' && method === 'GET') return json({ default_branch: state.defaultBranch, full_name: repo });
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === 'GET') {
      const s = state.refs.get(decodeURIComponent(m[1]!));
      return s ? json({ ref: `refs/heads/${m[1]}`, object: { sha: s } }) : notFound();
    }
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest)) && method === 'GET') {
      const c = state.commits.get(m[1]!);
      return c ? json({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })), message: c.message }) : notFound();
    }
    if (rest === '/git/blobs' && method === 'POST') {
      const s = sha(`blob\0${body.content}`);
      state.blobs.set(s, body.content);
      return json({ sha: s }, 201);
    }
    if (rest === '/git/trees' && method === 'POST') {
      const s = sha(`tree\0${body.base_tree}\0${JSON.stringify(body.tree)}`);
      state.trees.set(s, { base: body.base_tree, entries: body.tree });
      return json({ sha: s }, 201);
    }
    if (rest === '/git/commits' && method === 'POST') {
      const s = sha(`commit\0${body.tree}\0${body.parents.join(',')}\0${body.message}\0${nextId++}`);
      state.commits.set(s, { tree: body.tree, parents: body.parents, message: body.message });
      return json({ sha: s }, 201);
    }
    if (rest === '/git/refs' && method === 'POST') {
      const ref = String(body.ref).replace(/^refs\/heads\//, '');
      if (!ref.startsWith('staleproof/')) throw new Error(`wrote a ref outside staleproof/: ${ref}`);
      if (state.refs.has(ref)) return json({ message: 'Reference already exists' }, 422);
      state.refs.set(ref, body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') {
      const ref = decodeURIComponent(m[1]!);
      if (!ref.startsWith('staleproof/')) throw new Error(`wrote a ref outside staleproof/: ${ref}`);
      if (!state.refs.has(ref)) return json({ message: 'Reference does not exist' }, 422);
      state.refs.set(ref, body.sha);
      return json({ ref: `refs/heads/${ref}`, object: { sha: body.sha } });
    }
    if (rest === '/pulls' && method === 'GET') {
      const head = q.get('head');
      const wanted = q.get('state') ?? 'open';
      const list = state.pulls.filter((p) => (wanted === 'all' || p.state === wanted) && (!head || `${repo.split('/')[0]}:${p.head.ref}` === head));
      return json(wanted === 'closed' ? [...list].reverse() : list);
    }
    if (rest === '/pulls' && method === 'POST') {
      // GitHub's answer to a workflow token when "Allow GitHub Actions to create and approve pull requests" is off.
      if (!state.actionsMayOpenPulls) return json({ message: 'GitHub Actions is not permitted to create or approve pull requests.', documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request', status: '403' }, 403);
      if (state.pulls.some((p) => p.state === 'open' && p.head.ref === body.head)) return json({ message: 'A pull request already exists' }, 422);
      const number = state.pulls.length + 1;
      const pr: FakePull = { number, title: body.title, body: body.body, state: 'open', merged_at: null, head: { ref: body.head, sha: state.refs.get(body.head) ?? '' }, base: { ref: body.base }, html_url: `https://github.com/${repo}/pull/${number}` };
      state.pulls.push(pr);
      return json(pr, 201);
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'GET') {
      const info = state.prInfo.get(Number(m[1]));
      if (!info) return notFound();
      return json({ number: Number(m[1]), title: info.title ?? 'PR', body: '', user: { login: 'dev' }, state: 'open', merged_at: null, merge_commit_sha: null, ...info });
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const pr = state.pulls.find((p) => p.number === Number(m![1]));
      if (!pr) return notFound();
      Object.assign(pr, body);
      return json(pr);
    }
    if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest)) && method === 'POST') {
      state.issueComments.push({ issue: Number(m[1]), body: body.body });
      return json({ id: nextId++ }, 201);
    }
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(rest)) && method === 'GET') {
      const all = state.prFiles.get(Number(m[1])) ?? [];
      const page = Number(q.get('page') ?? 1);
      const per = Number(q.get('per_page') ?? 30);
      return json(all.slice((page - 1) * per, page * per));
    }
    if ((m = /^\/pulls\/(\d+)\/comments$/.exec(rest)) && method === 'GET') {
      const page = Number(q.get('page') ?? 1);
      const per = Number(q.get('per_page') ?? 30);
      return json(state.reviewComments.filter((c) => c.id > 0).slice((page - 1) * per, page * per));
    }
    if ((m = /^\/pulls\/(\d+)\/comments$/.exec(rest)) && method === 'POST') {
      const c: FakeComment = { id: nextId++, body: body.body, path: body.path, line: body.line, start_line: body.start_line ?? null, commit_id: body.commit_id, user: { login } };
      state.reviewComments.push(c);
      return json(c, 201);
    }
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest)) && method === 'POST') {
      const lines = state.prFiles.get(Number(m[1]));
      for (const c of body.comments ?? []) {
        // GitHub refuses a review whose comment is not on a line of the diff.
        const f = lines?.find((x) => x.filename === c.path);
        if (lines && (!f || !f.patch)) return json({ message: 'Unprocessable Entity', errors: ['Line could not be resolved'] }, 422);
      }
      const review = { id: nextId++, pull: Number(m[1]), commit_id: body.commit_id, body: body.body, event: body.event, comments: (body.comments ?? []).length };
      state.reviews.push(review);
      for (const c of body.comments ?? []) {
        state.reviewComments.push({ id: nextId++, body: c.body, path: c.path, line: c.line, start_line: c.start_line ?? null, commit_id: body.commit_id, user: { login } });
      }
      return json({ id: review.id, html_url: `https://github.com/${repo}/pull/${m[1]}#pullrequestreview-${review.id}` });
    }
    if ((m = /^\/pulls\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
      const c = state.reviewComments.find((x) => x.id === Number(m![1]));
      if (!c) return notFound();
      if (c.user.login !== login) return json({ message: 'Forbidden' }, 403);
      c.body = body.body;
      return json(c);
    }
    return notFound();
  };
  return { state, calls, fetch: fetchImpl as typeof fetch, writes: () => calls.filter((c) => c.method !== 'GET') };
}
