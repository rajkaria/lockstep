import { createHmac, timingSafeEqual } from 'node:crypto';

/** GitHub caps webhook payloads at 25 MB; anything bigger is not from GitHub. */
export const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

/** The `X-Hub-Signature-256` value GitHub sends for `body`. */
export function signBody(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** HMAC-SHA256 over the raw body, compared in constant time. */
export function verifySignature(secret: string, body: Uint8Array | string, header: string | undefined | null): boolean {
  if (!secret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header.trim())) return false;
  const expected = Buffer.from(signBody(secret, body), 'utf8');
  const given = Buffer.from(header.trim().toLowerCase(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class PayloadTooLargeError extends Error {}

/** The raw request body, refusing more than `max` bytes (declared or actually sent). */
export async function readRawBody(req: Request, max = MAX_WEBHOOK_BYTES): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) throw new PayloadTooLargeError(`payload of ${declared} bytes is over the ${max}-byte limit`);
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError(`payload is over the ${max}-byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The webhook headers the App reads. */
export interface WebhookHeaders {
  event: string;
  delivery: string;
  signature?: string;
}

export function webhookHeaders(req: Request): WebhookHeaders | undefined {
  const event = req.headers.get('x-github-event')?.trim();
  const delivery = req.headers.get('x-github-delivery')?.trim();
  if (!event || !delivery || !/^[\w-]{1,100}$/.test(event) || !/^[\w-]{1,100}$/.test(delivery)) return undefined;
  return { event, delivery, signature: req.headers.get('x-hub-signature-256') ?? undefined };
}
