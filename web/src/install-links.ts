/** The install page's links and files, kept free of React so they are unit-tested. */
import { PRODUCT, REPO_URL } from './docs/manifest.js';

export const ACTION = 'rajkaria/staleproof@v1';
export const WORKFLOW_PATH = '.github/workflows/staleproof.yml';

/** `owner/name` from what someone pastes: a repository or pull request URL, or `owner/name`. */
export function repoFromInput(input: string): string | undefined {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/.exec(input.trim());
  if (!m || m[1] === 'pull') return undefined;
  return `${m[1]}/${m[2]}`;
}

export interface WorkflowOptions {
  withRepos: string[];
  agent: boolean;
  failOnBreaks: boolean;
}

/** The workflow file the one-click link commits. */
export function workflowYaml(opts: WorkflowOptions): string {
  const inputs: string[] = [];
  if (opts.withRepos.length) inputs.push(`          also-index: ${opts.withRepos.join(' ')}`);
  if (opts.agent) inputs.push('          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}');
  if (opts.failOnBreaks) inputs.push('          fail-on: breaks');
  return [
    `# ${PRODUCT}: a comment on every pull request with the docs it can make false,`,
    '# and the docs examples run before and after it. No database or secrets to set up.',
    `# ${REPO_URL}`,
    `name: ${PRODUCT}`,
    'on:',
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    '',
    'jobs:',
    '  docs:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${ACTION}`,
    ...(inputs.length ? ['        with:', ...inputs] : []),
    '',
  ].join('\n');
}

/** GitHub's "new file" page with the workflow filled in: one click on Commit installs it. */
export function newWorkflowUrl(repo: string, branch: string, yaml: string): string {
  return `https://github.com/${repo}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent(WORKFLOW_PATH)}&value=${encodeURIComponent(yaml)}`;
}

export function mcpLinks(url: string) {
  const b64 = btoa(JSON.stringify({ url }));
  return {
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=staleproof&config=${encodeURIComponent(b64)}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'staleproof', type: 'http', url }))}`,
    claudeCode: `claude mcp add --transport http staleproof ${url}`,
    json: JSON.stringify({ mcpServers: { staleproof: { url } } }, null, 2),
  };
}

