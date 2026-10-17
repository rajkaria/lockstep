import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
cpSync('src/index.js', 'dist/index.js');
