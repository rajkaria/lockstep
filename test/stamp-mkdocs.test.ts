import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, ResourceLoader } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stampScript } from '../src/server/stamp.js';

/**
 * The MkDocs plugin (integrations/mkdocs) in a real `mkdocs build`, in a throwaway uv
 * environment: MkDocs from PyPI and the plugin installed from this checkout. Skipped,
 * saying so, only when uv is not installed.
 */
const PLUGIN = join(import.meta.dirname, '..', 'integrations', 'mkdocs');
const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
const haveUv = uv.status === 0;
if (!haveUv) console.warn('stamp-mkdocs: uv is not installed, so the real `mkdocs build` test is skipped (install uv: https://docs.astral.sh/uv/)');

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, VIRTUAL_ENV: undefined, UV_NO_PROGRESS: '1' }, timeout: 300_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return `${r.stdout}${r.stderr}`;
}

describe.skipIf(!haveUv)('MkDocs plugin: a real mkdocs build', () => {
  let dir: string;
  let site: string;
  let buildLog: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-mkdocs-'));
    // The site lives in website/ of the repository: source paths are repository-relative.
    mkdirSync(join(dir, '.git'));
    const web = join(dir, 'website');
    mkdirSync(join(web, 'docs', 'guide'), { recursive: true });
    writeFileSync(
      join(web, 'mkdocs.yml'),
      ['site_name: Acme', 'repo_url: https://github.com/acme/app', 'use_directory_urls: true', 'plugins:', '  - staleproof', ''].join('\n'),
    );
    writeFileSync(join(web, 'docs', 'index.md'), '# Acme\n\nWelcome.\n');
    writeFileSync(join(web, 'docs', 'guide', 'install.md'), '# Install\n\nRun the installer.\n');
    run('uv', ['venv', '--quiet', join(dir, 'venv')], dir);
    const py = join(dir, 'venv', 'bin', 'python');
    run('uv', ['pip', 'install', '--quiet', '--python', py, 'mkdocs>=1.5', PLUGIN], dir);
    buildLog = run(join(dir, 'venv', 'bin', 'mkdocs'), ['build', '--strict', '-f', 'mkdocs.yml', '-d', 'site'], web);
    site = join(web, 'site');
  }, 360_000);
  afterAll(async () => dir && rm(dir, { recursive: true, force: true }));

  it('builds cleanly with the plugin', () => {
    expect(buildLog).not.toMatch(/WARNING/);
  });

  it('adds the source meta, the stamp slot under the title, and the script', async () => {
    const html = await readFile(join(site, 'guide', 'install', 'index.html'), 'utf8');
    expect(html).toContain('<meta name="staleproof:source" content="website/docs/guide/install.md">');
    expect(html).toMatch(/<h1[^>]*>Install<\/h1>\s*<div class="staleproof-stamp-slot" data-staleproof-stamp data-path="website\/docs\/guide\/install.md"><\/div>/);
    expect(html).toContain('<script src="https://staleproof.dev/api/verified/acme/app/stamp.js" async referrerpolicy="no-referrer"></script>');
    const home = await readFile(join(site, 'index.html'), 'utf8');
    expect(home).toContain('content="website/docs/index.md"');
  });

  it('renders the stamp on the built page', async () => {
    const html = await readFile(join(site, 'guide', 'install', 'index.html'), 'utf8');
    const requests: string[] = [];
    class Loader extends ResourceLoader {
      override fetch(url: string) {
        requests.push(url);
        const body = url.endsWith('/stamp.js') ? stampScript('acme/app') : '';
        return Promise.resolve(Buffer.from(body)) as ReturnType<ResourceLoader['fetch']>;
      }
    }
    const dom = new JSDOM(html, {
      url: 'https://acme.github.io/app/guide/install/',
      runScripts: 'dangerously',
      resources: new Loader(),
      beforeParse(window) {
        (window as unknown as { fetch: unknown }).fetch = async (url: string) => {
          requests.push(url);
          return {
            ok: true,
            json: async () => ({
              version: 1,
              repo: 'acme/app',
              sha: 'abc1234def',
              checkedAt: Date.now() - 3 * 3600_000,
              score: 100,
              grade: 'A',
              checks: { references: true, examples: true },
              pages: [{ path: 'website/docs/guide/install.md', status: 'checked', findings: 0, mismatches: 0, examples: 0, sha: 'abc1234def', checkedAt: Date.now() - 3 * 3600_000 }],
            }),
          };
        };
      },
    });
    await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve()));
    await (dom.window as unknown as { StaleproofStamp: () => Promise<void> }).StaleproofStamp();
    const stamp = dom.window.document.querySelector('.staleproof-stamp-slot .sp-stamp');
    expect(stamp?.textContent?.replace(/\s+/g, ' ')).toBe('✓ References checked against abc1234 · 3 hours ago · Staleproof');
    expect(requests).toContain('https://staleproof.dev/api/verified/acme/app.json');
  });
});
