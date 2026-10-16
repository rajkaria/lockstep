// Not a function (Vercel skips files starting with `_`): shared by api/index.js and its test.

/**
 * The request as the client sent it. vercel.json rewrites /api/:path* to api/index.js; when the
 * platform hands over the rewritten URL (`/api?path=checks/<id>`), put the original path back.
 */
export function originalRequest(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (url.pathname.replace(/\/$/, '') !== '/api' || path === null) return request;
  url.searchParams.delete('path');
  url.pathname = `/api/${path.replace(/^\/+/, '')}`;
  return new Request(url, request);
}
