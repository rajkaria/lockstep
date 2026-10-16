import { Graph } from './graph';
import type { Options } from './types';
import { EventEmitter } from 'events';

export class Client {
  private pool: Pool;

  constructor(private opts: Options) {
    this.pool = new Pool();
  }

  selectGraph(name: string): Graph {
    return new Graph(this, name);
  }

  async listGraphs(): Promise<string[]> {
    return this.pool.send('LIST');
  }
}

class Pool {
  send(cmd: string): string[] {
    return [cmd];
  }
}

export class Emitting extends EventEmitter {
  ping() {}
}
