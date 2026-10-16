import type { Client } from '../client';

export class Graph {
  constructor(public client: Client, public name: string) {}

  async query(q: string, params?: Record<string, unknown>): Promise<unknown[]> {
    return this.send('QUERY', q);
  }

  roQuery(q: string) {
    return this.query(q);
  }

  private send(cmd: string, q: string): unknown[] {
    return [cmd, this.name, q];
  }
}
