export interface StaleproofPluginOptions {
  /** The GitHub repository, `owner/name` (default: `organizationName/projectName`). */
  repo?: string;
  /** The Staleproof server (default `https://staleproof.dev`). */
  server?: string;
  /** The site's folder relative to the repository root (default: found from the nearest `.git`). */
  sitePath?: string;
}

export interface StaleproofPlugin {
  name: string;
  getThemePath(): string;
  injectHtmlTags(): { postBodyTags: { tagName: string; attributes: Record<string, string | boolean> }[] };
  contentLoaded(args: { actions: { setGlobalData(data: unknown): void } }): Promise<void>;
}

export const PLUGIN_NAME: 'docusaurus-plugin-staleproof';
export function repositoryRoot(start: string): string | undefined;
export function sitePath(siteDir: string): string;
export function sourcePath(source: string | undefined, prefix: string | undefined): string | undefined;
export function validateOptions(args: { options?: StaleproofPluginOptions; validate?: unknown }): StaleproofPluginOptions;
export default function staleproofPlugin(context: { siteDir: string; siteConfig?: { organizationName?: string; projectName?: string } }, options?: StaleproofPluginOptions): StaleproofPlugin;
