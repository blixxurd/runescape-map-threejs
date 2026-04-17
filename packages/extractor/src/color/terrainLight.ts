/**
 * OSRS-style per-vertex terrain lighting, ported from dennisdev/rs-map-viewer's
 * `Scene.calculateTileLights`. The client treats the surface as a heightmap,
 * derives a normal from finite height differences, takes a dot product with a
 * fixed directional light, and adds a uniform ambient term.
 *
 * Our heights are stored positive-is-up. The rs-map-viewer reference uses
 * negative-is-up, which matters because the normal direction flips with the
 * sign convention. We compensate by negating the height deltas so the formula
 * remains "cross-product of tangents against a fixed light" in client-space.
 *
 * Output: a 65×65 grid of per-vertex light multipliers in the 0..~200 range.
 * `INTENSITY_BASE` (96) is the resting/ambient value for flat ground; slopes
 * facing the light go higher, away-facing go lower. Callers multiply their
 * per-vertex RGB by `light / INTENSITY_BASE` to apply shading.
 */

const LIGHT_DIR_X = -50;
const LIGHT_DIR_Y = -10;
const LIGHT_DIR_Z = -50;
const INTENSITY_BASE = 96;
const INTENSITY_FACTOR = 768;
const HEIGHT_SCALE = 65536;

export const LIGHT_BASE = INTENSITY_BASE;

const LIGHT_MAG =
  Math.sqrt(LIGHT_DIR_X * LIGHT_DIR_X + LIGHT_DIR_Y * LIGHT_DIR_Y + LIGHT_DIR_Z * LIGHT_DIR_Z) | 0;
const LIGHT_INTENSITY = (LIGHT_MAG * INTENSITY_FACTOR) >> 8;

export interface HeightGrid {
  /** `heights[z * stride + x]` — z is the cache's tile-north index, x east. */
  heights: number[];
  stride: number; // typically 65 (VERTICES_PER_SIDE)
  size: number; // typically 65
}

/**
 * Returns a flat (size*size) array of per-vertex light values. Border
 * vertices (x=0, x=size-1, z=0, z=size-1) fall back to `INTENSITY_BASE`
 * because the 3×3 stencil would need to sample outside the region; the OSRS
 * client handles that via cross-region blending which we defer past M1.
 */
export function computeVertexLights(grid: HeightGrid): Int16Array {
  const { heights, stride, size } = grid;
  const out = new Int16Array(size * size);
  out.fill(INTENSITY_BASE);

  const sample = (x: number, z: number): number => heights[z * stride + x]!;

  for (let z = 1; z < size - 1; z++) {
    for (let x = 1; x < size - 1; x++) {
      // Negate deltas to match the rs-map-viewer convention (which uses
      // heights-are-negative-for-elevated). Our heights are positive-up.
      const hdX = -(sample(x + 1, z) - sample(x - 1, z));
      const hdZ = -(sample(x, z + 1) - sample(x, z - 1));
      const len = Math.sqrt(hdX * hdX + hdZ * hdZ + HEIGHT_SCALE) | 0;
      if (len === 0) continue;
      const nx = ((hdX << 8) / len) | 0;
      const ny = (HEIGHT_SCALE / len) | 0;
      const nz = ((hdZ << 8) / len) | 0;
      const dot = nx * LIGHT_DIR_X + ny * LIGHT_DIR_Y + nz * LIGHT_DIR_Z;
      const light = ((dot / LIGHT_INTENSITY) | 0) + INTENSITY_BASE;
      out[z * stride + x] = light;
    }
  }

  return out;
}

/**
 * Apply per-vertex light to an RGB triple. `light` is the value from
 * `computeVertexLights` (range roughly 0..200, base 96). Flat ground keeps
 * its color; slopes lighten/darken proportionally. Clamped to keep colors
 * from saturating or going fully black.
 */
export function shadeRgb(rgb: readonly [number, number, number], light: number): [number, number, number] {
  const factor = Math.max(0.25, Math.min(1.8, light / INTENSITY_BASE));
  return [
    Math.max(0, Math.min(255, (rgb[0] * factor) | 0)),
    Math.max(0, Math.min(255, (rgb[1] * factor) | 0)),
    Math.max(0, Math.min(255, (rgb[2] * factor) | 0)),
  ];
}
