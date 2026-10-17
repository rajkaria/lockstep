import { describe, expect, it } from 'vitest';
import { closestName, editDistance } from '../src/lint/fix-propose.js';
import { anchorRenames, emptyRenames, fileRenamedTo, nameRenames, renamedTo } from '../src/lint/fix-renames.js';

const names = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v]]));

describe('nameRenames', () => {
  it('finds a renamed package.json script, Make target and flag from the changed line', () => {
    const pkg = nameRenames('{\n  "scripts": {\n    "lint:docs": "staleproof lint",\n    "test": "vitest"\n  }\n}\n', '{\n  "scripts": {\n    "docs:lint": "staleproof lint",\n    "test": "vitest"\n  }\n}\n');
    expect(names(pkg)).toEqual({ 'lint:docs': ['docs:lint'] });
    const make = nameRenames('.PHONY: check-docs\ncheck-docs:\n\tnpx staleproof lint\n', '.PHONY: docs-check\ndocs-check:\n\tnpx staleproof lint\n');
    expect(names(make)).toEqual({ 'check-docs': ['docs-check'] });
    const flag = nameRenames("program.option('--force-all', 'Force');\n", "program.option('--force', 'Force');\n");
    expect(names(flag)).toEqual({ '--force-all': ['--force'] });
  });

  it('finds the identifier inside a dotted read and a renamed parameter in a signature', () => {
    expect(names(nameRenames('const u = process.env.FOO_URL;\n', 'const u = process.env.FOO_URI;\n'))).toEqual({ 'process.env.FOO_URL': ['process.env.FOO_URI'], FOO_URL: ['FOO_URI'] });
    expect(names(nameRenames('def connect(host, timeout_ms=30):\n    pass\n', 'def connect(host, timeout=30):\n    pass\n'))).toEqual({ timeout_ms: ['timeout'] });
  });

  it('pairs lines in a hunk of uneven size by similarity, and skips version bumps', () => {
    const out = nameRenames('a = 1\ndef query_v2(self):\n    pass\n', 'a = 1\n# new name\ndef query(self):\n    pass\n');
    expect(names(out)).toEqual({ query_v2: ['query'] });
    expect(names(nameRenames('version = "1.2.3"\n', 'version = "1.2.4"\n'))).toEqual({});
  });

  it('records every new name when one name became several (ambiguous)', () => {
    const into = nameRenames('run("lint")\n', 'run("check")\n');
    nameRenames('x = "lint"\n', 'x = "verify"\n', into);
    expect(renamedTo({ ...emptyRenames(), names: into }, 'lint')).toBeUndefined();
    expect(names(into)).toEqual({ lint: ['check', 'verify'] });
  });
});

describe('renamedTo and fileRenamedTo', () => {
  it('maps a dashed CLI name through its underscored function rename', () => {
    const r = { ...emptyRenames(), names: new Map([['sync_all', new Set(['pull_all'])]]) };
    expect(renamedTo(r, 'sync-all')).toBe('pull-all');
    expect(renamedTo(r, 'sync_all')).toBe('pull_all');
    expect(renamedTo(r, 'other')).toBeUndefined();
    expect(renamedTo(undefined, 'x')).toBeUndefined();
  });

  it('follows a file rename and the longest renamed directory above a path', () => {
    const r = { ...emptyRenames(), files: new Map([['docs/a.md', 'docs/b.md'], ['src/old', 'src/new'], ['src/old/deep', 'lib/deep']]) };
    expect(fileRenamedTo(r, 'docs/a.md')).toBe('docs/b.md');
    expect(fileRenamedTo(r, 'src/old/x.ts')).toBe('src/new/x.ts');
    expect(fileRenamedTo(r, 'src/old/deep/y.ts')).toBe('lib/deep/y.ts');
    expect(fileRenamedTo(r, 'src/old/')).toBe('src/new');
    expect(fileRenamedTo(r, 'other.md')).toBeUndefined();
  });
});

describe('anchorRenames', () => {
  it('maps the one removed heading to the one added heading', () => {
    expect(names(anchorRenames('docs/a.md', '# A\n\n## Install\n\n## Use\n', '# A\n\n## Installation\n\n## Use\n'))).toEqual({ install: ['installation'] });
  });
  it('pairs changed heading lines when several changed', () => {
    const out = anchorRenames('docs/a.md', '# A\n\n## Install\n\ntext\n\n## Use it\n', '# A\n\n## Installing\n\ntext\n\n## Using it\n');
    expect(names(out)).toEqual({ install: ['installing'], 'use-it': ['using-it'] });
  });
});

describe('closestName', () => {
  it('picks the one closest name within two edits', () => {
    expect(editDistance('qeury', 'query')).toBe(2);
    expect(closestName('qeury', ['query', 'close', '__init__'])).toBe('query');
    expect(closestName('--colour', ['--color', '--verbose'])).toBe('--color');
  });
  it('refuses ties, far names, and two edits on short names', () => {
    expect(closestName('dov', ['dev', 'doc'])).toBeUndefined();
    expect(closestName('lint:docs', ['docs:lint'])).toBeUndefined();
    expect(closestName('tset', ['test'])).toBeUndefined();
    expect(closestName('buld', ['build'])).toBe('build');
  });
  it('refuses a swap of one short whole word (a different name, not a typo)', () => {
    expect(closestName('API_KEY', ['APP_KEY'])).toBeUndefined();
    expect(closestName('get_url', ['get_uri'])).toBeUndefined();
    expect(closestName('REDIS_HSOT', ['REDIS_HOST'])).toBe('REDIS_HOST');
  });
  it('allows three edits for long anchors only when asked', () => {
    expect(editDistance('instalaton-gide', 'installation-guide')).toBe(3);
    expect(closestName('instalaton-gide', ['installation-guide'], 3)).toBe('installation-guide');
    expect(closestName('instalaton-gide', ['installation-guide'])).toBeUndefined();
  });
});
