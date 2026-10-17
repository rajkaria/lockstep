import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');

describe('GitHub Action', () => {
  it('is valid YAML with the shape GitHub loads (a broken manifest fails every run)', async () => {
    for (const file of ['action.yml', 'examples/staleproof.yml', 'examples/staleproof-fix.yml', 'examples/staleproof-release.yml']) {
      const text = await readFile(join(root, file), 'utf8');
      expect(() => parse(text, { strict: true, uniqueKeys: true }), file).not.toThrow();
    }
    const action = parse(await readFile(join(root, 'action.yml'), 'utf8')) as {
      description: string;
      inputs: Record<string, { description: string; default?: string }>;
      outputs: Record<string, { value: string }>;
      runs: { using: string; steps: { name?: string; uses?: string; run?: string; shell?: string }[] };
    };
    expect(action.runs.using).toBe('composite');
    // The Marketplace refuses a description over 125 characters.
    expect(action.description.length).toBeLessThanOrEqual(125);
    for (const [name, input] of Object.entries(action.inputs)) expect(typeof input.description, name).toBe('string');
    // Composite run steps must name their shell.
    for (const step of action.runs.steps) if (step.run) expect(step.shell, step.name).toBe('bash');
    // Every input the steps read is declared.
    const used = [...JSON.stringify(action.runs).matchAll(/inputs\.([a-z-]+)/g)].map((m) => m[1]!);
    for (const name of new Set(used)) expect(Object.keys(action.inputs), name).toContain(name);
    const workflow = parse(await readFile(join(root, 'examples', 'staleproof.yml'), 'utf8')) as { jobs: { docs: { steps: { uses: string }[] } } };
    expect(workflow.jobs.docs.steps[0]!.uses).toBe('rajkaria/staleproof@v1');
  });

  it('lives at the repository root, so `uses: rajkaria/staleproof@v1` works', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    expect(yml).toContain('using: composite');
    // Zero configuration: no input is required.
    expect(yml).not.toMatch(/required: true/);
    for (const input of ['mode:', 'also-index:', 'anthropic-api-key:', 'model:', 'base-url:', 'runs:', 'fail-on:', 'fail-under:', 'audit-runs:', 'issue:', 'open-docs-pr:', 'suggestions:', 'comment:', 'pr-url:', 'falkordb-url:', 'org:', 'reindex:', 'github-token:', 'version:', 'digest-webhook:', 'release-from:', 'release-to:', 'release-fail-on:', 'changelog:']) {
      expect(yml).toContain(`\n  ${input}`);
    }
  });

  it('calls real CLI commands and flags', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    for (const cmd of ['index', 'check', 'audit', 'patch', 'suggest', 'fix-pr', 'digest', 'release']) expect(cli).toContain(`.command('${cmd}')`);
    for (const flag of ['--no-agent', '--format', '--out', '--runs', '--with', '--run', '--open-pr', '--in-repo', '--base', '--only']) {
      expect(yml).toContain(flag);
      expect(cli).toContain(`'${flag}`);
    }
  });

  it('runs the published version of this commit by default', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(yml).toMatch(new RegExp(`version:\\n    description: [^\\n]+\\n    default: '${pkg.version.replace(/\./g, '\\.')}'`));
  });

  it('updates its own comment, found by the marker the report starts with', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const { COMMENT_MARKER } = await import('../src/format/markdown.js');
    expect(COMMENT_MARKER).toBe('<!-- staleproof -->');
    expect(yml).toContain(`startswith("${COMMENT_MARKER}")`);
    // The breaks output counts the rows the report marks as breaking.
    expect(yml).toContain("grep -c '| \\*\\*breaks\\*\\*'");
  });

  it('reads breaks and predicted from the counts line the report ends with', async () => {
    const { execFileSync } = await import('node:child_process');
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    expect(yml).toContain('<!-- staleproof:counts');
    const counts = '<!-- staleproof:counts breaks=2 predicted=5 sections=9 mismatched=1 -->';
    const sh = (expr: string) => execFileSync('bash', ['-c', `counts='${counts}'; echo "$counts" | sed -E '${expr}'`], { encoding: 'utf8' }).trim();
    const breaksExpr = /breaks=\$\(echo "\$counts" \| sed -E '([^']+)'\)/.exec(yml)![1]!;
    const predictedExpr = /predicted=\$\(echo "\$counts" \| sed -E '([^']+)'\)/.exec(yml)![1]!;
    expect(sh(breaksExpr)).toBe('2');
    expect(sh(predictedExpr)).toBe('5');
  });

  it('annotates and counts the docs references a pull request makes wrong, and can fail on them', async () => {
    const { execFileSync } = await import('node:child_process');
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    const action = parse(yml) as { outputs: Record<string, { value: string }>; runs: { steps: { name?: string; if?: string }[] } };
    expect(action.outputs.findings!.value).toBe('${{ steps.check.outputs.findings }}');
    // The flag is passed only when the installed CLI has it (an older pinned version keeps working).
    expect(yml).toContain("grep -q -- '--annotations' <<< \"$help\"");
    expect(cli).toContain(".option('--annotations'");
    const line = '<!-- staleproof:findings new=3 errors=2 warnings=1 -->';
    const sh = (name: string) => {
      const expr = new RegExp(`${name}=\\$\\(echo "\\$lint" \\| sed -E '([^']+)'\\)`).exec(yml)![1]!;
      return execFileSync('bash', ['-c', `lint='${line}'; echo "$lint" | sed -E '${expr}'`], { encoding: 'utf8' }).trim();
    };
    expect([sh('findings'), sh('finding_errors')]).toEqual(['3', '2']);
    expect(yml).toContain("grep -o '<!-- staleproof:findings [^>]*-->'");
    const fail = action.runs.steps.find((s) => s.name === 'Fail on docs references the pull request makes wrong')!;
    expect(fail.if).toContain("inputs.fail-on == 'findings'");
  });

  it('reads score and counts from the line the audit report ends with', async () => {
    const { execFileSync } = await import('node:child_process');
    const { auditMarkdown } = await import('../src/format/audit.js');
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const md = auditMarkdown(
      {
        org: 'o', repos: [{ name: 'a/b', sha: 'abc', symbols: 1, sections: 1 }], score: 61, grade: 'D', deductions: [],
        examples: { total: 3, python: 3, linked: 3, mismatched: 2 }, mismatches: [], coverage: { api: 1, documented: 1, percent: 100 },
        undocumented: [], runs: [], runCounts: { pass: 0, fail: 4, skipped: 0, error: 0 }, generatedAt: 0,
      },
      's',
    );
    const counts = /<!-- staleproof:audit [^>]*-->/.exec(md)![0];
    const sh = (name: string) => {
      const expr = new RegExp(`${name}=\\$\\(echo "\\$counts" \\| sed -E '([^']+)'\\)`).exec(yml)![1]!;
      return execFileSync('bash', ['-c', `counts='${counts}'; echo "$counts" | sed -E '${expr}'`], { encoding: 'utf8' }).trim();
    };
    expect([sh('score'), sh('mismatched'), sh('failing')]).toEqual(['61', '2', '4']);
  });

  it('the audit workflow in examples/ runs on a schedule with issues write and no secrets', async () => {
    const wf = await readFile(join(root, 'examples', 'staleproof-audit.yml'), 'utf8');
    expect(wf).toMatch(/uses: rajkaria\/staleproof@v\d/);
    expect(wf).toContain('schedule:');
    expect(wf).toContain('issues: write');
    expect(wf).not.toMatch(/^\s+[a-z-]+: \$\{\{ secrets\./m);
  });

  it('the install workflow in examples/ uses the root action and needs no secrets', async () => {
    const wf = await readFile(join(root, 'examples', 'staleproof.yml'), 'utf8');
    expect(wf).toMatch(/uses: rajkaria\/staleproof@v\d/);
    expect(wf).toContain('pull-requests: write');
    expect(wf).not.toMatch(/^\s+[a-z-]+: \$\{\{ secrets\./m);
  });
});
