import { parseRepoName } from '../indexer/repo.js';
import { CONFIG_FILES, EMPTY_CONFIG, parseRepoConfig, type RepoConfig } from '../indexer/repo-config.js';
import { resolveAppConfig, type ResolvedAppConfig } from './checks.js';
import type { InstallationClient } from './github-app.js';

/**
 * A repository's `[app]` settings, read from its default branch (never from the pull
 * request: a pull request must not be able to turn its own check off). `.staleproof.toml`
 * wins over `[tool.staleproof]` in `pyproject.toml`, as everywhere else.
 */
export async function loadAppSettings(client: InstallationClient, repo: string, ref: string): Promise<{ app: ResolvedAppConfig; config: RepoConfig; warnings: string[] }> {
  let config: RepoConfig = EMPTY_CONFIG;
  const warnings: string[] = [];
  for (const file of CONFIG_FILES) {
    const text = await client.fileText(repo, file, ref);
    if (text === undefined) continue;
    try {
      config = parseRepoConfig(text, file);
    } catch (err) {
      warnings.push(`${file}: ${(err as Error).message}`);
      continue;
    }
    if (file === '.staleproof.toml' || config !== EMPTY_CONFIG) break;
  }
  warnings.push(...(config.warnings ?? []));
  const app = resolveAppConfig(config.app);
  const alsoIndex: string[] = [];
  for (const r of app.alsoIndex) {
    try {
      alsoIndex.push(parseRepoName(r));
    } catch {
      warnings.push(`app.also-index: "${r}" is not owner/name; ignored`);
    }
  }
  return { app: { ...app, alsoIndex }, config, warnings };
}
