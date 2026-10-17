# The checked stamp

A one-line stamp on each page of your docs site that says what Staleproof checked on that page, against which commit and when, or how many references on it are out of date. One script tag adds it to any site; plugins do it for Docusaurus and MkDocs, and a snippet covers Mintlify and plain HTML. This page covers what the stamp says and what it means, how to add it, the JSON it reads, privacy, and its limits. It is for docs teams who want readers to see that the page in front of them was checked, and to see it when it is not.

## What it says

The stamp reads the repository's [docs audit](audit.md) on the Staleproof server and finds the page's source file in it. It renders one of three things:

| State | The stamp | When |
|---|---|---|
| Checked | ✓ Examples and references checked against `abc1234` · 2 days ago · Staleproof | Nothing on the page is out of date at the indexed commit |
| Drift | ⚠ 2 references on this page are out of date · checked against `abc1234` · 2 days ago · Staleproof | The page has error or warning findings, example lines that no longer fit the code, or examples that fail when run |
| No data | nothing | The repository was never audited on the server, or the page is not one of its docs pages |

The wording says exactly what was checked, never more:

- **References** are the paths, links, anchors, commands, CLI flags and env vars the page names, [linted](lint.md) at index time. A repository indexed before Staleproof 0.5 has no reference checks, so its stamps say "Examples checked".
- **Examples** are the page's code examples, checked statically against the signatures and names their calls reach. A page with no code examples says "References checked".
- **Runs**: only when examples on the page were actually run at the indexed commit does the stamp add "· 3 examples ran". The hosted service never runs examples, so on staleproof.dev this part appears only for repositories whose runs were recorded elsewhere. The stamp never says a page was verified by running when nothing ran.
- The commit is the one the repository was indexed at, and the time is when it was indexed: the stamp shows how fresh the check is, not when the reader opened the page.

"Staleproof" links to the repository's full audit, where every finding is listed with its line.

## Add it to your site

The repository must have been audited once on the server: open `https://staleproof.dev/#/audit?repo=owner/name` (or `POST /api/audit`). Hosted workspaces are indexed again when they are a week old, and the stamp follows. Pages show nothing until then.

### Docusaurus

```bash
npm install docusaurus-plugin-staleproof
```

```js
// docusaurus.config.js
export default {
  plugins: [['docusaurus-plugin-staleproof', { repo: 'owner/name' }]],
};
```

The plugin loads the stamp script on every page, adds `<meta name="staleproof:source">` with each doc's source file (built into the static HTML), and wraps `DocItem/Footer` with the slot the stamp renders into, at the bottom of each doc. It renders the stamp again after client-side navigation. Options: `repo` (default `organizationName/projectName`), `server` (default `https://staleproof.dev`), `sitePath` (the site's folder in the repository, found from the nearest `.git`, so a site in `website/` names `website/docs/intro.md`). Docusaurus 3.

### MkDocs

```bash
pip install mkdocs-staleproof
```

```yaml
# mkdocs.yml
repo_url: https://github.com/owner/name
plugins:
  - staleproof
```

The plugin adds the meta tag and the script to every page (`on_post_page`) and a slot under the page title (`on_page_content`). Options: `repo` (default from `repo_url`), `server`, `docs_path` (the docs folder relative to the repository root, worked out from `docs_dir` by default), `placement` (`top`, `bottom` or `none`). With Material for MkDocs' instant navigation the stamp renders again on each page; keep `placement` at `top` or `bottom` there, since the slot travels with the page content.

### Mintlify

Mintlify includes every `.js` file in the docs folder on every page. Add `staleproof.js`:

```js
// staleproof.js: the Staleproof stamp. Pages map to their .mdx source by URL.
(function () {
  var s = document.createElement('script');
  s.src = 'https://staleproof.dev/api/verified/owner/name/stamp.js';
  s.async = true;
  s.referrerPolicy = 'no-referrer';
  s.setAttribute('data-map', 'docs/{path}.mdx docs/{path}/index.mdx');
  document.head.appendChild(s);
  // Client-side navigation: render again when the path changes.
  var last = location.pathname;
  setInterval(function () {
    if (location.pathname !== last) {
      last = location.pathname;
      if (window.StaleproofStamp) window.StaleproofStamp();
    }
  }, 1000);
})();
```

Change `docs/` to where the `.mdx` files are in your repository.

### Any HTML page

```html
<meta name="staleproof:source" content="docs/install.md">
<script src="https://staleproof.dev/api/verified/owner/name/stamp.js" async referrerpolicy="no-referrer"></script>
```

The script finds the page's source file, first match wins:

1. an element `<div data-staleproof-stamp data-path="docs/install.md"></div>`: the stamp renders inside it;
2. `<meta name="staleproof:source" content="docs/install.md">`;
3. the script tag's `data-path="docs/install.md"`;
4. the script tag's `data-map`: patterns filled with the URL path, tried in order: `data-map="docs/{path}.md docs/{path}/index.md"` maps `/guide/install/` to `docs/guide/install.md`, then `docs/guide/install/index.md`, and `/` to `docs/index.md`. `data-base="/project/"` drops a prefix from the URL path first (GitHub Pages project sites).

Without a slot, the stamp goes into `data-target` (a CSS selector on the script tag), else right after the first `h1` in `article` or `main`, else at the end of the page. After client-side navigation, call `window.StaleproofStamp()`: it replaces the old stamp.

### Look

The stamp is a small bordered line in the page's own font and text colour, so it fits light and dark themes. Only the icon and border are tinted (green, amber), with colours for dark mode from `prefers-color-scheme` and from the site's own theme switch (`[data-theme=dark]` in Docusaurus, `.dark`, Material's `slate` scheme). It is an `aside` labelled "Staleproof docs check"; the icon is hidden from screen readers (the words carry the state), the time is a `<time datetime>`. Style it further through `.sp-stamp`, `.sp-drift` and `.sp-i`.

## The JSON

```
GET /api/verified/<owner>/<repo>.json
```

CORS `*`, cached 10 minutes at the CDN (`s-maxage=600`). From the server's cached audit; it never starts indexing.

```json
{
  "version": 1,
  "repo": "acme/app",
  "sha": "abc1234def5678",
  "checkedAt": 1792065600000,
  "score": 84,
  "grade": "B",
  "checks": { "references": true, "examples": true },
  "pages": [
    { "path": "docs/api.md", "status": "drift", "findings": 1, "mismatches": 1, "examples": 2, "sha": "abc1234def5678", "checkedAt": 1792065600000 },
    { "path": "docs/install.md", "status": "checked", "findings": 0, "mismatches": 0, "runs": { "pass": 2, "fail": 0 }, "examples": 2, "sha": "abc1234def5678", "checkedAt": 1792065600000 }
  ]
}
```

- `findings`: docs references out of date on the page (errors and warnings; info findings do not count).
- `mismatches`: example lines that no longer fit the code.
- `runs`: recorded runs of the page's examples at the indexed commit, only when there are any.
- `checks`: what the index checked. A page where nothing was checked (no examples, references not linted) is left out.
- A repository the server has not audited answers `404` `{ "error": ..., "indexed": false }`.

`GET /api/verified/<owner>/<repo>/stamp.js` serves the script (under 4 KB, cached a day). See [HTTP API](http-api.md).

## Privacy

- The script sets no cookies and uses no `localStorage`, `sessionStorage` or IndexedDB.
- It fetches one JSON file per page load with `credentials: "omit"` and `referrerPolicy: "no-referrer"`, and the plugins load the script with `referrerpolicy="no-referrer"`: the server is not told which page the reader is on.
- It sends nothing else: no beacons, no analytics, no reader identifiers.
- Both URLs are the same for every reader and cached at the CDN.

## Private repositories

Repositories the [GitHub App](github-app.md) reads privately are indexed into their own graph (`ghp-<installation id>`), which no public endpoint can address: `/api/verified` answers them exactly as a repository nobody audited (`404`), so the stamp shows nothing and does not confirm that the repository exists.

## Your own server

`staleproof serve` exposes the same routes. Point the plugins at it (`server: https://docs-check.example.com`) or load the script from it; the script reads the JSON from wherever it was loaded from.

## Limits

- The stamp is as fresh as the index: a page edited after the indexed commit shows the old check until the repository is indexed again (weekly on the hosted service, or whenever someone audits it with a refresh).
- Pages are matched by their source path in the repository. A site whose source lives in another repository needs `repo` set to that repository.
- Pages generated from code (API reference built by a docs tool) have no source file in the repository and show nothing.

## Related

- [Docs audit](audit.md): what the stamp summarises, page by page.
- [Lint docs and agent files](lint.md): the reference checks.
- [GitHub App](github-app.md): private repositories.
