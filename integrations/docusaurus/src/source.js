/** A doc's source as Docusaurus names it (`@site/docs/intro.md`), as a repository path under `prefix`. */
export function sourcePath(source, prefix) {
  if (!source) return undefined;
  const rel = source.replace(/^@site\//, '').replace(/^\.?\//, '');
  return prefix ? `${prefix.replace(/\/+$/, '')}/${rel}` : rel;
}
