# docusaurus-plugin-staleproof

A [Staleproof](https://staleproof.dev) "checked" stamp at the bottom of every doc: one line that
says what was checked against which commit and when, or how many references on the page are out
of date.

```bash
npm install docusaurus-plugin-staleproof
```

```js
// docusaurus.config.js
export default {
  // organizationName/projectName name the GitHub repository by default
  plugins: [['docusaurus-plugin-staleproof', { repo: 'owner/name' }]],
};
```

Options: `repo` (`owner/name`; default `organizationName/projectName`), `server` (default
`https://staleproof.dev`), `sitePath` (the site's folder relative to the repository root; found
from the nearest `.git` by default).

The plugin loads the stamp script, adds `<meta name="staleproof:source">` with each doc's source
file to its page, and wraps `DocItem/Footer` with the slot the stamp renders into. The repository
must have been audited once on the server (open `https://staleproof.dev/#/audit?repo=owner/name`);
pages with no data show nothing. The script sets no cookies, uses no storage and sends no
referrer. See [the verified stamp docs](https://staleproof.dev/#/docs/verified-stamp).
