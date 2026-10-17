import { appJwt } from './jwt.js';

/**
 * GitHub as the App: a JWT for App-level calls, installation tokens (cached until a
 * minute before they expire) for everything done in a repository. Tokens never appear in
 * an error message or a log line; `fetchImpl` is injectable so tests never reach GitHub.
 */

const API = 'https://api.github.com';
/** Refresh an installation token this long before GitHub expires it. */
export const TOKEN_MARGIN_MS = 60_000;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AppAuth {
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds since the epoch (tests). */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface CallOptions {
  accept?: string;
  /** A 404 answers `undefined` instead of throwing. */
  allow404?: boolean;
  /** Read the body as text (raw file contents). */
  text?: boolean;
}

async function call<T>(f: typeof fetch, method: Method, path: string, authorization: string, body?: unknown, opts: CallOptions = {}): Promise<T | undefined> {
  const url = path.startsWith('https://') ? path : `${API}${path}`;
  const res = await f(url, {
    method,
    headers: {
      Accept: opts.accept ?? 'application/vnd.github+json',
      'User-Agent': 'staleproof-app',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: authorization,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 404 && opts.allow404) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new GitHubApiError(`GitHub ${method} ${path.replace(/^https:\/\/api\.github\.com/, '')} failed: ${res.status} ${text}`.trim(), res.status);
  }
  if (res.status === 204) return undefined;
  return (opts.text ? await res.text() : await res.json()) as T;
}

export class GitHubAppClient {
  readonly appId: string;
  private readonly tokens = new Map<number, CachedToken>();
  private readonly pending = new Map<number, Promise<CachedToken>>();

  constructor(private readonly auth: AppAuth) {
    this.appId = auth.appId;
  }

  get fetchImpl(): typeof fetch {
    return this.auth.fetchImpl ?? fetch;
  }

  private now(): number {
    return this.auth.now?.() ?? Date.now();
  }

  jwt(): string {
    return appJwt(this.auth.appId, this.auth.privateKey, Math.floor(this.now() / 1000));
  }

  /** A call authenticated as the App itself. */
  async asApp<T>(method: Method, path: string, body?: unknown, opts: CallOptions = {}): Promise<T | undefined> {
    return call<T>(this.fetchImpl, method, path, `Bearer ${this.jwt()}`, body, opts);
  }

  /** An installation token: from the cache while it has more than a minute left, else a new one. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token;
    let p = this.pending.get(installationId);
    if (!p) {
      p = (async () => {
        const r = await this.asApp<{ token: string; expires_at: string }>('POST', `/app/installations/${installationId}/access_tokens`, {});
        if (!r?.token) throw new GitHubApiError(`GitHub gave no token for installation ${installationId}`, 502);
        const expiresAt = Date.parse(r.expires_at);
        const entry = { token: r.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.now() + 50 * 60_000 };
        this.tokens.set(installationId, entry);
        return entry;
      })().finally(() => this.pending.delete(installationId));
      this.pending.set(installationId, p);
    }
    return (await p).token;
  }

  /** Drop a cached token (uninstalled, or GitHub refused it). */
  forget(installationId: number): void {
    this.tokens.delete(installationId);
  }

  installation(installationId: number): InstallationClient {
    return new InstallationClient(this, installationId);
  }

  /** The installation that covers a repository, or undefined when the App is not installed there. */
  async installationIdFor(fullName: string): Promise<number | undefined> {
    return (await this.asApp<{ id: number }>('GET', `/repos/${fullName}/installation`, undefined, { allow404: true }))?.id;
  }
}

/** Calls made in an installation's repositories, with its token. */
export class InstallationClient {
  constructor(
    readonly app: GitHubAppClient,
    readonly installationId: number,
  ) {}

  get fetchImpl(): typeof fetch {
    return this.app.fetchImpl;
  }

  token(): Promise<string> {
    return this.app.installationToken(this.installationId);
  }

  /** What shared helpers take (`githubJson`, the suggestion poster, tarball downloads). */
  async options(): Promise<{ token: string; fetchImpl: typeof fetch }> {
    return { token: await this.token(), fetchImpl: this.fetchImpl };
  }

  async request<T>(method: Method, path: string, body?: unknown, opts: CallOptions = {}): Promise<T | undefined> {
    try {
      return await call<T>(this.fetchImpl, method, path, `Bearer ${await this.token()}`, body, opts);
    } catch (err) {
      // A token revoked early (permissions changed): one retry with a new one.
      if (!(err instanceof GitHubApiError) || err.status !== 401) throw err;
      this.app.forget(this.installationId);
      return call<T>(this.fetchImpl, method, path, `Bearer ${await this.token()}`, body, opts);
    }
  }

  async get<T>(path: string, opts: CallOptions = {}): Promise<T | undefined> {
    return this.request<T>('GET', path, undefined, opts);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('POST', path, body)) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('PATCH', path, body)) as T;
  }

  /** A file's text at a ref, or undefined when there is none. */
  async fileText(repo: string, path: string, ref: string): Promise<string | undefined> {
    const p = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
    return this.get<string>(p, { accept: 'application/vnd.github.raw+json', allow404: true, text: true });
  }

  /** Every page of a list (`key` names the array in wrapped answers, e.g. `repositories`). */
  async paginate<T>(path: string, opts: { key?: string; max?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    const max = opts.max ?? 1000;
    for (let page = 1; out.length < max && page <= 100; page++) {
      const r = await this.get<unknown>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = (opts.key ? (r as Record<string, T[]> | undefined)?.[opts.key] : (r as T[] | undefined)) ?? [];
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out.slice(0, max);
  }
}
