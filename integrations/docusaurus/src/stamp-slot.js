import { sourcePath } from './source.js';

/**
 * The `DocItem/Footer` wrapper's render, given what Docusaurus provides (so it can be tested
 * without a Docusaurus build): the doc's source as `<meta name="staleproof:source">`, the slot
 * the stamp renders into, then the original footer. Called from inside the component, so the
 * theme's imports are read at render time (theme modules can import each other in a cycle).
 */
export function renderStampFooter({ React, Head, useDoc, usePluginData, Original, pluginName = 'docusaurus-plugin-staleproof' }, props) {
  const h = React.createElement;
  const { metadata } = useDoc();
  const data = usePluginData(pluginName) ?? {};
  const path = sourcePath(metadata?.source, data.prefix);
  React.useEffect(() => refreshStamp(typeof window === 'undefined' ? undefined : window), [path]);
  return h(
    React.Fragment,
    null,
    path ? h(Head, null, h('meta', { name: 'staleproof:source', content: path })) : null,
    // React leaves the children of a dangerouslySetInnerHTML element alone, so a stamp the script adds before
    // hydration is no mismatch, and later renders keep it.
    path ? h('div', { className: 'staleproof-stamp-slot', 'data-staleproof-stamp': '', 'data-path': path, dangerouslySetInnerHTML: { __html: '' } }) : null,
    h(Original, props),
  );
}

/** The wrapper as a component (tests; the theme file renders through `renderStampFooter` directly). */
export function makeStampFooter(deps) {
  return function StaleproofDocFooter(props) {
    return renderStampFooter(deps, props);
  };
}

/** Render the stamp again (client-side navigation): a no-op until the stamp script has loaded. */
export function refreshStamp(win) {
  if (win && typeof win.StaleproofStamp === 'function') win.StaleproofStamp();
}
