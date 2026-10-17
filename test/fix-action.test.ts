import { readFile } from 'node:fs/promises';
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
});
