import { defaults } from './settings/defaults.js';

export function start(): number {
  const url = process.env.DATABASE_URL ?? '';
  const redis = process.env.REDIS_HOST ?? 'localhost';
  const token = process.env.API_TOKEN ?? '';
  return url.length + redis.length + token.length + defaults.retries;
}
