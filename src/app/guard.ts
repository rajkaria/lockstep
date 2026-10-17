/**
 * Private repositories the GitHub App reads are indexed into their own graph per
 * installation, `ghp-<installation id>`, and nothing public may address it: not the
 * check, audit, badge, lint, MCP or verified endpoints, and not the list of recent
 * checks. Their results appear only on GitHub (check runs and comments). Public
 * repositories keep using the hosted workspaces (`gh-<owner>`), so this module has no
 * dependencies: the hosted code and the server import it to refuse private graphs.
 */

export const PRIVATE_PREFIX = 'ghp-';

/** The graph that holds an installation's private repositories. */
export function privateGraphName(installationId: number | string): string {
  const id = String(installationId);
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error(`not a GitHub App installation id: "${id}"`);
  return `${PRIVATE_PREFIX}${id}`;
}

/** Whether a graph holds private repositories (an App installation's `ghp-` graph). */
export function isPrivateGraph(name: string | undefined | null): boolean {
  return typeof name === 'string' && name.trim().toLowerCase().startsWith(PRIVATE_PREFIX);
}

export class PrivateGraphError extends Error {
  readonly status = 404;
}

/**
 * The name, when the graph is one a public endpoint may read; throws otherwise. The error
 * reads like "not indexed" so the endpoint does not confirm that a private repository exists.
 */
export function assertPublicGraph(name: string): string {
  if (isPrivateGraph(name)) throw new PrivateGraphError('no such repository on this server');
  return name;
}

/** Only the graphs a public endpoint may read, in order. */
export function publicGraphs<T extends string | { name: string } | { graph: string }>(graphs: readonly T[]): T[] {
  const nameOf = (g: T): string => {
    if (typeof g === 'string') return g;
    const o = g as { name?: string; graph?: string };
    return o.name ?? o.graph ?? '';
  };
  return graphs.filter((g) => !isPrivateGraph(nameOf(g)));
}
