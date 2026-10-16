import { z } from 'zod';
import * as Q from '../graph/queries.js';
import { parsePrUrl } from '../pr/github.js';
import { exampleAtCommit, installSet, loadExample, recordSkippedRun, runExample, type ExampleForRun, type RunRecord } from '../runner/index.js';
import { result, Tracer, type ToolDef } from './types.js';

export type RunVerdict = 'breaks' | 'fixes' | 'passes' | 'fails' | 'already-broken' | 'changed-failure' | 'skipped' | 'error';

export interface RunExampleData {
  example: string;
  url: string;
  verdict: RunVerdict;
  runs: RunRecord[];
  /** The after run used the page as the pull request edits it. */
  editedByPr?: boolean;
}

function failed(r: RunRecord): boolean {
  return r.status === 'fail' || r.status === 'timeout';
}

export function verdictOf(runs: RunRecord[]): RunVerdict {
  if (runs.some((r) => r.status === 'skipped')) return 'skipped';
  if (runs.some((r) => r.status === 'error')) return 'error';
  const before = runs.find((r) => r.side === 'before');
  const after = runs.find((r) => r.side === 'after');
  if (before && after) {
    if (!failed(before) && failed(after)) return 'breaks';
    if (failed(before) && !failed(after)) return 'fixes';
    if (!failed(before) && !failed(after)) return 'passes';
    return before.error === after.error ? 'already-broken' : 'changed-failure';
  }
  return runs.some(failed) ? 'fails' : 'passes';
}

export const runExampleTool: ToolDef<{ example_id: string; pr_url?: string }, RunExampleData> = {
  name: 'run_example',
  description:
    'Execute a docs code example in a sandbox (fresh virtualenv with the repositories installed from source, scratch FalkorDB on localhost:6379, no other network). ' +
    'With pr_url it runs twice — at the commit before the PR and at the PR — so "passes before, fails after" proves the PR broke the example. ' +
    'Examples needing LLM keys, local files or placeholders are recorded as skipped with the reason. Identical runs are answered from the graph.',
  input: z.object({
    example_id: z.string().describe('CodeExample id from impact (repo:path:index)'),
    pr_url: z.string().optional().describe('Run before and after this pull request'),
  }),
  queries: [Q.exampleForRun, Q.installSet, Q.cachedRun, Q.upsertRun, Q.linkRunToPr],
  async run(ctx, input) {
    const tracer = new Tracer(ctx.graph);
    const example = await loadExample(tracer.graph, input.example_id);
    if (!example) throw new Error(`no code example ${input.example_id}`);
    const prUrl = input.pr_url ? parsePrUrl(input.pr_url).url : undefined;
    let pr: { repo: string; before: string; after: string; docs: string[] | null } | undefined;
    if (prUrl) {
      pr = (
        await tracer.run<{ repo: string; before: string; after: string; docs: string[] | null }>(
          `MATCH (pr:PullRequest {url: $url}) RETURN pr.repo AS repo, pr.before_sha AS before, pr.after_sha AS after, pr.docs_touched AS docs`,
          { url: prUrl },
        )
      ).rows[0];
      if (!pr) throw new Error(`${prUrl} has not been checked yet; call impact first`);
    }
    const repos = await installSet(tracer.graph, [...new Set([...example.usedRepos, ...(pr ? [pr.repo] : [])])]);
    const runs: RunRecord[] = [];
    let editedByPr = false;
    if (pr) {
      // A pull request that edits the example's page is judged by the page it leaves: the after run uses that version.
      let after: ExampleForRun | null | undefined = example;
      if (example.repo === pr.repo && (pr.docs ?? []).includes(example.path)) {
        const indexed = repos.find((r) => r.repo === example.repo)?.sha ??
          (await tracer.run<{ sha: string }>(`MATCH (r:Repo {name: $repo}) RETURN r.sha AS sha`, { repo: example.repo })).rows[0]?.sha;
        const edited = indexed ? await exampleAtCommit(ctx.config, example, indexed, pr.after, ctx.checkouts?.[example.repo]).catch(() => undefined) : undefined;
        if (edited !== undefined) {
          after = edited;
          editedByPr = edited === null || edited.code !== example.code;
        }
      }
      for (const side of ['before', 'after'] as const) {
        const ex = side === 'after' ? after : example;
        if (ex === null) {
          runs.push(await recordSkippedRun(tracer.graph, example.id, side, 'this pull request removes the example from its page', pr.after, prUrl));
          break;
        }
        runs.push(
          await runExample(tracer.graph, ctx.config, ex, repos, {
            shas: { [pr.repo]: side === 'before' ? pr.before : pr.after },
            side,
            prUrl,
            log: ctx.log,
            checkouts: ctx.checkouts,
            fresh: ctx.freshRuns,
          }),
        );
        if (runs[0]!.status === 'skipped') break;
      }
    } else {
      runs.push(await runExample(tracer.graph, ctx.config, example, repos, { log: ctx.log, checkouts: ctx.checkouts, fresh: ctx.freshRuns }));
    }
    const verdict = verdictOf(runs);
    const short = (sha: string) => sha.slice(0, 7);
    const after = runs.find((r) => r.side === 'after') ?? runs[0]!;
    const summary =
      verdict === 'skipped'
        ? `Not run: ${runs.find((r) => r.status === 'skipped')!.reason}.`
        : verdict === 'error'
          ? `The sandbox could not be prepared: ${runs.find((r) => r.status === 'error')!.reason?.split('\n')[0]}`
          : verdict === 'breaks'
            ? `Passes at ${short(pr!.before)} and fails at ${short(pr!.after)} with ${after.error}: the PR breaks this example.`
            : verdict === 'fixes'
              ? `Fails at ${short(pr!.before)} and passes at ${short(pr!.after)}: the PR fixes this example.`
              : verdict === 'passes'
                ? pr
                  ? `Passes before and after the PR (${short(pr.before)}, ${short(pr.after)}): no observable break.`
                  : 'Passes at the indexed commits.'
                : verdict === 'already-broken'
                  ? `Fails both before and after the PR with ${after.error}: broken already, not by this PR.`
                  : verdict === 'changed-failure'
                    ? `Fails before (${runs[0]!.error}) and after with a different error (${after.error}).`
                    : `Fails at the indexed commits: ${after.error}.`;
    return result(
      'run_example',
      tracer,
      summary + (editedByPr ? ' The after run uses the page as this pull request edits it.' : '') + (runs.some((r) => r.cached) ? ' (recorded earlier; not re-run)' : ''),
      { example: example.id, url: example.url, verdict, runs, editedByPr },
    );
  },
};
