import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    falkordbUrl: string;
  }
}

/**
 * Integration tests need a FalkorDB. Use FALKORDB_TEST_URL when given, otherwise
 * start the Docker-free local server on port 6380 (left running for the next run).
 */
export default function setup(project: TestProject): void {
  let url = process.env.FALKORDB_TEST_URL;
  if (!url) {
    execFileSync('bash', ['scripts/falkordb-local.sh', 'start', '6380'], { stdio: 'inherit' });
    url = 'falkor://localhost:6380';
  }
  project.provide('falkordbUrl', url);
}
