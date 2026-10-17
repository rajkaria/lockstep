import { JSDOM, ResourceLoader, type FetchOptions } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { stampScript, STAMP_MAX_BYTES } from '../src/server/stamp.js';
import type { VerifiedData, VerifiedPage } from '../src/server/verified.js';

const DAY = 86_400_000;
const SHA = 'abc1234def567890abc1234def567890abc12345';

function data(pages: Partial<VerifiedPage>[], checks = { references: true, examples: true }): VerifiedData {
  const checkedAt = Date.now() - 2 * DAY - 60_000;
  return {
    version: 1,
    repo: 'acme/app',
    sha: SHA,
    checkedAt,
    score: 90,
    grade: 'A',
    checks,
    pages: pages.map((p) => ({ path: 'docs/install.md', status: 'checked', findings: 0, mismatches: 0, examples: 2, sha: SHA, checkedAt, ...p })),
  };
}

interface Rendered {
  dom: JSDOM;
  doc: Document;
  stamp: HTMLElement | null;
  text: string;
  requests: { url: string; init: RequestInit }[];
}

/**
 * A docs page in jsdom with the stamp inline (`attrs` on its script tag) and `fetch`
 * answering the verified JSON (`null`: a 404).
 */
async function render(body: string, json: VerifiedData | null, opts: { attrs?: string; head?: string; url?: string } = {}): Promise<Rendered> {
  const requests: Rendered['requests'] = [];
  const html = `<!doctype html><html><head>${opts.head ?? ''}</head><body>${body}<script ${opts.attrs ?? ''}>${stampScript('acme/app')}</script></body></html>`;
  const dom = new JSDOM(html, {
    url: opts.url ?? 'https://docs.acme.dev/guide/install/',
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return { ok: json !== null, json: async () => json };
      };
    },
  });
  const w = dom.window as unknown as { StaleproofStamp: () => Promise<void> };
  await w.StaleproofStamp();
  const doc = dom.window.document;
  const stamp = doc.querySelector<HTMLElement>('.sp-stamp');
  return { dom, doc, stamp, text: (stamp?.textContent ?? '').replace(/\s+/g, ' ').trim(), requests };
}

const ARTICLE = '<main><article><h1>Install</h1><p>Steps.</p></article></main>';
const META = '<meta name="staleproof:source" content="docs/install.md">';

describe('stamp script', () => {
  it('renders the checked state exactly, after the page title', async () => {
    const r = await render(ARTICLE, data([{}]), { head: META });
    expect(r.text).toBe('✓ Examples and references checked against abc1234 · 2 days ago · Staleproof');
    expect(r.stamp!.getAttribute('data-state')).toBe('checked');
    expect(r.stamp!.previousElementSibling!.tagName).toBe('H1');
    expect(r.stamp!.closest('article')).not.toBeNull();
  });

  it('says only what was checked: references alone, examples alone, and runs only when they ran', async () => {
    expect((await render(ARTICLE, data([{ examples: 0 }]), { head: META })).text).toBe('✓ References checked against abc1234 · 2 days ago · Staleproof');
    expect((await render(ARTICLE, data([{}], { references: false, examples: true }), { head: META })).text).toBe(
      '✓ Examples checked against abc1234 · 2 days ago · Staleproof',
    );
    const ran = await render(ARTICLE, data([{ runs: { pass: 3, fail: 0 } }]), { head: META });
    expect(ran.text).toBe('✓ Examples and references checked against abc1234 · 3 examples ran · 2 days ago · Staleproof');
    expect((await render(ARTICLE, data([{}]), { head: META })).text).not.toMatch(/ran|run|verified/i);
  });

  it('renders the drift state with what is out of date', async () => {
    const r = await render(ARTICLE, data([{ status: 'drift', findings: 1, mismatches: 1 }]), { head: META });
    expect(r.text).toBe('⚠ 2 references on this page are out of date · checked against abc1234 · 2 days ago · Staleproof');
    expect(r.stamp!.getAttribute('data-state')).toBe('drift');
    expect(r.stamp!.className).toBe('sp-stamp sp-drift');
    expect((await render(ARTICLE, data([{ status: 'drift', findings: 1 }]), { head: META })).text).toMatch(/^⚠ 1 reference on this page is out of date ·/);
    expect((await render(ARTICLE, data([{ status: 'drift', findings: 1, runs: { pass: 0, fail: 2 } }]), { head: META })).text).toMatch(
      /^⚠ 1 reference on this page is out of date · 2 examples fail when run · checked against abc1234/,
    );
    expect((await render(ARTICLE, data([{ status: 'drift', runs: { pass: 1, fail: 1 } }]), { head: META })).text).toBe(
      '⚠ 1 example on this page fails when run · checked against abc1234 · 2 days ago · Staleproof',
    );
  });

  it('renders nothing without data: an unknown page, an unaudited repository, no source path', async () => {
    expect((await render(ARTICLE, data([{ path: 'docs/other.md' }]), { head: META })).stamp).toBeNull();
    const none = await render(ARTICLE, null, { head: META });
    expect(none.stamp).toBeNull();
    expect(none.doc.getElementById('sp-css')).toBeNull();
    expect((await render(ARTICLE, data([{}]))).stamp).toBeNull();
  });

  it('finds the source from a slot, the meta tag, data-path, or a data-map URL pattern', async () => {
    const slot = await render(`${ARTICLE}<div id="slot" data-staleproof-stamp data-path="docs/install.md"></div>`, data([{}]), { head: '<meta name="staleproof:source" content="docs/other.md">' });
    expect(slot.stamp!.parentElement!.id).toBe('slot');
    expect((await render(ARTICLE, data([{}]), { attrs: 'data-path="docs/install.md"' })).stamp).not.toBeNull();
    expect((await render(ARTICLE, data([{ path: 'docs/install.md' }]), { attrs: 'data-path="./docs/install.md"' })).stamp).not.toBeNull();
    // /guide/install/ → docs/guide/install.md, then docs/guide/install/index.md
    const mapped = await render(ARTICLE, data([{ path: 'docs/guide/install/index.md' }]), { attrs: 'data-map="docs/{path}.md docs/{path}/index.md"' });
    expect(mapped.stamp).not.toBeNull();
    const based = await render(ARTICLE, data([{ path: 'site/install.mdx' }]), { attrs: 'data-map="site/{path}.mdx" data-base="/guide/"' });
    expect(based.stamp).not.toBeNull();
    const home = await render(ARTICLE, data([{ path: 'docs/index.md' }]), { attrs: 'data-map="docs/{path}.md"', url: 'https://docs.acme.dev/' });
    expect(home.stamp).not.toBeNull();
    const target = await render(`${ARTICLE}<footer id="f"></footer>`, data([{}]), { head: META, attrs: 'data-target="#f"' });
    expect(target.stamp!.parentElement!.id).toBe('f');
    const bare = await render('<p>No title here.</p>', data([{}]), { head: META });
    expect(bare.stamp!.parentElement!.tagName).toBe('BODY');
  });

  it('renders again after client-side navigation, replacing the old stamp', async () => {
    const r = await render(ARTICLE, data([{}, { path: 'docs/api.md', status: 'drift', mismatches: 3 }]), { head: META });
    r.doc.querySelector('meta[name="staleproof:source"]')!.setAttribute('content', 'docs/api.md');
    await (r.dom.window as unknown as { StaleproofStamp: () => Promise<void> }).StaleproofStamp();
    const stamps = r.doc.querySelectorAll('.sp-stamp');
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.textContent).toMatch(/^⚠ 3 references on this page are out of date/);
    // The JSON is fetched once per page load.
    expect(r.requests).toHaveLength(1);
  });

  it('is accessible: a labelled landmark, a hidden icon, a machine-readable time, a real link', async () => {
    const d = data([{}]);
    const r = await render(ARTICLE, d, { head: META });
    expect(r.stamp!.tagName).toBe('ASIDE');
    expect(r.stamp!.getAttribute('aria-label')).toBe('Staleproof docs check');
    expect(r.stamp!.querySelector('.sp-i')!.getAttribute('aria-hidden')).toBe('true');
    const time = r.stamp!.querySelector('time')!;
    expect(new Date(time.getAttribute('datetime')!).getTime()).toBe(d.pages[0]!.checkedAt);
    const a = r.stamp!.querySelector('a')!;
    expect(a.href).toBe('https://docs.acme.dev/#/audit?repo=acme%2Fapp');
    expect(r.stamp!.querySelector('code')!.textContent).toBe('abc1234');
  });

  it('is light/dark aware', async () => {
    const r = await render(ARTICLE, data([{}]), { head: META });
    const css = r.doc.getElementById('sp-css')!.textContent!;
    expect(css).toContain('@media(prefers-color-scheme:dark)');
    for (const site of ['[data-theme=dark]', '.dark', '[data-md-color-scheme=slate]']) expect(css).toContain(site);
    // Text keeps the site's own colour in both themes; only the icon and border are tinted.
    expect(css).not.toMatch(/\.sp-stamp\{[^}]*(?:^|[;{])color:/);
  });

  it('sets no cookies, uses no storage, sends no referrer or credentials, reports nothing', async () => {
    const js = stampScript('acme/app');
    for (const banned of ['cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'sendBeacon', 'XMLHttpRequest', 'navigator', 'Image(']) expect(js).not.toContain(banned);
    const r = await render(ARTICLE, data([{}]), { head: META });
    expect(r.requests).toEqual([{ url: 'https://docs.acme.dev/api/verified/acme/app.json', init: { credentials: 'omit', referrerPolicy: 'no-referrer' } }]);
    expect(r.doc.cookie).toBe('');
  });

  it('stays under 4 KB for the longest GitHub names, and cannot be broken out of', () => {
    expect(Buffer.byteLength(stampScript(`${'o'.repeat(39)}/${'r'.repeat(100)}`))).toBeLessThan(STAMP_MAX_BYTES);
    expect(stampScript('a/</script><script>alert(1)//')).not.toContain('</script>');
  });

  it('loads from staleproof.dev into another site and asks staleproof.dev', async () => {
    const requests: string[] = [];
    class Loader extends ResourceLoader {
      override fetch(url: string, _options: FetchOptions) {
        requests.push(url);
        return Promise.resolve(Buffer.from(stampScript('acme/app'))) as ReturnType<ResourceLoader['fetch']>;
      }
    }
    const dom = new JSDOM(
      `<!doctype html><html><head>${META}</head><body>${ARTICLE}<script src="https://staleproof.dev/api/verified/acme/app/stamp.js" async referrerpolicy="no-referrer"></script></body></html>`,
      {
        url: 'https://docs.acme.dev/install',
        runScripts: 'dangerously',
        resources: new Loader(),
        beforeParse(window) {
          (window as unknown as { fetch: unknown }).fetch = async (url: string) => {
            requests.push(url);
            return { ok: true, json: async () => data([{}]) };
          };
        },
      },
    );
    await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve()));
    await (dom.window as unknown as { StaleproofStamp: () => Promise<void> }).StaleproofStamp();
    expect(requests).toEqual(['https://staleproof.dev/api/verified/acme/app/stamp.js', 'https://staleproof.dev/api/verified/acme/app.json']);
    expect(dom.window.document.querySelector('.sp-stamp a')!.getAttribute('href')).toBe('https://staleproof.dev/#/audit?repo=acme%2Fapp');
  });
});
