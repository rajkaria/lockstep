import { describe, expect, it } from 'vitest';
import { unifiedDiff, type DocsPatch } from '../src/patch.js';
import { openDocsPr, rebaseEdit } from '../src/pr/open-pr.js';

/**
 * `open-docs-pr` writes into the checked pull request's own branch. The edits were written against
 * the indexed default branch; the branch may have changed the same files (found on
 * rajkaria/staleproof-action-test#6, where the docs pull request reverted the pull request's own
 * README edit). Each edit is re-applied like `git apply`, or the file is left out.
 */

const doc = (sections: string[]) => `${sections.join('\n\n')}\n`;
const BEFORE = doc(['# Guide', '## Query', 'Call `client.ro_query("Person")`.', '## Write', 'Call `client.add(label="City")`.', '## Async', 'Await `client.aquery`.']);

function file(path: string, before: string, after: string, sha = 'a'.repeat(40)) {
  return { repo: 'acme/app', path, sha, before, after, diff: unifiedDiff(path, before, after), sections: [`acme/app:${path}#x`] };
}

describe('rebaseEdit', () => {
  const after = BEFORE.replace('Call `client.add(label="City")`.', 'Call `client.add(label="City", name="Pune")`.');
  const f = file('README.md', BEFORE, after);

  it('writes the edited file when the branch has the file as it was indexed', () => {
    expect(rebaseEdit(f, BEFORE)).toBe(after);
  });

  it("applies the edit on top of the branch's own changes elsewhere in the file", () => {
    const branch = BEFORE.replace('# Guide', '# Guide\n\nA new intro line.\n\nAnother one.').replace('Await `client.aquery`.', 'Await `client.aquery()` in a coroutine.');
    const out = rebaseEdit(f, branch)!;
    expect(out).toContain('A new intro line.');
    expect(out).toContain('Await `client.aquery()` in a coroutine.');
    expect(out).toContain('Call `client.add(label="City", name="Pune")`.');
  });

  it('refuses when the branch changed the lines the edit replaces or their context', () => {
    expect(rebaseEdit(f, BEFORE.replace('Call `client.add(label="City")`.', 'Call `client.add(label="Town")`.'))).toBeUndefined();
    expect(rebaseEdit(f, BEFORE.replace('## Write', '## Writing'))).toBeUndefined();
  });
});

describe('openDocsPr same-repo into a branch that changed some of the files', () => {
  it('opens the pull request with the files that apply and names the ones left out', async () => {
    const readmeAfter = BEFORE.replace('Call `client.add(label="City")`.', 'Call `client.add(label="City", name="Pune")`.');
    const usage = doc(['# Usage', 'Run `npm run docs`.']);
    const usageAfter = usage.replace('npm run docs', 'npm run docs:build');
    const patch: DocsPatch = {
      pr: { url: 'https://github.com/acme/app/pull/3', title: 'Rename', repo: 'acme/app', number: 3 },
      files: [file('README.md', BEFORE, readmeAfter), file('docs/usage.md', usage, usageAfter)],
      diff: '',
      title: 'docs: update for acme/app#3 (Rename)',
      body: 'Edits.',
      verdicts: [],
      conflicts: [],
    };
    // The branch rewrote the usage line itself, and changed only the Query section of the README.
    const onBranch: Record<string, string> = {
      'README.md': BEFORE.replace('Call `client.ro_query("Person")`.', 'Call `client.read_query("Person")`.'),
      'docs/usage.md': usage.replace('npm run docs', 'npm run docs:serve'),
    };
    const written = new Map<string, string>();
    let prBody = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = url.replace('https://api.github.com', '');
      const method = init?.method ?? 'GET';
      const at = /\/contents\/(.+?)(\?|$)/.exec(path)?.[1];
      const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
      if (path === '/repos/acme/app') return json({ default_branch: 'main' });
      if (path.startsWith('/repos/acme/app/git/ref/heads/')) return json({ object: { sha: 'head-sha' } });
      if (at && method === 'GET') return json({ sha: `blob-${at}`, encoding: 'base64', content: Buffer.from(onBranch[decodeURIComponent(at)]!).toString('base64') });
      if (at && method === 'PUT') {
        const b = JSON.parse(String(init!.body)) as { content: string; sha: string; branch: string };
        expect(b.sha).toBe(`blob-${at}`);
        expect(b.branch).toBe('staleproof/docs-acme-app-3');
        written.set(decodeURIComponent(at), Buffer.from(b.content, 'base64').toString('utf8'));
        return json({});
      }
      if (path.includes('/pulls?')) return json([]);
      if (path.endsWith('/pulls') && method === 'POST') {
        prBody = (JSON.parse(String(init!.body)) as { body: string }).body;
        return json({ html_url: 'https://github.com/acme/app/pull/4' });
      }
      return json({});
    }) as typeof fetch;
    const logs: string[] = [];
    const opened = await openDocsPr(patch, { token: 't', target: 'same-repo', base: 'feature', fetchImpl, log: (m) => logs.push(m) });
    expect(opened).toEqual([
      {
        repo: 'acme/app',
        url: 'https://github.com/acme/app/pull/4',
        target: 'same-repo',
        branch: 'staleproof/docs-acme-app-3',
        skipped: [{ path: 'docs/usage.md', reason: 'feature has other text where the edit applies (the edit was written against aaaaaaa)' }],
      },
    ]);
    // The README keeps the branch's own rename and gets the edit; the usage page is not touched.
    expect(written.get('README.md')).toContain('Call `client.read_query("Person")`.');
    expect(written.get('README.md')).toContain('Call `client.add(label="City", name="Pune")`.');
    expect(written.has('docs/usage.md')).toBe(false);
    expect(prBody).toContain('Edits.\n\n**Not included** (`feature` has other text where these edits apply');
    expect(prBody).toContain('- `docs/usage.md`: feature has other text where the edit applies (the edit was written against aaaaaaa)');
    expect(logs).toEqual(['left out of the pull request in acme/app: docs/usage.md: feature has other text where the edit applies (the edit was written against aaaaaaa)']);
  });
});
