import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/** The Action's release mode and digest. */
const root = join(import.meta.dirname, '..');

describe('GitHub Action: release mode and the digest', () => {
  it('declares the inputs and outputs, and runs the real commands', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const action = parse(yml) as { inputs: Record<string, { description: string; default?: string }>; outputs: Record<string, { value: string }>; runs: { steps: { name?: string; id?: string; run?: string; env?: Record<string, string> }[] } };
    for (const input of ['digest-webhook', 'release-from', 'release-to', 'release-fail-on', 'changelog']) expect(Object.keys(action.inputs)).toContain(input);
    expect(action.inputs['release-fail-on']!.default).toBe('undocumented-breaking,stale-docs');
    for (const output of ['breaking', 'undocumented', 'stale-docs']) expect(action.outputs[output]!.value).toContain('steps.release.outputs');
    const mode = action.runs.steps.find((s) => s.id === 'mode')!.run!;
    expect(mode).toMatch(/check\|audit(\|fix)?\|release\)/);
    const release = action.runs.steps.find((s) => s.name === 'Release gate')!;
    expect(release.run).toContain('$CLI release "$GITHUB_WORKSPACE"');
    const digest = action.runs.steps.find((s) => s.name === 'Post the docs digest')!;
    expect(digest.env!.STALEPROOF_DIGEST_WEBHOOK).toBe('${{ inputs.digest-webhook }}');
    // The webhook never appears on a command line.
    expect(digest.run).not.toContain('--webhook');
    const names = action.runs.steps.map((s) => s.name);
    expect(names.indexOf('Post the docs digest')).toBeLessThan(names.indexOf('Keep the audit issue up to date'));
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    for (const cmd of ["command('release')", "command('digest')"]) expect(cli).toContain(cmd);
  });

  it('the release workflow in examples/ runs on published releases with full history and no secrets', async () => {
    const text = await readFile(join(root, 'examples', 'staleproof-release.yml'), 'utf8');
    const wf = parse(text, { strict: true, uniqueKeys: true }) as {
      on: { release: { types: string[] }; workflow_dispatch: unknown };
      permissions: Record<string, string>;
      jobs: { release: { steps: { uses: string; with?: Record<string, unknown> }[] } };
    };
    expect(wf.on.release.types).toEqual(['published']);
    expect(wf.on.workflow_dispatch).toBeDefined();
    expect(wf.permissions).toEqual({ contents: 'read' });
    const [checkout, staleproof] = wf.jobs.release.steps;
    expect(checkout!.uses).toMatch(/^actions\/checkout@v\d/);
    expect(checkout!.with).toEqual({ 'fetch-depth': 0 });
    expect(staleproof!.uses).toMatch(/^rajkaria\/staleproof@v\d/);
    expect(staleproof!.with).toMatchObject({ mode: 'release' });
    expect(text).not.toMatch(/\$\{\{ secrets\./);
  });
});
