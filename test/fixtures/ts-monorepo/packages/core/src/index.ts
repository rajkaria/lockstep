export class Client {
  constructor(public url: string) {}

  query(q: string): string[] {
    return [q];
  }
}

export function connect(url: string): Client {
  return new Client(url);
}
