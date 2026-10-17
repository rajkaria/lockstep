#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('claims-demo').version('1.0.0').option('--verbose', 'say more');

program
  .command('serve')
  .description('serve the app')
  .option('-p, --port <port>', 'port', '8080')
  .action(() => {});

program
  .command('sync')
  .description('sync the data')
  .option('--dry-run', 'show what would change')
  .action(() => {});

program.parse();
