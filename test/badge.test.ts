import { describe, expect, it } from 'vitest';
import { badgeSvg, healthBadge, scoreColor, textWidth } from '../src/server/badge.js';

describe('badge', () => {
  it('colours by score and greys out when not audited', () => {
    expect([95, 85, 75, 65, 10].map(scoreColor)).toEqual(['#2ea44f', '#97ca00', '#dfb317', '#fe7d37', '#e05d44']);
    expect(healthBadge(undefined)).toContain('docs health: not audited');
    expect(healthBadge({ score: 72, grade: 'C' })).toContain('fill="#dfb317"');
  });

  it('is valid, escaped SVG sized to its text', () => {
    const svg = badgeSvg('a<b', 'x&y', '#000');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('a&lt;b');
    expect(svg).toContain('x&amp;y');
    expect(textWidth('docs health')).toBeGreaterThan(textWidth('docs'));
  });
});
