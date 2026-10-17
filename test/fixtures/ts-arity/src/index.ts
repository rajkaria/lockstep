export interface Options {
  timeout?: number;
}

export class Graph {
  constructor(public name: string, opts?: Options) {}

  query(q: string, params?: Record<string, unknown>): string[] {
    return [q];
  }

  static open(name: string): Graph {
    return new Graph(name);
  }

  explain(q: string): string;
  explain(q: string, verbose: boolean): string;
  explain(q: string, verbose?: boolean): string {
    return verbose ? q : '';
  }

  log(...lines: string[]): void {}

  close(reason: string | undefined): void {}
}

export function connect(url: string, { retries = 3 }: { retries?: number } = {}): Graph {
  return new Graph(url);
}

export function select(name: string): Graph {
  return new Graph(name);
}

export function variadic(): number {
  return arguments.length;
}

export const ping = (host: string, port = 6379) => `${host}:${port}`;

export { legacy } from './legacy.js';
