import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, expandPath, MIN_LSP_VERSION, resolveServer, STALEPROOF_VERSION } from '../editors/vscode/src/resolve.js';

const EXT = join(import.meta.dirname, '..', 'editors', 'vscode');

describe('VS Code extension: finding staleproof', () => {
  const files = (...paths: string[]) => {
    const set = new Set(paths);
    return (p: string) => set.has(p);
  };
  const versions = (map: Record<string, string>) => async (cmd: string) => map[cmd];

  it('uses the staleproof.path setting as given (~ and ${workspaceFolder} expanded)', async () => {
    const r = await resolveServer({ configured: '${workspaceFolder}/bin/staleproof', folders: ['/w'], isFile: files(), versionOf: versions({}) });
    expect(r).toEqual({ command: '/w/bin/staleproof', args: [], source: 'setting', shell: false });
    expect(expandPath('~/x/staleproof', [], '/home/me')).toBe('/home/me/x/staleproof');
    expect(expandPath('tools/staleproof', ['/w'])).toBe('/w/tools/staleproof');
    expect(expandPath('staleproof', ['/w'])).toBe('staleproof');
  });

  it("prefers the workspace's install, then the PATH, each only with the lsp command", async () => {
    const ws = '/w/node_modules/.bin/staleproof';
    const global = '/usr/local/bin/staleproof';
    const env = { PATH: '/opt/bin:/usr/local/bin' };
    expect(await resolveServer({ folders: ['/w'], env, platform: 'darwin', isFile: files(ws, global), versionOf: versions({ [ws]: MIN_LSP_VERSION, [global]: '9.9.9' }) })).toMatchObject({
      command: ws,
      source: 'workspace',
      version: MIN_LSP_VERSION,
    });
    // An install from before `staleproof lsp` is passed over.
    expect(await resolveServer({ folders: ['/w'], env, platform: 'darwin', isFile: files(ws, global), versionOf: versions({ [ws]: '0.3.0', [global]: '9.9.9' }) })).toMatchObject({ command: global, source: 'global' });
    // Nothing usable: npx, pinned to the release the extension was built for.
    expect(await resolveServer({ folders: ['/w'], env, platform: 'darwin', isFile: files(ws), versionOf: versions({}) })).toEqual({
      command: 'npx',
      args: ['-y', `staleproof@${STALEPROOF_VERSION}`],
      source: 'npx',
      shell: false,
    });
  });

  it('starts Windows .cmd shims through a shell', async () => {
    const ws = '/w/node_modules/.bin/staleproof.cmd';
    expect(await resolveServer({ folders: ['/w'], env: { Path: '' }, platform: 'win32', isFile: files(ws), versionOf: versions({ [ws]: STALEPROOF_VERSION }) })).toMatchObject({ command: ws, shell: true });
    expect(await resolveServer({ folders: [], env: { Path: '' }, platform: 'win32', isFile: files(), versionOf: versions({}) })).toMatchObject({ command: 'npx.cmd', shell: true });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
    expect(compareVersions('0.5.2', '0.6.0')).toBeLessThan(0);
  });
});

describe('VS Code extension: manifest', () => {
  it('declares every command and setting the code uses, the pinned version, and no publish step', async () => {
    const pkg = JSON.parse(await readFile(join(EXT, 'package.json'), 'utf8'));
    const src = await readFile(join(EXT, 'src', 'extension.ts'), 'utf8');
    const registered = [...src.matchAll(/registerCommand\('([\w.]+)'/g)].map((m) => m[1]);
    const contributed = pkg.contributes.commands.map((c: { command: string }) => c.command);
    // `staleproof.showReferences` is internal (code lenses call it); every palette command is registered.
    expect(registered.filter((c) => c !== 'staleproof.showReferences').sort()).toEqual([...contributed].sort());
    expect(contributed).toEqual(expect.arrayContaining(['staleproof.fixAllInFile', 'staleproof.auditWorkspace']));
    const settings = Object.keys(pkg.contributes.configuration.properties);
    for (const m of src.matchAll(/get<\w+>\('(\w+)'/g)) expect(settings).toContain(`staleproof.${m[1]}`);
    expect(settings).toEqual(expect.arrayContaining(['staleproof.enable', 'staleproof.codeLens', 'staleproof.path']));
    expect(pkg.version).toBe(STALEPROOF_VERSION);
    expect(pkg.main).toBe('./dist/extension.cjs');
    expect(pkg.scripts.package).toMatch(/vsce package/);
    expect(JSON.stringify(pkg.scripts)).not.toMatch(/vsce publish|ovsx publish/);
    // vsce refuses @types/vscode newer than the engine.
    expect(compareVersions(pkg.devDependencies['@types/vscode'].replace(/^[~^]/, ''), pkg.engines.vscode.replace(/^[~^]/, ''))).toBeLessThanOrEqual(0);
  });
});
