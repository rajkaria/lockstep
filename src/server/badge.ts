/**
 * A README badge in the flat shields.io style: "docs health | 92 A". Text widths are
 * estimated from Verdana's average advance at 11px, which is what the badge renders in.
 */

const WIDE = /[mwMW@%]/;
const NARROW = /[iljtfI.,:;!|' ]/;

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 9.5 : NARROW.test(ch) ? 3.6 : /[A-Z0-9]/.test(ch) ? 7.4 : 6.4;
  return Math.ceil(w);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function scoreColor(score: number | undefined): string {
  if (score === undefined) return '#9f9f9f';
  if (score >= 90) return '#2ea44f';
  if (score >= 80) return '#97ca00';
  if (score >= 70) return '#dfb317';
  if (score >= 60) return '#fe7d37';
  return '#e05d44';
}

export function badgeSvg(label: string, message: string, color: string): string {
  const lw = textWidth(label) + 12;
  const mw = textWidth(message) + 12;
  const w = lw + mw;
  const title = escapeXml(`${label}: ${message}`);
  const l = escapeXml(label);
  const m = escapeXml(message);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${l}</text><text x="${lw / 2}" y="14">${l}</text>` +
    `<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${m}</text><text x="${lw + mw / 2}" y="14">${m}</text>` +
    `</g></svg>`
  );
}

/** The docs-health badge: score and grade, or a grey "not audited" until someone audits the repository. */
export function healthBadge(result: { score: number; grade: string } | undefined): string {
  return result ? badgeSvg('docs health', `${result.score} ${result.grade}`, scoreColor(result.score)) : badgeSvg('docs health', 'not audited', scoreColor(undefined));
}
