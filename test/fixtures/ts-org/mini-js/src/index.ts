export { Client } from './client';
export * from './graph';
export type { Options } from './types';
export default function connect(url: string): Client {
  return new Client({ url });
}
import { Client } from './client';
