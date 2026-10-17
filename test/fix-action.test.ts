import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');

interface Action {
  inputs: Record<string, { description: string; default?: string }>;
  outputs: Record<string, { value: string }>;
  runs: { steps: { name?: string; id?: string; if?: string; run?: string; shell?: string; env?: Record<string, string> }[] };
}

describe('GitHub Action: suggestions and mode fix', () => {
  it('declares suggestions (on by default), mode fix and the fix-pr output', async () => {
    const action = parse(await readFile(join(root, 'action.yml'), 'utf8')) as Action;
    expect(action.inputs.suggestions?.default).toBe('true');
    expect(action.inputs.mode!.description).toContain('`fix`');
    expect(action.outputs['fix-pr']?.value).toBe('${{ steps.fix.outputs.pr }}');
    const chooser = action.runs.steps.find((s) => s.id === 'mode')!;
    expect(chooser.run).toMatch(/check\|audit\|fix(\|release)?\) mode="\$MODE" ;;/);
  });

  it('suggests between the check and the comment, and fixes in fix mode with the CLI commands that exist', async () => {
    const action = parse(await readFile(join(root, 'action.yml'), 'utf8')) as Action;
    const names = action.runs.steps.map((s) => s.name);
    const suggest = names.indexOf('Suggest the fixes');
    expect(suggest).toBeGreaterThan(names.indexOf('Check the pull request'));
    expect(suggest).toBeLessThan(names.indexOf('Post or update the comment'));
    expect(action.runs.steps[suggest]!.if).toContain("inputs.suggestions == 'true'");
    expect(action.runs.steps[suggest]!.run).toContain('$CLI suggest "$PR_URL" --out');
    const fix = action.runs.steps.find((s) => s.id === 'fix')!;
    expect(fix.if).toBe("steps.mode.outputs.mode == 'fix'");
    expect(fix.run).toContain('$CLI fix-pr "$REPO" --json');
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    for (const cmd of ['fix', 'suggest', 'fix-pr']) expect(cli).toContain(`.command('${cmd}')`);
    expect(cli).toContain("'--json'");
  });

  it('ships the weekly fix workflow', async () => {
    const yml = await readFile(join(root, 'examples', 'staleproof-fix.yml'), 'utf8');
    const wf = parse(yml, { strict: true, uniqueKeys: true }) as { on: Record<string, unknown>; permissions: Record<string, string>; jobs: { fix: { steps: { uses: string; with: { mode: string } }[] } } };
    expect(Object.keys(wf.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
    expect(wf.jobs.fix.steps[0]).toMatchObject({ uses: 'rajkaria/staleproof@v1', with: { mode: 'fix' } });
  });

  it("puts the CLI's reason in the annotation when fix-pr fails, and passes its result on when it works", async () => {
    // Found on rajkaria/staleproof-action-test: the repository did not let GitHub Actions open pull requests, and the
    // annotation only said "the job needs contents: write and pull-requests: write", which the job had.
    const action = parse(await readFile(join(root, 'action.yml'), 'utf8')) as Action;
    const step = action.runs.steps.find((s) => s.id === 'fix')!;
    const run = async (cli: string) => {
      const tmp = await mkdtemp(join(tmpdir(), 'staleproof-fix-step-'));
      await writeFile(join(tmp, 'cli.sh'), cli);
      const env = { PATH: process.env.PATH!, RUNNER_TEMP: tmp, GITHUB_OUTPUT: join(tmp, 'out'), GITHUB_STEP_SUMMARY: join(tmp, 'summary'), GITHUB_TOKEN: 't', REPO: 'acme/app', CLI: `bash ${join(tmp, 'cli.sh')}` };
      const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run!], { env, encoding: 'utf8' });
      const out = await readFile(join(tmp, 'out'), 'utf8').catch(() => '');
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
    };
    const reason = 'GitHub Actions may not open pull requests in acme/app, so the fixes wait on the branch staleproof/fix-docs: turn on "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General → Workflow permissions), or pass a token as `github-token`.';
    const refused = await run(`echo 'linting acme/app' >&2\necho 'staleproof: ${reason}' >&2\nexit 1\n`);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(`::error::staleproof fix-pr failed: ${reason}. The job needs contents: write and pull-requests: write (see examples/staleproof-fix.yml).`);
    // The CLI's log still reaches the job log.
    expect(refused.stderr).toContain('linting acme/app');
    const silent = await run('exit 1\n');
    expect(silent.stdout).toContain('::error::staleproof fix-pr failed: see the log above. The job needs');
    const ok = await run(`echo 'cloning' >&2\necho '{"action":"opened","fixes":2,"pr":{"number":5,"url":"https://github.com/acme/app/pull/5"},"output":"Opened the fix pull request"}'\n`);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Opened the fix pull request');
    expect(ok.stderr).toContain('cloning');
    expect(ok.out).toBe('pr=https://github.com/acme/app/pull/5\nfixes=2\naction=opened\n');
  });
});
