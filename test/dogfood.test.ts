import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintRepo } from '../src/lint/engine.js';

// Spec §6.5: this repository's own docs, CLAUDE.md and agent files lint clean. Every file git tracks counts,
// so a new package.json (the VS Code extension shares the `staleproof` name) cannot skew the docs' imports.
describe('staleproof lint on this repository', () => {
  it('finds nothing', async () => {
    const result = await lintRepo({ dir: fileURLToPath(new URL('..', import.meta.url)), repo: 'rajkaria/staleproof' });
    expect(result.findings.map((f) => `${f.path}:${f.line} ${f.rule} ${f.message}`)).toEqual([]);
  });
});
