/**
 * Deterministic identicon generator.
 *
 * Produces a 5×5 symmetrical icon from a string seed via SHA-256.
 * Returns a data:image/svg+xml;base64,… data-URI. Zero external deps (node:crypto only).
 *
 * Algorithm (PINNED):
 *   1. Hash seed with SHA-256 → 32-byte Buffer h.
 *   2. Build 5×5 grid: left three columns (col 0,1,2), row 0..4.
 *      Cell (col, row) is ON iff h[row*3 + col] & 1 (low bit of that byte).
 *   3. Mirror horizontally: col 3 = col 1, col 4 = col 0.
 *   4. Color: hue = Math.floor(h[15] / 255 * 360); filled = hsl(hue, 55%, 55%); empty = #f0f0f0.
 *   5. SVG: viewBox="0 0 5 5", one <rect per cell, 1×1 units, integer x/y.
 *   6. Return data:image/svg+xml;base64,<base64(svg)>.
 */

import { createHash } from 'node:crypto';

/**
 * Build the raw 5×5 boolean grid from a precomputed SHA-256 digest.
 * grid[row][col] is true when the cell is filled (ON).
 *
 * Internal — lets generateIdenticon share a single hash for both the grid
 * and the hue byte (h[15]), avoiding a redundant second hash of the seed.
 */
function buildGridFromHash(h: Buffer): boolean[][] {
  const grid: boolean[][] = [];
  for (let row = 0; row < 5; row++) {
    const rowCells: boolean[] = [];
    // Left three columns driven by h[row*3 + col]
    for (let col = 0; col < 3; col++) {
      rowCells[col] = (h[row * 3 + col] & 1) === 1;
    }
    // Mirror: col 3 = col 1, col 4 = col 0
    rowCells[3] = rowCells[1];
    rowCells[4] = rowCells[0];
    grid.push(rowCells);
  }
  return grid;
}

/**
 * Build the raw 5×5 boolean grid from a seed string.
 * grid[row][col] is true when the cell is filled (ON).
 *
 * Thin wrapper over buildGridFromHash. Exported so symmetry can be asserted
 * directly in tests.
 */
export function buildGrid(seed: string): boolean[][] {
  return buildGridFromHash(createHash('sha256').update(seed).digest());
}

/**
 * Generate a deterministic identicon data-URI for the given seed.
 *
 * The seed is hashed exactly once; both the grid and the hue byte (h[15])
 * derive from that single digest.
 *
 * @param seed - Any string (e.g. an agent handle or user name).
 * @returns `data:image/svg+xml;base64,…`
 */
export function generateIdenticon(seed: string): string {
  const h = createHash('sha256').update(seed).digest();

  const grid = buildGridFromHash(h);
  const hue = Math.floor((h[15] / 255) * 360);
  const filledColor = `hsl(${hue}, 55%, 55%)`;
  const emptyColor = '#f0f0f0';

  const rects: string[] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const fill = grid[row][col] ? filledColor : emptyColor;
      rects.push(`<rect width="1" height="1" x="${col}" y="${row}" fill="${fill}"/>`);
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5">${rects.join('')}</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
