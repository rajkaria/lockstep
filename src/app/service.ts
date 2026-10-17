import { auditDocs } from '../audit.js';
import type { Config } from '../config.js';
import type { GraphStore, OrgGraph } from '../graph/client.js';
import { Workspaces, type HostedLimits } from '../hosted/workspaces.js';
import type { TarballLimits } from '../indexer/tarball.js';
import { tarballTree } from '../lint/sources.js';
import { runFixPr } from '../pr/fix-pr.js';
import { keepAuditIssue, type AuditIssueResult } from './audit-issue.js';
import { graphChecker, type PrChecker } from './checker.js';
import { BranchMovedError, commitFixes, fixesPatch } from './commit-fixes.js';
import type { GitHubAppEnv } from './env.js';
import { GitHubApiError, GitHubAppClient, type InstallationClient } from './github-app.js';
import { privateGraphName } from './guard.js';
import { checkPullRequest, storedFixes, type PrCheckSummary, type SuggestFn } from './pr-check.js';
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  GhPull,
  GhRepository,
  InstallationEvent,
  InstallationRepositoriesEvent,
  PullRequestEvent,
  PushEvent,
} from './payloads.js';
import { isFork } from './payloads.js';
import { PrivateWorkspaces } from './private-workspaces.js';
import { AppRegistry, APP_REGISTRY } from './registry.js';
import { loadAppSettings } from './settings.js';

/**
 * The GitHub App: webhook events in, check runs, comments, suggestions and commits out.
 * Every handler is safe to run twice (deliveries are deduplicated, but a re-run is a
 * re-run) and never logs a token.
 */

/** `[app] fix-prs = true`: open or update the docs fix PR (spec F3.5; `src/pr/fix-pr.ts`). */
export type FixPrFn = (input: {
  repo: string;
  defaultBranch: string;
  token: string;
  fetchImpl?: typeof fetch;
  home: string;
  limits?: TarballLimits;
}) => Promise<{ action: string; url?: string; fixes?: number }>;

/** The docs fix PR from the default branch's archive (read with the installation token), as the Action's `mode: fix` makes it. */
export const defaultFixPr: FixPrFn = async (input) => {
  const tree = await tarballTree(input.home, input.repo, input.defaultBranch, { token: input.token, fetchImpl: input.fetchImpl, limits: input.limits });
  try {
    const r = await runFixPr({ repo: input.repo, tree }, { token: input.token, fetchImpl: input.fetchImpl });
    return { action: r.action, ...(r.pr ? { url: r.pr.url } : {}), fixes: r.fixes.length };
  } finally {
    await tree.dispose();
  }
};

export interface GitHubAppDeps {
  store: GraphStore;
  config: Config;
  /** The hosted workspaces (public repositories); one is made when the server has none. */
  workspaces?: Workspaces;
  /** The App's settings (default: from the environment). */
  env?: GitHubAppEnv;
  /** The registry graph (default `staleproof-app`). */
  registry?: string;
  /** Every GitHub call and download (tests pass a fake GitHub). */
  fetchImpl?: typeof fetch;
  /** Keeps background work alive after the 202 (`waitUntil` from `@vercel/functions` on Vercel). */
  waitUntil?: (p: Promise<unknown>) => void;
  log?: (msg: string) => void;
  /** The check behind the check run (default: the hosted graph check). */
  checker?: PrChecker;
  suggest?: SuggestFn;
  /** `[app] fix-prs` (default: `runFixPr` from src/pr/fix-pr.ts on the default branch's archive). */
  fixPr?: FixPrFn;
  /** Limits of the private workspaces (default: the hosted ones). */
  limits?: Partial<HostedLimits>;
  /** The daily cron stops starting new repositories after this long (default 240 s). */
  cronBudgetMs?: number;
}

export interface HandleResult {
  event: string;
  action?: string;
  /** What was done, in a few words (tests and the log). */
  result: string;
  checks?: PrCheckSummary[];
}

export interface CronReport {
  installations: number;
  repos: number;
  refreshed: string[];
  fixPrs: { repo: string; action: string; url?: string }[];
  auditIssues: (AuditIssueResult & { repo: string })[];
  errors: string[];
  /** The time budget ran out: the oldest repositories go first next time. */
  partial: boolean;
}

const PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

export class GitHubAppService {
  readonly client: GitHubAppClient;
  readonly registry: AppRegistry;
  readonly workspaces: Workspaces;
  readonly privateWorkspaces: PrivateWorkspaces;
  readonly checker: PrChecker;
  readonly log: (msg: string) => void;

  constructor(
    private readonly deps: GitHubAppDeps,
    readonly env: GitHubAppEnv,
  ) {
    this.log = deps.log ?? ((msg) => console.error(`[github-app] ${msg}`));
    this.client = new GitHubAppClient({ appId: env.appId, privateKey: env.privateKey, fetchImpl: deps.fetchImpl });
    this.registry = new AppRegistry(deps.store, deps.registry ?? APP_REGISTRY);
    this.workspaces = deps.workspaces ?? new Workspaces(deps.store, deps.config, deps.store.org(deps.config.org), { fetchImpl: deps.fetchImpl });
    this.privateWorkspaces = new PrivateWorkspaces(deps.store, deps.config, this.registry, { limits: deps.limits, fetchImpl: deps.fetchImpl, hosted: this.workspaces });
    this.checker = deps.checker ?? graphChecker({ config: deps.config, workspaces: this.workspaces, privateWorkspaces: this.privateWorkspaces, fetchImpl: deps.fetchImpl });
  }

  get botLogin(): string | undefined {
    return this.env.slug ? `${this.env.slug}[bot]` : undefined;
  }

  private prContext() {
    return { app: this.client, registry: this.registry, checker: this.checker, botLogin: this.botLogin, suggest: this.deps.suggest, log: this.log };
  }

  async handle(event: string, payload: unknown): Promise<HandleResult> {
    const p = payload as { action?: string };
    const base = { event, ...(p.action ? { action: p.action } : {}) };
    switch (event) {
      case 'pull_request':
        return { ...base, ...(await this.pullRequest(payload as PullRequestEvent)) };
      case 'check_run':
        return { ...base, ...(await this.checkRun(payload as CheckRunEvent)) };
      case 'check_suite':
        return { ...base, ...(await this.checkSuite(payload as CheckSuiteEvent)) };
      case 'push':
        return { ...base, result: await this.push(payload as PushEvent) };
      case 'installation':
        return { ...base, result: await this.installation(payload as InstallationEvent) };
      case 'installation_repositories':
        return { ...base, result: await this.installationRepositories(payload as InstallationRepositoriesEvent) };
      default:
        return { ...base, result: 'ignored: not an event the App acts on' };
    }
  }

  private repoOf(r: GhRepository): { fullName: string; private: boolean; defaultBranch: string } {
    return { fullName: r.full_name, private: !!r.private, defaultBranch: r.default_branch ?? 'main' };
  }

  private async pullRequest(e: PullRequestEvent): Promise<Omit<HandleResult, 'event'>> {
    if (!PR_ACTIONS.has(e.action)) return { result: `ignored: pull_request ${e.action}` };
    if (!e.installation) return { result: 'ignored: no installation' };
    const check = await checkPullRequest(this.prContext(), { installationId: e.installation.id, repo: this.repoOf(e.repository), pull: e.pull_request, trigger: e.action });
    return { result: check.skipped ? `skipped: ${check.skipped}` : `checked: ${check.conclusion}`, checks: [check] };
  }

  private async pull(client: InstallationClient, repo: string, number: number): Promise<GhPull | undefined> {
    return client.get<GhPull>(`/repos/${repo}/pulls/${number}`, { allow404: true });
  }

  /** Re-check pull requests by number (a re-run from the Checks tab). */
  private async recheck(installationId: number, repository: GhRepository, numbers: number[], trigger: string): Promise<Omit<HandleResult, 'event'>> {
    const client = this.client.installation(installationId);
    const checks: PrCheckSummary[] = [];
    for (const n of [...new Set(numbers)]) {
      const pull = await this.pull(client, repository.full_name, n);
      if (pull) checks.push(await checkPullRequest(this.prContext(), { installationId, repo: this.repoOf(repository), pull, trigger }));
    }
    return { result: checks.length ? `re-checked ${checks.length} pull request(s)` : 'ignored: no open pull request for this commit', checks };
  }

  private ours(app: { id: number } | null | undefined): boolean {
    return !!app && String(app.id) === this.env.appId;
  }

  private async checkRun(e: CheckRunEvent): Promise<Omit<HandleResult, 'event'>> {
    if (!e.installation) return { result: 'ignored: no installation' };
    if (!this.ours(e.check_run.app)) return { result: 'ignored: a check run of another app' };
    const number = Number(e.check_run.external_id) || e.check_run.pull_requests?.[0]?.number;
    if (e.action === 'rerequested') {
      if (!number) return { result: 'ignored: the check run names no pull request' };
      return this.recheck(e.installation.id, e.repository, [number], 'rerequested');
    }
    if (e.action === 'requested_action' && e.requested_action?.identifier === 'apply-fixes') {
      return { result: await this.applyFixes(e, number) };
    }
    return { result: `ignored: check_run ${e.action}` };
  }

  private async checkSuite(e: CheckSuiteEvent): Promise<Omit<HandleResult, 'event'>> {
    if (e.action !== 'rerequested' || !e.installation) return { result: `ignored: check_suite ${e.action}` };
    const client = this.client.installation(e.installation.id);
    let numbers = (e.check_suite.pull_requests ?? []).map((p) => p.number);
    // Pull requests from forks are not listed on the suite: find them by their head commit.
    if (!numbers.length) numbers = await prsForCommit(client, e.repository.full_name, e.check_suite.head_sha);
    return this.recheck(e.installation.id, e.repository, numbers, 'rerequested');
  }

  /** The Apply fixes button: commit the check run's verified fixes, or (forks) hand over the patch. */
  private async applyFixes(e: CheckRunEvent, number: number | undefined): Promise<string> {
    const repo = e.repository.full_name;
    const client = this.client.installation(e.installation!.id);
    const run = e.check_run;
    const say = async (message: string) => {
      await client
        .patch(`/repos/${repo}/check-runs/${run.id}`, {
          output: { title: run.output?.title || 'Staleproof', summary: run.output?.summary || message, text: message },
          actions: [],
        })
        .catch((err) => this.log(`could not update check run ${run.id}: ${(err as Error).message}`));
      return message;
    };
    if (!number) return say('This check run names no pull request; re-run the check.');
    const pull = await this.pull(client, repo, number);
    if (!pull || pull.state !== 'open') return say(`Pull request #${number} is not open: nothing was committed.`);
    if (pull.head.sha !== run.head_sha) return say(`The branch moved past ${run.head_sha.slice(0, 7)} since this check ran: nothing was committed. The check of the new head has its own Apply fixes button.`);
    const stored = await this.registry.checkRun(run.id);
    const fixes = storedFixes(stored?.fixes ?? []);
    if (!fixes.length) return say('This check run has no verified fixes on record (they are kept for 7 days): re-run the check, then click Apply fixes again.');
    if (isFork(pull, repo)) {
      const { patch } = await fixesPatch(client, repo, run.head_sha, fixes);
      return say(`This pull request comes from a fork, which Staleproof cannot push to. Apply the patch on the branch (\`git apply\`):\n\n\`\`\`diff\n${patch}\n\`\`\``);
    }
    try {
      const done = await commitFixes(client, { repo, branch: pull.head.ref, head: run.head_sha, fixes });
      if (!done) return say('The fixes no longer change anything at this commit: nothing was committed.');
      this.log(`${repo}#${number}: committed ${done.applied.length} fix(es) as ${done.sha.slice(0, 7)}`);
      return say(
        `Committed ${done.applied.length} verified fix${done.applied.length === 1 ? '' : 'es'} to \`${pull.head.ref}\` as ${done.sha.slice(0, 7)} (${done.files.map((f) => `\`${f}\``).join(', ')}).` +
          (done.skipped.length ? ` ${done.skipped.length} overlapping fix(es) were left out.` : '') +
          ' The new commit is being checked.',
      );
    } catch (err) {
      if (err instanceof BranchMovedError) return say(err.message);
      if (err instanceof GitHubApiError && (err.status === 403 || err.status === 422)) {
        return say(`GitHub refused the commit (${err.status}): the branch may be protected. Run \`npx staleproof fix\` on the branch instead.`);
      }
      throw err;
    }
  }

  /** A push to the default branch refreshes the index (once per 5 minutes; later pushes mark it dirty). */
  private async push(e: PushEvent): Promise<string> {
    if (!e.installation) return 'ignored: no installation';
    const repo = this.repoOf(e.repository);
    if (e.deleted || e.ref !== `refs/heads/${repo.defaultBranch}`) return 'ignored: not the default branch';
    if (!(await this.registry.pushRefresh({ fullName: repo.fullName, private: repo.private, installation: e.installation.id }))) return 'debounced: marked dirty';
    try {
      return (await this.refresh(e.installation.id, repo)) ? 'refreshed' : 'not indexed yet: nothing to refresh';
    } catch (err) {
      await this.registry.markDirty(repo.fullName).catch(() => undefined);
      throw err;
    }
  }

  /** Re-index a repository's workspace when it has one (indexing is lazy: the first pull request does it). */
  private async refresh(installationId: number, repo: { fullName: string; private: boolean; defaultBranch: string }): Promise<boolean> {
    const client = this.client.installation(installationId);
    if (repo.private) {
      if (!(await this.privateWorkspaces.has(installationId, repo.fullName))) return false;
      const { app } = await loadAppSettings(client, repo.fullName, repo.defaultBranch);
      await this.privateWorkspaces.ensure(installationId, repo.fullName, await client.token(), { with: app.alsoIndex, refresh: true });
    } else {
      const found = await this.workspaces.locate(repo.fullName);
      if (!found || found.curated) return false;
      const { app } = await loadAppSettings(client, repo.fullName, repo.defaultBranch);
      await this.workspaces.ensure(repo.fullName, { with: app.alsoIndex, refresh: true });
    }
    await this.registry.markRefreshed(repo.fullName);
    return true;
  }

  private async installation(e: InstallationEvent): Promise<string> {
    const inst = e.installation;
    const row = { id: inst.id, account: inst.account?.login ?? 'unknown', accountType: inst.account?.type ?? 'User', selection: inst.repository_selection ?? 'selected' };
    switch (e.action) {
      case 'created':
      case 'new_permissions_accepted':
        await this.registry.recordInstallation(row, (e.repositories ?? []).map((r) => ({ fullName: r.full_name, private: !!r.private })));
        return `recorded installation ${inst.id} (${e.repositories?.length ?? 0} repositories)`;
      case 'suspend':
      case 'unsuspend':
        await this.registry.recordInstallation({ ...row, suspended: e.action === 'suspend' });
        return `installation ${inst.id} ${e.action === 'suspend' ? 'suspended' : 'unsuspended'}`;
      case 'deleted':
        // Uninstalled: its private graph goes, with everything the App knew about it.
        await this.privateWorkspaces.evictInstallation(inst.id);
        await this.registry.removeInstallation(inst.id);
        this.client.forget(inst.id);
        return `removed installation ${inst.id} and dropped ${privateGraphName(inst.id)}`;
      default:
        return `ignored: installation ${e.action}`;
    }
  }

  private async installationRepositories(e: InstallationRepositoriesEvent): Promise<string> {
    const inst = e.installation;
    await this.registry.recordInstallation({
      id: inst.id,
      account: inst.account?.login ?? 'unknown',
      accountType: inst.account?.type ?? 'User',
      selection: e.repository_selection ?? inst.repository_selection ?? 'selected',
    });
    const added = (e.repositories_added ?? []).map((r) => ({ fullName: r.full_name, private: !!r.private }));
    if (added.length) await this.registry.addRepos(inst.id, added);
    const removed = (e.repositories_removed ?? []).map((r) => r.full_name);
    let dropped = false;
    if (removed.length) {
      await this.registry.removeRepos(inst.id, removed);
      // A private repository the App may no longer read must not stay in its graph.
      const held = await this.registry.indexed(privateGraphName(inst.id));
      if (held.some((h) => removed.some((r) => r.toLowerCase() === h.name))) {
        await this.privateWorkspaces.evictInstallation(inst.id);
        dropped = true;
      }
    }
    return `installation ${inst.id}: ${added.length} added, ${removed.length} removed${dropped ? `, ${privateGraphName(inst.id)} dropped` : ''}`;
  }

  /** The graph a repository's audit reads, indexed when needed. */
  private async auditGraph(installationId: number, repo: { fullName: string; private: boolean }, alsoIndex: string[]): Promise<OrgGraph> {
    if (repo.private) {
      const client = this.client.installation(installationId);
      return (await this.privateWorkspaces.ensure(installationId, repo.fullName, await client.token(), { with: alsoIndex })).graph;
    }
    const found = await this.workspaces.locate(repo.fullName);
    if (found?.curated) return found.graph;
    return (await this.workspaces.ensure(repo.fullName, { with: alsoIndex })).graph;
  }

  /**
   * The daily cron: for every installation's repositories (least recently visited first,
   * within the time budget) refresh a dirty index, open or update the docs fix PR
   * (`[app] fix-prs`), and keep the audit issue (`[app] audit-issue`).
   */
  async cron(): Promise<CronReport> {
    const started = Date.now();
    const budget = this.deps.cronBudgetMs ?? 240_000;
    const report: CronReport = { installations: 0, repos: 0, refreshed: [], fixPrs: [], auditIssues: [], errors: [], partial: false };
    outer: for (const inst of await this.registry.installations()) {
      if (inst.suspended) continue;
      report.installations++;
      const client = this.client.installation(inst.id);
      let repos: GhRepository[];
      try {
        repos = await client.paginate<GhRepository>('/installation/repositories', { key: 'repositories', max: 300 });
      } catch (err) {
        report.errors.push(`installation ${inst.id}: ${(err as Error).message}`);
        continue;
      }
      const seen = new Map((await this.registry.repos(inst.id)).map((r) => [r.name, r]));
      repos.sort((a, b) => (seen.get(a.full_name.toLowerCase())?.cronAt ?? 0) - (seen.get(b.full_name.toLowerCase())?.cronAt ?? 0));
      for (const r of repos) {
        if (Date.now() - started > budget) {
          report.partial = true;
          break outer;
        }
        const repo = this.repoOf(r);
        report.repos++;
        try {
          if (!seen.has(repo.fullName.toLowerCase())) await this.registry.addRepos(inst.id, [{ fullName: repo.fullName, private: repo.private }]);
          const { app } = await loadAppSettings(client, repo.fullName, repo.defaultBranch);
          if (seen.get(repo.fullName.toLowerCase())?.dirty && (await this.refresh(inst.id, repo))) report.refreshed.push(repo.fullName);
          if (app.fixPrs) {
            const r2 = await (this.deps.fixPr ?? defaultFixPr)({
              repo: repo.fullName,
              defaultBranch: repo.defaultBranch,
              token: await client.token(),
              fetchImpl: this.deps.fetchImpl,
              home: this.deps.config.home,
              limits: this.workspaces.limits.tarball,
            });
            report.fixPrs.push({ repo: repo.fullName, action: r2.action, ...(r2.url ? { url: r2.url } : {}) });
          }
          if (app.auditIssue) {
            const graph = await this.auditGraph(inst.id, repo, app.alsoIndex);
            const name = (await graph.run<{ name: string }>(`MATCH (x:Repo) WHERE toLower(x.name) = toLower($name) RETURN x.name AS name`, { name: repo.fullName })).rows[0]?.name ?? repo.fullName;
            const audit = await auditDocs({ graph, config: { ...this.deps.config, githubToken: await client.token() } }, { repos: [name] });
            report.auditIssues.push({ repo: repo.fullName, ...(await keepAuditIssue(client, repo.fullName, { data: audit.data, summary: audit.summary })) });
          }
          await this.registry.markCron(repo.fullName);
        } catch (err) {
          report.errors.push(`${repo.fullName}: ${(err as Error).message}`);
        }
      }
    }
    this.log(
      `cron: ${report.installations} installation(s), ${report.repos} repo(s), ${report.fixPrs.length} fix PR(s), ${report.auditIssues.length} audit issue(s), ${report.errors.length} error(s)${report.partial ? ', partial' : ''}`,
    );
    return report;
  }
}

/** Open pull requests whose head is `sha` (the commit's own list, else the open pull requests). */
export async function prsForCommit(client: InstallationClient, repo: string, sha: string): Promise<number[]> {
  const direct = (await client.get<{ number: number; state: string }[]>(`/repos/${repo}/commits/${sha}/pulls`, { allow404: true })) ?? [];
  const open = direct.filter((p) => p.state === 'open').map((p) => p.number);
  if (open.length) return open;
  const all = await client.paginate<{ number: number; head: { sha: string } }>(`/repos/${repo}/pulls?state=open`, { max: 300 });
  return all.filter((p) => p.head.sha === sha).map((p) => p.number);
}
