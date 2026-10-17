#!/usr/bin/env node
/**
 * `staleproof hook <event> [--cursor] [--no-graph]` without loading the rest of the CLI
 * (server, agent, MCP): the entry the Claude Code plugin runs (`dist/hook.js`), where every
 * millisecond of start-up is spent on each edit. Same behavior as the `hook` command.
 */
import { HOOK_EVENTS, readStdin, runHook, type HookEvent } from './index.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const event = args.find((a) => !a.startsWith('-'));
  if (!event || !HOOK_EVENTS.includes(event as HookEvent)) {
    process.stderr.write(`staleproof hook: unknown event ${event ?? '(none)'} (${HOOK_EVENTS.join(', ')})\n`);
    process.exit(1);
  }
  const r = await runHook(event as HookEvent, await readStdin(process.stdin), {
    dialect: args.includes('--cursor') ? 'cursor' : undefined,
    graph: !args.includes('--no-graph'),
  });
  process.stdout.write(r.stdout ? `${r.stdout}\n` : '', () => process.exit(0));
}

main().catch(() => process.exit(0));
