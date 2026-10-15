import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FalkorDB } from 'falkordb';
import type { Config } from '../config.js';
import { packageRoot } from '../pkg.js';

const exec = promisify(execFile);

/** Start the scratch FalkorDB if Lockstep manages it locally (idempotent). */
export async function ensureScratchDb(config: Config): Promise<void> {
  if (!config.scratch.managed) return;
  await exec('bash', [join(packageRoot(), 'scripts', 'falkordb-local.sh'), 'start', String(config.scratch.port)]);
}

/** True when the scratch server is the same server that holds the org graph. */
export function scratchIsOrgServer(config: Config): boolean {
  const m = /^\w+:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?/.exec(config.falkordbUrl);
  if (!m) return false;
  const local = (h: string) => (h === 'localhost' ? '127.0.0.1' : h);
  return local(m[1]!) === local(config.scratch.host) && Number(m[2] ?? 6379) === config.scratch.port;
}

/** Wipe the scratch database so every example starts from an empty server. */
export async function flushScratchDb(config: Config): Promise<void> {
  if (scratchIsOrgServer(config)) {
    throw new Error(
      `refusing to flush ${config.scratch.host}:${config.scratch.port}: it is the server holding the org graph (FALKORDB_URL). ` +
        'Point LOCKSTEP_SCRATCH_URL / LOCKSTEP_SCRATCH_PORT at a separate server.',
    );
  }
  const db = await FalkorDB.connect({ socket: { host: config.scratch.host, port: config.scratch.port, connectTimeout: 5000 } });
  try {
    const conn = (await db.connection) as unknown as { flushAll(): Promise<unknown> };
    await conn.flushAll();
  } finally {
    await db.close();
  }
}
