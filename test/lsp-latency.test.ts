import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DidChangeTextDocumentNotification, DidOpenTextDocumentNotification, InitializedNotification, InitializeRequest } from 'vscode-languageserver/node';
import { pathToUri } from '../src/lsp/convert.js';
import { CLIENT_CAPABILITIES, connect, type TestClient } from './lsp-harness.js';

/**
 * The editor budget (spec 6.2): diagnostics for a single-file change in under 500 ms, on
 * this repository, warm. Opt-in, because it lints the whole checkout first:
 *
 *   STALEPROOF_LSP_BENCH=1 npx vitest run test/lsp-latency.test.ts
 *
 * `STALEPROOF_LSP_BENCH_DIR` and `STALEPROOF_LSP_BENCH_FILE` point it at another checkout
 * and docs page. The numbers go to stdout; the test fails above the budget.
 */
const DIR = resolve(process.env.STALEPROOF_LSP_BENCH_DIR ?? join(import.meta.dirname, '..'));
const FILE = process.env.STALEPROOF_LSP_BENCH_FILE ?? 'docs/lint.md';
const CODE_FILE = process.env.STALEPROOF_LSP_BENCH_CODE ?? 'src/lint/engine.ts';
const EDITS = 25;
const DEBOUNCE = 300;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

describe.runIf(process.env.STALEPROOF_LSP_BENCH)('LSP latency on a real checkout', () => {
  let t: TestClient;
  const publishMs: number[] = [];

  beforeAll(async () => {
    t = connect({ debounceMs: DEBOUNCE, onPublish: (_uri, ms) => publishMs.push(ms) });
    await t.client.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: pathToUri(DIR),
      workspaceFolders: [{ uri: pathToUri(DIR), name: basename(DIR) }],
      capabilities: CLIENT_CAPABILITIES,
    });
    await t.client.sendNotification(InitializedNotification.type, {});
  }, 300_000);

  afterAll(async () => {
    await t?.close();
  });

  async function measure(path: string, edit: (lines: string[], i: number) => void, isDone: (msg: string[], i: number) => boolean) {
    const uri = t.uri(DIR, path);
    let text = await readFile(join(DIR, path), 'utf8');
    const first = t.diagnostics(uri, () => true, 300_000);
    const started = performance.now();
    await t.client.sendNotification(DidOpenTextDocumentNotification.type, { textDocument: { uri, languageId: 'plaintext', version: 1, text } });
    await first;
    const openMs = performance.now() - started;
    // Warm: the snapshot's background work (docs references index, fix proposals) has finished.
    const ws = (await t.server.workspaceFor(join(DIR, path)))!.ws;
    await ws.references();
    await ws.fixesSettled();
    // Warm: one edit that is not measured.
    const endToEnd: number[] = [];
    const processing: number[] = [];
    for (let i = 0; i <= EDITS; i++) {
      const lines = text.split('\n');
      edit(lines, i);
      text = lines.join('\n');
      const got = t.diagnostics(uri, (ds) => isDone(ds.map((d) => (typeof d.message === 'string' ? d.message : d.message.value)), i), 30_000);
      const before = publishMs.length;
      const t0 = performance.now();
      await t.client.sendNotification(DidChangeTextDocumentNotification.type, { textDocument: { uri, version: i + 2 }, contentChanges: [{ text }] });
      await got;
      const ms = performance.now() - t0;
      if (i === 0) continue;
      endToEnd.push(ms);
      processing.push((publishMs.slice(before).at(-1) ?? ms) - DEBOUNCE);
      if (process.env.STALEPROOF_LSP_BENCH === 'verbose') console.log(`${path} edit ${i}: ${ms.toFixed(0)} ms`);
    }
    return { openMs, endToEnd, processing };
  }

  it(`a docs page (${FILE}): diagnostics within 500 ms of the debounce`, async () => {
    // Each edit adds a sentence with a link to a page that does not exist, in the first paragraph.
    const r = await measure(
      FILE,
      (lines, i) => {
        const at = lines.findIndex((l, k) => k > 0 && l.trim() && !l.startsWith('#'));
        lines.splice(at + 1, 0, `Edit ${i} links to [a missing page](missing-page-${i}.md).`);
      },
      (msgs, i) => msgs.some((m) => m.includes(`missing-page-${i}.md`)),
    );
    const line = `docs page ${FILE}: open ${r.openMs.toFixed(0)} ms (cold snapshot); per edit after the ${DEBOUNCE} ms debounce p50 ${pct(r.processing, 50).toFixed(1)} ms, p95 ${pct(r.processing, 95).toFixed(1)} ms, max ${Math.max(...r.processing).toFixed(1)} ms; edit → diagnostics p50 ${pct(r.endToEnd, 50).toFixed(0)} ms, p95 ${pct(r.endToEnd, 95).toFixed(0)} ms (${r.endToEnd.length} edits)`;
    console.log(line);
    expect(r.endToEnd.length).toBeGreaterThanOrEqual(20);
    expect(pct(r.processing, 95)).toBeLessThan(500);
  }, 600_000);

  it(`a code file (${CODE_FILE}): docstring diagnostics within 500 ms of the debounce`, async () => {
    const r = await measure(
      CODE_FILE,
      (lines, i) => {
        lines.push(`/**\n * Bench ${i}.\n * @param wrong${i} Not a parameter.\n */\nexport function bench${i}(right: number): number {\n  return right;\n}`);
      },
      (msgs, i) => msgs.some((m) => m.includes(`wrong${i}`)),
    );
    const line = `code file ${CODE_FILE}: per edit after the debounce p50 ${pct(r.processing, 50).toFixed(1)} ms, p95 ${pct(r.processing, 95).toFixed(1)} ms, max ${Math.max(...r.processing).toFixed(1)} ms; edit → diagnostics p50 ${pct(r.endToEnd, 50).toFixed(0)} ms, p95 ${pct(r.endToEnd, 95).toFixed(0)} ms (${r.endToEnd.length} edits)`;
    console.log(line);
    expect(pct(r.processing, 95)).toBeLessThan(500);
  }, 600_000);
});
