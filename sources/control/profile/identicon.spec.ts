/**
 * Unit tests for generateIdenticon and buildGrid.
 *
 * Pure unit spec — no DB, no I/O.
 *
 * Covers:
 *   - deterministic: same seed → identical output
 *   - distinct:      different seeds → different output
 *   - valid data-uri: well-formed SVG with viewBox="0 0 5 5" and at least one <rect
 *   - left-right symmetric: x=3 mirrors x=1, x=4 mirrors x=0 (for all rows)
 */
import { describe, it, expect } from 'vitest';
import { generateIdenticon, buildGrid } from './identicon';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode the base64 payload of a data:image/svg+xml;base64,… URI. */
function decodeDataUri(uri: string): string {
  const prefix = 'data:image/svg+xml;base64,';
  const b64 = uri.slice(prefix.length);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Parse <rect ... x="N" y="N" fill="..." /> elements from an SVG string.
 * Returns an array of { x, y, fill } objects.
 */
function parseRects(svg: string): Array<{ x: number; y: number; fill: string }> {
  const rects: Array<{ x: number; y: number; fill: string }> = [];
  // Match each <rect ... /> block
  const rectRe = /<rect\b([^/]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = rectRe.exec(svg)) !== null) {
    const attrs = match[1];
    const xM = /\bx="(\d+)"/.exec(attrs);
    const yM = /\by="(\d+)"/.exec(attrs);
    const fillM = /\bfill="([^"]+)"/.exec(attrs);
    if (xM && yM && fillM) {
      rects.push({ x: Number(xM[1]), y: Number(yM[1]), fill: fillM[1] });
    }
  }
  return rects;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('generateIdenticon', () => {
  it('is deterministic: same seed → identical output', () => {
    expect(generateIdenticon('alice')).toBe(generateIdenticon('alice'));
  });

  it('is distinct: different seeds → different output', () => {
    expect(generateIdenticon('alice')).not.toBe(generateIdenticon('bob'));
  });

  it('returns a valid data:image/svg+xml;base64, URI', () => {
    const uri = generateIdenticon('alice');
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);

    const svg = decodeDataUri(uri);
    expect(svg).toContain('viewBox="0 0 5 5"');
    expect(svg).toMatch(/<rect/);
  });

  it('SVG contains 25 rect elements (one per cell)', () => {
    const svg = decodeDataUri(generateIdenticon('alice'));
    const rects = parseRects(svg);
    expect(rects).toHaveLength(25);
  });

  it('produces a genuinely mixed grid (not monochrome): at least one filled AND one empty cell', () => {
    const svg = decodeDataUri(generateIdenticon('alice'));
    const rects = parseRects(svg);
    expect(rects.some(r => r.fill !== '#f0f0f0')).toBe(true); // at least one filled (hsl) cell
    expect(rects.some(r => r.fill === '#f0f0f0')).toBe(true); // at least one empty cell
  });

  it('is left-right symmetric: x=3 mirrors x=1, x=4 mirrors x=0 (observable from SVG)', () => {
    const svg = decodeDataUri(generateIdenticon('alice'));
    const rects = parseRects(svg);

    // Build a lookup: (x, y) → fill
    const fillAt = (x: number, y: number): string => {
      const r = rects.find(r => r.x === x && r.y === y);
      if (!r) throw new Error(`No rect found at x=${x} y=${y}`);
      return r.fill;
    };

    for (let row = 0; row < 5; row++) {
      // col 3 must mirror col 1
      expect(fillAt(3, row)).toBe(fillAt(1, row));
      // col 4 must mirror col 0
      expect(fillAt(4, row)).toBe(fillAt(0, row));
    }
  });

  it('symmetry holds for a different seed too (bob)', () => {
    const svg = decodeDataUri(generateIdenticon('bob'));
    const rects = parseRects(svg);
    const fillAt = (x: number, y: number): string => {
      const r = rects.find(r => r.x === x && r.y === y);
      if (!r) throw new Error(`No rect found at x=${x} y=${y}`);
      return r.fill;
    };
    for (let row = 0; row < 5; row++) {
      expect(fillAt(3, row)).toBe(fillAt(1, row));
      expect(fillAt(4, row)).toBe(fillAt(0, row));
    }
  });
});

describe('buildGrid', () => {
  it('returns a 5×5 boolean grid', () => {
    const grid = buildGrid('alice');
    expect(grid).toHaveLength(5);
    for (const row of grid) {
      expect(row).toHaveLength(5);
    }
  });

  it('is deterministic', () => {
    expect(buildGrid('alice')).toEqual(buildGrid('alice'));
  });

  it('col 3 mirrors col 1, col 4 mirrors col 0 for every row', () => {
    const grid = buildGrid('alice');
    for (let row = 0; row < 5; row++) {
      expect(grid[row][3]).toBe(grid[row][1]);
      expect(grid[row][4]).toBe(grid[row][0]);
    }
  });
});
