import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dirname, '..');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

async function action(): Promise<{ inputs: Record<string, { default: string }>; runs: { steps: Step[] } }> {
  return parseYaml(await readFile(join(ROOT, 'action.yml'), 'utf8')) as never;
}

describe('action.yml caches the graph and the parse cache', () => {
  it('computes the cache key under the runner\'s bash -e -o pipefail, with and without also-index', async () => {
    const step = (await action()).runs.steps.find((s) => s.name === 'Cache key')!;
    const key = async (WITH: string) => {
      const tmp = await mkdtemp(join(tmpdir(), 'staleproof-cache-key-'));
      const env = { PATH: process.env.PATH!, RUNNER_TEMP: tmp, GITHUB_OUTPUT: join(tmp, 'out'), GITHUB_ENV: join(tmp, 'env'), VERSION: 'source', ACTION_REF: 'main', REPO: 'acme/app', WITH, BASE: 'abc123' };
      // sha256sum is GNU coreutils; macOS has shasum.
      const script = step.run!.replace(/sha256sum/g, 'shasum -a 256');
      execFileSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { env });
      return Object.fromEntries((await readFile(join(tmp, 'out'), 'utf8')).trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    };
    const none = await key('');
    expect(none.key).toMatch(/^staleproof-source-main-acme\/app-[0-9a-f]{10}-abc123$/);
    const two = await key('acme/docs, acme/sdk');
    expect(two.prefix).not.toBe(none.prefix);
    expect((await key('acme/sdk acme/docs')).prefix).toBe(two.prefix);
  });

  it('restores before FalkorDB starts and saves at the end, whatever the result', async () => {
    const a = await action();
    expect(a.inputs.cache!.default).toBe('true');
    const names = a.runs.steps.map((s) => s.name ?? s.uses);
    const at = (n: string) => names.indexOf(n);
    expect(at('Cache key')).toBeGreaterThan(-1);
    expect(at('Restore the graph and the parse cache')).toBeLessThan(at('Start FalkorDB'));
    expect(at('Use the restored graph')).toBeGreaterThan(at('Install staleproof'));
    expect(at('Use the restored graph')).toBeLessThan(at('Check the pull request'));
    expect(names.slice(-2)).toEqual(['Prepare the graph for the cache', 'Save the graph and the parse cache']);

    const step = (n: string) => a.runs.steps.find((s) => s.name === n)!;
    expect(step('Cache key').if).toBe("inputs.cache == 'true' && inputs.falkordb-url == ''");
    expect(step('Restore the graph and the parse cache')).toMatchObject({
      uses: 'actions/cache/restore@v6',
      with: { key: '${{ steps.cache-key.outputs.key }}', 'restore-keys': '${{ steps.cache-key.outputs.prefix }}' },
    });
    expect(step('Save the graph and the parse cache')).toMatchObject({ uses: 'actions/cache/save@v6' });
    expect(step('Save the graph and the parse cache').if).toMatch(/^always\(\) && /);
    expect(step('Prepare the graph for the cache').if).toMatch(/^always\(\) && .*cache-hit != 'true'/);
  });

  it('keys by Staleproof version, repository, also-index and base commit, base last so older dumps match', async () => {
    const key = (await action()).runs.steps.find((s) => s.name === 'Cache key')!;
    expect(key.env).toMatchObject({ VERSION: '${{ inputs.version }}', REPO: '${{ github.repository }}', WITH: '${{ inputs.also-index }}', BASE: '${{ github.event.pull_request.base.sha || github.sha }}' });
    expect(key.run).toContain('prefix="staleproof-${version}-${REPO}-${with_hash}-"');
    expect(key.run).toContain('echo "key=${prefix}${BASE}"');
    // The CLI keeps its parse cache there (src/lint/cache.ts reads STALEPROOF_CACHE_DIR when indexing).
    expect(key.run).toContain('STALEPROOF_CACHE_DIR=$dir/parse');
    const src = await readFile(join(ROOT, 'src', 'lint', 'cache.ts'), 'utf8');
    expect(src).toContain("setting('CACHE_DIR')");
  });

  it("mounts the cached folder as FalkorDB's data folder, and re-indexes a dump of an older base", async () => {
    const steps = (await action()).runs.steps;
    const start = steps.find((s) => s.name === 'Start FalkorDB')!;
    expect(start.run).toContain('data=(-v "$GRAPH_DATA:/var/lib/falkordb/data")');
    expect(start.run).toContain('"${data[@]}" falkordb/falkordb:latest');
    const use = steps.find((s) => s.name === 'Use the restored graph')!;
    expect(use.if).toBe("steps.cache-restore.outputs.cache-matched-key != ''");
    expect(use.run).toContain('$CLI index "$REPO"');
    expect(use.run).toContain('redis FLUSHALL');
    const prepare = steps.find((s) => s.name === 'Prepare the graph for the cache')!;
    expect(prepare.run).toContain('redis-cli SAVE');
    expect(prepare.run).toContain('$CLI --version > "$DIR/falkordb/staleproof-version"');
  });
});
