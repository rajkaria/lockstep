import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import staleproofPlugin, { PLUGIN_NAME, sitePath, sourcePath, validateOptions } from '../integrations/docusaurus/src/index.js';
import { makeStampFooter, refreshStamp } from '../integrations/docusaurus/src/stamp-slot.js';

/**
 * The Docusaurus plugin (integrations/docusaurus) against the lifecycle and theme APIs
 * Docusaurus 3 calls, with fakes for what only a Docusaurus build provides.
 */
const PKG = join(import.meta.dirname, '..', 'integrations', 'docusaurus');

describe('Docusaurus plugin', () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'staleproof-docusaurus-'));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'website'));
  });
  afterAll(async () => rm(repo, { recursive: true, force: true }));

  it('loads the stamp script on every page, with no referrer', () => {
    const plugin = staleproofPlugin({ siteDir: join(repo, 'website'), siteConfig: { organizationName: 'acme', projectName: 'app' } });
    expect(plugin.name).toBe(PLUGIN_NAME);
    expect(plugin.injectHtmlTags()).toEqual({
      postBodyTags: [{ tagName: 'script', attributes: { src: 'https://staleproof.dev/api/verified/acme/app/stamp.js', async: true, referrerpolicy: 'no-referrer' } }],
    });
    const own = staleproofPlugin({ siteDir: repo }, { repo: 'acme/docs', server: 'https://staleproof.example.com/' });
    expect(own.injectHtmlTags().postBodyTags[0]!.attributes.src).toBe('https://staleproof.example.com/api/verified/acme/docs/stamp.js');
  });

  it('shares the repository and the site folder with the theme', async () => {
    const data: unknown[] = [];
    await staleproofPlugin({ siteDir: join(repo, 'website') }, { repo: 'acme/app' }).contentLoaded({ actions: { setGlobalData: (d) => data.push(d) } });
    expect(data).toEqual([{ repo: 'acme/app', prefix: 'website' }]);
    expect(sitePath(repo)).toBe('');
    expect(sitePath(join(repo, 'website'))).toBe('website');
  });

  it('wraps DocItem/Footer from its theme path', () => {
    const theme = staleproofPlugin({ siteDir: repo }, { repo: 'acme/app' }).getThemePath();
    const footer = join(theme, 'DocItem', 'Footer', 'index.js');
    expect(existsSync(footer)).toBe(true);
    const src = readFileSync(footer, 'utf8');
    // A plugin's wrapper takes the theme's own component: @theme-original would resolve to the wrapper itself.
    expect(src).toContain("from '@theme-init/DocItem/Footer'");
    expect(src).toContain("from '@docusaurus/plugin-content-docs/client'");
  });

  it('validates its options and needs a repository', () => {
    expect(() => staleproofPlugin({ siteDir: repo })).toThrow('set the repo option');
    expect(() => validateOptions({ options: { repo: 'nope' } })).toThrow('repo must be "owner/name"');
    expect(() => validateOptions({ options: { repo: 'a/b', server: 'staleproof.dev' } })).toThrow('server must be an http(s) URL');
    // Docusaurus needs an id on every plugin instance.
    expect(validateOptions({ options: { repo: 'a/b' } })).toEqual({ id: 'default', repo: 'a/b' });
  });

  it('names each doc by its source file in the repository', () => {
    expect(sourcePath('@site/docs/intro.md', 'website')).toBe('website/docs/intro.md');
    expect(sourcePath('@site/versioned_docs/version-1.0/intro.mdx', '')).toBe('versioned_docs/version-1.0/intro.mdx');
    expect(sourcePath(undefined, 'website')).toBeUndefined();
  });

  it('renders the source meta and the stamp slot before the original footer', () => {
    const heads: React.ReactNode[] = [];
    const Footer = makeStampFooter({
      React,
      Head: ({ children }: { children?: unknown }) => (heads.push(children as React.ReactNode), null),
      useDoc: () => ({ metadata: { source: '@site/docs/guide/install.md' } }),
      usePluginData: () => ({ prefix: 'website' }),
      Original: () => React.createElement('footer', null, 'Edit this page'),
    }) as React.FC;
    const html = renderToStaticMarkup(React.createElement(Footer));
    expect(html).toBe('<div class="staleproof-stamp-slot" data-staleproof-stamp="" data-path="website/docs/guide/install.md"></div><footer>Edit this page</footer>');
    expect(renderToStaticMarkup(React.createElement(React.Fragment, null, heads))).toBe('<meta name="staleproof:source" content="website/docs/guide/install.md"/>');
  });

  it('keeps a stamp the script added before hydration: no mismatch, no client re-render', async () => {
    const { JSDOM } = await import('jsdom');
    const Footer = makeStampFooter({
      React,
      Head: () => null,
      useDoc: () => ({ metadata: { source: '@site/docs/intro.md' } }),
      usePluginData: () => ({ prefix: '' }),
      Original: () => React.createElement('footer', null, 'Edit this page'),
    }) as React.FC;
    const html = renderToStaticMarkup(React.createElement(Footer));
    const dom = new JSDOM(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
    const g = globalThis as Record<string, unknown>;
    const saved = { window: g.window, document: g.document, act: g.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(g, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    try {
      // The stamp script got there first.
      const slot = dom.window.document.querySelector('[data-staleproof-stamp]')!;
      slot.innerHTML = '<aside class="sp-stamp">✓ checked</aside>';
      const errors: unknown[] = [];
      let stamps = 0;
      (dom.window as unknown as { StaleproofStamp: () => void }).StaleproofStamp = () => void stamps++;
      const { hydrateRoot } = await import('react-dom/client');
      await React.act(async () => {
        hydrateRoot(dom.window.document.getElementById('root')!, React.createElement(Footer), { onRecoverableError: (e) => errors.push(e) });
      });
      expect(errors).toEqual([]);
      expect(slot.isConnected).toBe(true);
      expect(slot.innerHTML).toBe('<aside class="sp-stamp">✓ checked</aside>');
      // The effect asks the script to render (client-side navigation lands here too).
      expect(stamps).toBe(1);
    } finally {
      Object.assign(g, { window: saved.window, document: saved.document, IS_REACT_ACT_ENVIRONMENT: saved.act });
    }
  });

  it('renders the stamp again after navigation once the script is there', () => {
    let calls = 0;
    refreshStamp(undefined);
    refreshStamp({});
    refreshStamp({ StaleproofStamp: () => calls++ });
    expect(calls).toBe(1);
  });

  it('is a publishable package', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { name: string; files: string[]; peerDependencies: Record<string, string>; dependencies?: unknown };
    expect(pkg.name).toBe('docusaurus-plugin-staleproof');
    expect(pkg.files).toEqual(['src', 'README.md']);
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies)).toContain('@docusaurus/core');
  });
});

/**
 * A real Docusaurus 3 build with the packed plugin (`npm pack`, as users install it). Slow and
 * networked (create-docusaurus, ~1,300 packages), so opt-in: STALEPROOF_DOCUSAURUS_BUILD=1.
 */
describe.skipIf(process.env.STALEPROOF_DOCUSAURUS_BUILD !== '1')('Docusaurus plugin: a real docusaurus build (STALEPROOF_DOCUSAURUS_BUILD=1)', () => {
  let tmp: string;
  let site: string;
  beforeAll(async () => {
    const { spawnSync } = await import('node:child_process');
    const { readFileSync: read, writeFileSync: write } = await import('node:fs');
    tmp = await mkdtemp(join(tmpdir(), 'staleproof-docusaurus-build-'));
    const run = (cmd: string, args: string[], cwd: string) => {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000 });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    };
    run('npx', ['--yes', 'create-docusaurus@3', 'site', 'classic', '--javascript', '--skip-install'], tmp);
    site = join(tmp, 'site');
    run('npm', ['pack', '--pack-destination', tmp], PKG);
    run('npm', ['install', '--no-audit', '--no-fund'], site);
    run('npm', ['install', '--no-audit', '--no-fund', join(tmp, 'docusaurus-plugin-staleproof-0.1.0.tgz')], site);
    const config = join(site, 'docusaurus.config.js');
    write(config, read(config, 'utf8').replace(/organizationName: '[^']*',/, "organizationName: 'acme',\n  plugins: [['docusaurus-plugin-staleproof', { repo: 'acme/app' }]],"));
    run('npx', ['docusaurus', 'build'], site);
  }, 900_000);
  afterAll(async () => tmp && rm(tmp, { recursive: true, force: true }));

  it('puts the source meta, the slot and the script on each doc page', () => {
    const html = readFileSync(join(site, 'build', 'docs', 'intro', 'index.html'), 'utf8');
    // Minified HTML: attributes may be unquoted, and react-helmet adds its own (data-rh) first.
    expect(html).toMatch(/<meta[^>]* name="?staleproof:source"? content="?docs\/intro\.mdx"?/);
    expect(html).toMatch(/<div class="?staleproof-stamp-slot"? data-staleproof-stamp(="")? data-path="?docs\/intro\.mdx"?>/);
    expect(html).toMatch(/<script src="?https:\/\/staleproof\.dev\/api\/verified\/acme\/app\/stamp\.js"? async referrerpolicy="?no-referrer"?>/);
  });
});
