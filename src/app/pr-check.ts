import { COMMENT_MARKER } from '../format/markdown.js';
import type { Finding, Fix } from '../lint/types.js';
import { outsideFixesMarkdown, suggestFixes } from '../pr/suggest.js';
import type { PrChecker } from './checker.js';
import { annotationsOf, APP_COMMENT_MARKER, APPLY_FIXES, CHECK_NAME, checkTitle, chunks, conclusionOf, planComment, resolveAppConfig, truncate, type CheckOutcome, type ResolvedAppConfig } from './checks.js';
import { fixesPatch, readFixedFiles } from './commit-fixes.js';
import type { GitHubAppClient, InstallationClient } from './github-app.js';
import { isFork, pullRequestInfo, type GhPull } from './payloads.js';
import type { AppRegistry } from './registry.js';
import { loadAppSettings } from './settings.js';

/**
 * One pull request, checked as the App: a "Staleproof" check run (in progress → the
 * report, annotations for new findings, the Apply fixes button), review suggestions for
 * verified fixes inside the diff, and the PR comment when there is something to say.
 */

export const DETAILS_URL = 'https://staleproof.dev/#/docs/github-app';

export type SuggestFn = typeof suggestFixes;

export interface PrCheckContext {
  app: GitHubAppClient;
  registry: AppRegistry;
  checker: PrChecker;
  /** `<slug>[bot]`: only its comments count as earlier Staleproof comments. */
  botLogin?: string;
  suggest?: SuggestFn;
  log: (msg: string) => void;
}

export interface PrTarget {
  installationId: number;
  repo: { fullName: string; private: boolean; defaultBranch: string };
  pull: GhPull;
  /** What started it (`opened`, `synchronize`, `rerequested`, ...), for the log. */
  trigger: string;
}

export interface PrCheckSummary {
  checkRunId?: number;
  conclusion?: string;
  skipped?: string;
  comment?: 'created' | 'updated' | 'all-clear' | 'none';
  suggestions?: number;
  error?: string;
}

interface GhIssueComment {
  id: number;
  body?: string;
  user?: { login: string } | null;
  performed_via_github_app?: { id: number } | null;
}

/** The App's own Staleproof comment on a pull request, if it has one. */
export async function findComment(client: InstallationClient, repo: string, number: number, botLogin?: string): Promise<{ id: number; body: string } | undefined> {
  const comments = await client.paginate<GhIssueComment>(`/repos/${repo}/issues/${number}/comments`, { max: 1000 });
  const appId = Number(client.app.appId);
  const mine = comments.filter(
    (c) => (c.body ?? '').startsWith(COMMENT_MARKER) && (c.performed_via_github_app?.id === appId || (!!botLogin && c.user?.login === botLogin)),
  );
  const last = mine.at(-1);
  return last ? { id: last.id, body: last.body ?? '' } : undefined;
}

function verifiedFixes(findings: readonly Finding[] | undefined): Finding[] {
  return (findings ?? []).filter((f) => f.fix?.verified && f.fix.edits.length > 0);
}

/** One pull request at a time per process: a burst of pushes must not race on its comment. */
const running = new Map<string, Promise<unknown>>();

export function checkPullRequest(ctx: PrCheckContext, t: PrTarget): Promise<PrCheckSummary> {
  const key = `${t.repo.fullName.toLowerCase()}#${t.pull.number}`;
  const prev = running.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => runCheck(ctx, t));
  running.set(key, next);
  void next.finally(() => {
    if (running.get(key) === next) running.delete(key);
  }).catch(() => undefined);
  return next;
}

async function runCheck(ctx: PrCheckContext, t: PrTarget): Promise<PrCheckSummary> {
  const repo = t.repo.fullName;
  const client = ctx.app.installation(t.installationId);
  if (t.pull.state !== 'open') return { skipped: 'the pull request is closed' };
  // Settings that cannot be read (a GitHub hiccup) fall back to the defaults: the check still runs.
  const settings = await loadAppSettings(client, repo, t.repo.defaultBranch).catch((err: Error) => {
    ctx.log(`${repo}: [app] settings not read, using the defaults: ${err.message}`);
    return { app: resolveAppConfig(undefined), warnings: [] as string[] };
  });
  const cfg = settings.app;
  if (t.pull.draft && !cfg.drafts) return { skipped: 'draft pull request ([app] drafts = false)' };

  const headSha = t.pull.head.sha;
  const run = await client.post<{ id: number }>(`/repos/${repo}/check-runs`, {
    name: CHECK_NAME,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    external_id: String(t.pull.number),
    details_url: DETAILS_URL,
    output: { title: 'Checking the docs', summary: 'Staleproof is reading the docs this pull request reaches and linting the docs references at its base and head.' },
  });
  ctx.log(`${repo}#${t.pull.number} (${t.trigger}): check run ${run.id} started at ${headSha.slice(0, 7)}`);

  const dirty = (await ctx.registry.repo(repo).catch(() => undefined))?.dirty ?? false;
  const fork = isFork(t.pull, repo);
  let outcome: Awaited<ReturnType<PrChecker>>;
  try {
    outcome = await ctx.checker({
      installationId: t.installationId,
      token: await client.token(),
      repo: t.repo,
      pr: pullRequestInfo(t.pull, repo),
      alsoIndex: cfg.alsoIndex,
      refresh: dirty,
      fixes: true,
    });
    if (dirty) await ctx.registry.markRefreshed(repo).catch(() => undefined);
  } catch (err) {
    const message = (err as Error).message;
    ctx.log(`${repo}#${t.pull.number}: check failed: ${message}`);
    await client
      .patch(`/repos/${repo}/check-runs/${run.id}`, {
        status: 'completed',
        conclusion: 'neutral',
        completed_at: new Date().toISOString(),
        output: { title: 'Staleproof could not check this pull request', summary: `The check stopped: ${message}\n\nRe-run it from the Checks tab, or check locally with \`npx -y staleproof check ${t.pull.html_url ?? `${repo}#${t.pull.number}`}\`.` },
      })
      .catch(() => undefined);
    return { checkRunId: run.id, conclusion: 'neutral', error: message };
  }

  const verified = verifiedFixes(outcome.newFindings?.findings);
  let patchText = '';
  if (fork && verified.length) {
    try {
      const p = await fixesPatch(client, repo, headSha, verified.map((f) => f.fix!));
      if (p.patch) patchText = p.patch;
    } catch (err) {
      ctx.log(`${repo}#${t.pull.number}: could not build the fixes patch: ${(err as Error).message}`);
    }
  }
  const conclusion = conclusionOf(outcome, cfg.failOn);
  let summary: string;
  try {
    summary = await completeCheckRun(client, repo, run.id, outcome, { conclusion, verified, fork, patchText });
  } catch (err) {
    // Never leave the run in progress: complete it plainly (the comment still carries the report).
    summary = `the full output was refused: ${(err as Error).message}`;
    ctx.log(`${repo}#${t.pull.number}: check run ${run.id}: ${summary}`);
    await client
      .patch(`/repos/${repo}/check-runs/${run.id}`, {
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: { title: checkTitle(outcome), summary: truncate(outcome.report, 60_000) },
      })
      .catch(() => undefined);
  }
  if (verified.length && !fork) {
    await ctx.registry.saveCheckRun({ id: run.id, repo, pr: t.pull.number, head: headSha, fixes: verified.map((f) => f.fix!) }).catch((err) => ctx.log(`could not keep the fixes of check run ${run.id}: ${(err as Error).message}`));
  }

  // Suggestions first: the fixes they cannot carry go in the comment.
  let outside: Finding[] = verified;
  let suggestions = 0;
  if (cfg.suggestions && verified.length) {
    try {
      const files = await readFixedFiles(client, repo, headSha, verified.map((f) => f.fix!));
      const [owner, name] = repo.split('/') as [string, string];
      const r = await (ctx.suggest ?? suggestFixes)(
        { findings: verified, files, pr: { owner, repo: name, number: t.pull.number, headSha } },
        { ...(await client.options()), ...(ctx.botLogin ? { author: ctx.botLogin } : {}) },
      );
      outside = r.plan.outside;
      suggestions = r.posted.created + r.posted.updated + r.posted.unchanged;
    } catch (err) {
      ctx.log(`${repo}#${t.pull.number}: suggestions not posted: ${(err as Error).message}`);
    }
  }

  let comment: PrCheckSummary['comment'] = 'none';
  try {
    comment = await keepComment(ctx, client, t, cfg, outcome, commentBody(outcome.report, outside, fork, patchText !== ''));
  } catch (err) {
    ctx.log(`${repo}#${t.pull.number}: comment not posted: ${(err as Error).message}`);
  }
  ctx.log(`${repo}#${t.pull.number}: ${conclusion} (${summary}); comment ${comment}; ${suggestions} suggestion(s)`);
  return { checkRunId: run.id, conclusion, comment, suggestions };
}

/** The report, plus what to do about fixes the suggestions could not carry. */
export function commentBody(report: string, outside: readonly Finding[], fork: boolean, hasPatch: boolean): string {
  const extra: string[] = [];
  if (outside.length) {
    extra.push(outsideFixesMarkdown(outside));
    if (fork) extra.push(hasPatch ? 'This pull request comes from a fork, which Staleproof cannot push to: the Staleproof check run has the patch.' : '');
    else extra.push('Or click **Apply fixes** on the Staleproof check run to commit them to this branch.');
  }
  const add = extra.filter(Boolean).join('\n\n');
  // Above the footer line, so the counts comments stay last.
  const footer = report.lastIndexOf('\n<sub>');
  const body = !add ? report : footer >= 0 ? `${report.slice(0, footer)}\n\n${add}\n${report.slice(footer)}` : `${report}\n\n${add}`;
  return `${body}\n${APP_COMMENT_MARKER}`;
}

async function completeCheckRun(
  client: InstallationClient,
  repo: string,
  id: number,
  outcome: CheckOutcome,
  opts: { conclusion: string; verified: Finding[]; fork: boolean; patchText: string },
): Promise<string> {
  const title = checkTitle(outcome);
  const summary = truncate(outcome.report);
  const annotations = annotationsOf(outcome.newFindings?.findings ?? []);
  const batches = chunks(annotations);
  // Every batch but the last while in progress; the last with the conclusion.
  for (const batch of batches.slice(0, -1)) {
    await client.patch(`/repos/${repo}/check-runs/${id}`, { output: { title, summary, annotations: batch } });
  }
  const n = opts.verified.length;
  const text = opts.fork && opts.patchText
    ? truncate(
        [
          `### ${n === 1 ? 'A verified fix' : `${n} verified fixes`} for this pull request`,
          '',
          'The pull request comes from a fork, so Staleproof cannot commit to it. Apply the patch on the branch:',
          '',
          '```diff',
          opts.patchText,
          '```',
          '',
          'Save it as `staleproof.patch` and run `git apply staleproof.patch`, or run `npx staleproof fix` in the checkout.',
        ].join('\n'),
      )
    : undefined;
  const actions = n && !opts.fork ? [{ label: 'Apply fixes', description: `Commit ${n} verified docs fix${n === 1 ? '' : 'es'}`.slice(0, 40), identifier: APPLY_FIXES }] : [];
  await client.patch(`/repos/${repo}/check-runs/${id}`, {
    status: 'completed',
    conclusion: opts.conclusion,
    completed_at: new Date().toISOString(),
    output: { title, summary, ...(text ? { text } : {}), ...(batches.length ? { annotations: batches.at(-1) } : {}) },
    actions,
  });
  return `${annotations.length} annotation(s) in ${Math.max(1, batches.length)} request(s)`;
}

async function keepComment(
  ctx: PrCheckContext,
  client: InstallationClient,
  t: PrTarget,
  cfg: ResolvedAppConfig,
  outcome: CheckOutcome,
  body: string,
): Promise<PrCheckSummary['comment']> {
  if (cfg.comment === 'never') return 'none';
  const repo = t.repo.fullName;
  const existing = await findComment(client, repo, t.pull.number, ctx.botLogin);
  const plan = planComment(cfg.comment, outcome, body, t.pull.head.sha, existing);
  if (plan.kind === 'none') return 'none';
  if (plan.kind === 'create') {
    await client.post(`/repos/${repo}/issues/${t.pull.number}/comments`, { body: plan.body });
    return 'created';
  }
  await client.patch(`/repos/${repo}/issues/comments/${plan.id}`, { body: plan.body });
  return plan.body.includes('<!-- staleproof:all-clear -->') ? 'all-clear' : 'updated';
}

/** Fixes stored with a check run, as `Fix` objects (only the verified, non-empty ones). */
export function storedFixes(raw: readonly unknown[]): Fix[] {
  return raw.filter((f): f is Fix => !!f && typeof f === 'object' && (f as Fix).verified === true && Array.isArray((f as Fix).edits) && (f as Fix).edits.length > 0);
}
