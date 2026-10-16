import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultHome, loadConfig, setting } from '../src/config.js';
import { COMMENT_MARKER } from '../src/format/markdown.js';

// Staleproof was first published as Lockstep: settings, homes and comments made under the old name keep working.
describe('former name (Lockstep)', () => {
  it('reads STALEPROOF_* first, then LOCKSTEP_*', () => {
    expect(setting('ORG', { STALEPROOF_ORG: 'new', LOCKSTEP_ORG: 'old' })).toBe('new');
    expect(setting('ORG', { LOCKSTEP_ORG: 'old' })).toBe('old');
    expect(setting('ORG', {})).toBeUndefined();
  });

  it('loadConfig honours the former variable names', () => {
    const config = loadConfig({ LOCKSTEP_ORG: 'Acme', LOCKSTEP_MODEL: 'deepseek-v4-pro', LOCKSTEP_SCRATCH_PORT: '6400', LOCKSTEP_HOME: '/h' });
    expect(config).toMatchObject({ org: 'acme', model: 'deepseek-v4-pro', home: '/h', scratch: { port: 6400 } });
    expect(loadConfig({ STALEPROOF_ORG: 'new', LOCKSTEP_ORG: 'old' }).org).toBe('new');
    expect(loadConfig({ VERCEL: '1' }).home).toBe('/tmp/staleproof');
  });

  describe('defaultHome', () => {
    let root: string;
    afterEach(() => rm(root, { recursive: true, force: true }));

    it('is ~/.staleproof, or ~/.lockstep when only the former home exists', async () => {
      root = await mkdtemp(join(tmpdir(), 'staleproof-home-'));
      expect(defaultHome(root)).toBe(join(root, '.staleproof'));
      await mkdir(join(root, '.lockstep'));
      expect(defaultHome(root)).toBe(join(root, '.lockstep'));
      await mkdir(join(root, '.staleproof'));
      expect(defaultHome(root)).toBe(join(root, '.staleproof'));
    });
  });

  it('the GitHub Action updates comments posted under either marker', async () => {
    const action = await readFile(join(import.meta.dirname, '..', 'action.yml'), 'utf8');
    expect(COMMENT_MARKER).toBe('<!-- staleproof -->');
    expect(action).toContain(`startswith("${COMMENT_MARKER}")`);
    expect(action).toContain('startswith("<!-- lockstep-docs -->")');
  });
});
