import { createPrivateKey, sign } from 'node:crypto';

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * The App's JSON Web Token (RS256, `node:crypto`): what it authenticates as the App with
 * (installation tokens, the repository's installation). Issued a minute in the past for
 * clock drift; GitHub refuses tokens that live more than 10 minutes, so it lives 9.
 */
export function appJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const key = createPrivateKey({ key: privateKey, format: 'pem' });
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the GitHub App private key must be an RSA key');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** The claims of a JWT, unverified (tests and diagnostics). */
export function jwtClaims(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.');
  if (!h || !p) throw new Error('not a JWT');
  return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) };
}
