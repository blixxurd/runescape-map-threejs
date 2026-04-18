/**
 * OSRS tile-shape geometry.
 *
 * Each ground tile is 128×128 world units, with four corner heights
 * (sw, se, ne, nw). Without an overlay, the tile is just 2 triangles
 * colored from the blended underlay. With an overlay, the tile is
 * subdivided into 2–6 triangles via a shape table (13 shapes × 4
 * rotations); each triangle is flagged as underlay or overlay and gets
 * its color accordingly.
 *
 * Tables (`TILE_SHAPE_VERTEX_INDICES`, `TILE_SHAPE_FACES`) are the canonical
 * OSRS values, cross-referenced with dennisdev/rs-map-viewer's SceneTileModel.ts
 * and the 2004scape client. Format of TILE_SHAPE_FACES, per face:
 *   [isOverlay(0|1), aIdx, bIdx, cIdx]
 * where indices <4 refer to the 4 tile corners (rotated at runtime) and
 * indices >=4 refer to shape-specific extra vertices.
 */

export const TILE_SIZE = 128;
const HALF = TILE_SIZE / 2;
const QUARTER = TILE_SIZE / 4;
const THREE_QTR = (TILE_SIZE * 3) / 4;

export const TILE_SHAPE_VERTEX_INDICES: readonly (readonly number[])[] = [
  [1, 3, 5, 7],
  [1, 3, 5, 7],
  [1, 3, 5, 7],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 6],
  [1, 3, 5, 7, 2, 6],
  [1, 3, 5, 7, 2, 8],
  [1, 3, 5, 7, 2, 8],
  [1, 3, 5, 7, 11, 12],
  [1, 3, 5, 7, 11, 12],
  [1, 3, 5, 7, 13, 14],
];

export const TILE_SHAPE_FACES: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 0, 0, 1, 3],
  [1, 1, 2, 3, 1, 0, 1, 3],
  [0, 1, 2, 3, 1, 0, 1, 3],
  [0, 0, 1, 2, 0, 0, 2, 4, 1, 0, 4, 3],
  [0, 0, 1, 4, 0, 0, 4, 3, 1, 1, 2, 4],
  [0, 0, 4, 3, 1, 0, 1, 2, 1, 0, 2, 4],
  [0, 1, 2, 4, 1, 0, 1, 4, 1, 0, 4, 3],
  [0, 4, 1, 2, 0, 4, 2, 5, 1, 0, 4, 5, 1, 0, 5, 3],
  [0, 4, 1, 2, 0, 4, 2, 3, 0, 4, 3, 5, 1, 0, 4, 5],
  [0, 0, 4, 5, 1, 4, 1, 2, 1, 4, 2, 3, 1, 4, 3, 5],
  [0, 0, 1, 5, 0, 1, 4, 5, 0, 1, 2, 4, 1, 0, 5, 3, 1, 5, 4, 3, 1, 4, 2, 3],
  [1, 0, 1, 5, 1, 1, 4, 5, 1, 1, 2, 4, 0, 0, 5, 3, 0, 5, 4, 3, 0, 4, 2, 3],
  [1, 0, 5, 4, 1, 0, 1, 5, 0, 0, 4, 3, 0, 4, 5, 3, 0, 5, 2, 3, 0, 1, 2, 5],
];

/**
 * Pre-computed RGB colors at tile corners.
 * For underlays: HSL-blended across 4 neighboring tiles, then → RGB.
 * For overlays: flat per-tile color replicated at every corner.
 * `null` = no underlay touches this corner.
 */
export type Rgb = readonly [number, number, number];

/**
 * Per-corner colors. Both underlay and overlay are now 4-tuple — the OSRS
 * client applies per-corner lighting (`mixLightness(hsl, cornerLight)`),
 * giving each of SW/SE/NE/NW its own RGB. Midpoint and quarter-point
 * vertices defined by the shape table are computed by averaging adjacent
 * corner RGBs.
 *
 * `null` at any corner means "no underlay/overlay for that corner" (either
 * because the tile has no underlay/overlay at all, or, in future multi-region
 * work, because a neighbor hasn't loaded yet).
 */
export interface CornerColors {
  underlaySw: Rgb | null;
  underlaySe: Rgb | null;
  underlayNe: Rgb | null;
  underlayNw: Rgb | null;
  overlaySw: Rgb | null;
  overlaySe: Rgb | null;
  overlayNe: Rgb | null;
  overlayNw: Rgb | null;
}

/** Heights at tile corners (in world-Y units; already × 8 by getHeights()). */
export interface CornerHeights {
  sw: number;
  se: number;
  ne: number;
  nw: number;
}

export interface TriangleSoupOut {
  positions: number[]; // [x, y, z, x, y, z, ...]
  colors: number[]; // [r, g, b, a, r, g, b, a, ...], all 0..255
  uvs: number[]; // [u, v, u, v, ...]
}

/**
 * Atlas params threaded through to compute per-vertex UVs. `underlayCell` is
 * the atlas cell for underlay triangles (typically 0, the white cell — the
 * vertex color drives appearance). `overlayCell` is the cell for this tile's
 * overlay texture, or `underlayCell` when the overlay is a flat color.
 */
export interface TileAtlasInfo {
  cellsPerRow: number;
  atlasSize: number;
  underlayCell: number;
  overlayCell: number;
}

function cellUV(info: TileAtlasInfo, cell: number, u: number, v: number): [number, number] {
  const cellU = cell % info.cellsPerRow;
  const cellV = Math.floor(cell / info.cellsPerRow);
  const cellFrac = 1 / info.cellsPerRow;
  const inset = 0.5 / info.atlasSize;
  const uu = cellU * cellFrac + inset + (cellFrac - 2 * inset) * Math.max(0, Math.min(1, u));
  const vv = cellV * cellFrac + inset + (cellFrac - 2 * inset) * Math.max(0, Math.min(1, v));
  return [uu, vv];
}

/** Midpoint mix — simple RGB average. */
function midRgb(a: Rgb | null, b: Rgb | null, fallback: Rgb): Rgb {
  if (!a && !b) return fallback;
  if (!a) return b!;
  if (!b) return a;
  return [(a[0] + b[0]) >> 1, (a[1] + b[1]) >> 1, (a[2] + b[2]) >> 1];
}

const GREY: Rgb = [128, 128, 128];

/**
 * Emits the triangle soup for one tile at region-local (tileX, tileZ),
 * writing vertices in Three.js-handed coordinates (x east, z north, y up —
 * client's Y is flipped to make hills point up).
 *
 * shape=0 means "plain tile, only underlay". overlay=null also means no
 * overlay even if shape != 0.
 */
export function emitTileTriangles(
  tileX: number,
  tileZ: number,
  shape: number,
  rotation: number,
  heights: CornerHeights,
  colors: CornerColors,
  atlas: TileAtlasInfo,
  out: TriangleSoupOut,
): void {
  const vertexIndices = TILE_SHAPE_VERTEX_INDICES[shape] ?? TILE_SHAPE_VERTEX_INDICES[0]!;
  const faceTable = TILE_SHAPE_FACES[shape] ?? TILE_SHAPE_FACES[0]!;
  const hasOverlay =
    colors.overlaySw !== null ||
    colors.overlaySe !== null ||
    colors.overlayNe !== null ||
    colors.overlayNw !== null;

  const tileWx = tileX * TILE_SIZE;
  // Internal tile-local Z goes SW→NE (south at low Z, north at high Z)
  // to keep the shape-table case math readable. We flip Z at the final
  // output so the world convention is +Z = south (Three.js / glTF style),
  // giving a camera at +Z looking −Z a "north-at-top, east-on-right" view.
  const tileWz = tileZ * TILE_SIZE;

  const n = vertexIndices.length;
  const vx = new Array<number>(n);
  const vy = new Array<number>(n);
  const vz = new Array<number>(n);
  /** Tile-local UV (0..1 within the tile); atlas mapping is per-face later. */
  const vu = new Array<number>(n);
  const vvv = new Array<number>(n);
  const vUnder = new Array<Rgb>(n);
  const vOver = new Array<Rgb>(n);

  for (let i = 0; i < n; i++) {
    let vi = vertexIndices[i]!;
    if ((vi & 1) === 0 && vi <= 8) {
      vi = ((vi - rotation - rotation - 1) & 7) + 1;
    } else if (vi > 8 && vi <= 12) {
      vi = ((vi - 9 - rotation) & 3) + 9;
    } else if (vi > 12 && vi <= 16) {
      vi = ((vi - 13 - rotation) & 3) + 13;
    }

    let px = 0;
    let pz = 0;
    let py = 0;
    let underRgb: Rgb = GREY;
    let overRgb: Rgb = GREY;

    switch (vi) {
      case 1: // SW corner
        px = tileWx; pz = tileWz; py = heights.sw;
        underRgb = colors.underlaySw ?? GREY;
        overRgb = colors.overlaySw ?? GREY;
        break;
      case 2: // S midpoint
        px = tileWx + HALF; pz = tileWz; py = (heights.se + heights.sw) >> 1;
        underRgb = midRgb(colors.underlaySw, colors.underlaySe, GREY);
        overRgb = midRgb(colors.overlaySw, colors.overlaySe, GREY);
        break;
      case 3: // SE
        px = tileWx + TILE_SIZE; pz = tileWz; py = heights.se;
        underRgb = colors.underlaySe ?? GREY;
        overRgb = colors.overlaySe ?? GREY;
        break;
      case 4: // E mid
        px = tileWx + TILE_SIZE; pz = tileWz + HALF; py = (heights.ne + heights.se) >> 1;
        underRgb = midRgb(colors.underlaySe, colors.underlayNe, GREY);
        overRgb = midRgb(colors.overlaySe, colors.overlayNe, GREY);
        break;
      case 5: // NE
        px = tileWx + TILE_SIZE; pz = tileWz + TILE_SIZE; py = heights.ne;
        underRgb = colors.underlayNe ?? GREY;
        overRgb = colors.overlayNe ?? GREY;
        break;
      case 6: // N mid
        px = tileWx + HALF; pz = tileWz + TILE_SIZE; py = (heights.ne + heights.nw) >> 1;
        underRgb = midRgb(colors.underlayNe, colors.underlayNw, GREY);
        overRgb = midRgb(colors.overlayNe, colors.overlayNw, GREY);
        break;
      case 7: // NW
        px = tileWx; pz = tileWz + TILE_SIZE; py = heights.nw;
        underRgb = colors.underlayNw ?? GREY;
        overRgb = colors.overlayNw ?? GREY;
        break;
      case 8: // W mid
        px = tileWx; pz = tileWz + HALF; py = (heights.nw + heights.sw) >> 1;
        underRgb = midRgb(colors.underlayNw, colors.underlaySw, GREY);
        overRgb = midRgb(colors.overlayNw, colors.overlaySw, GREY);
        break;
      case 9:
        px = tileWx + HALF; pz = tileWz + QUARTER; py = (heights.se + heights.sw) >> 1;
        underRgb = midRgb(colors.underlaySw, colors.underlaySe, GREY);
        overRgb = midRgb(colors.overlaySw, colors.overlaySe, GREY);
        break;
      case 10:
        px = tileWx + THREE_QTR; pz = tileWz + HALF; py = (heights.ne + heights.se) >> 1;
        underRgb = midRgb(colors.underlaySe, colors.underlayNe, GREY);
        overRgb = midRgb(colors.overlaySe, colors.overlayNe, GREY);
        break;
      case 11:
        px = tileWx + HALF; pz = tileWz + THREE_QTR; py = (heights.ne + heights.nw) >> 1;
        underRgb = midRgb(colors.underlayNe, colors.underlayNw, GREY);
        overRgb = midRgb(colors.overlayNe, colors.overlayNw, GREY);
        break;
      case 12:
        px = tileWx + QUARTER; pz = tileWz + HALF; py = (heights.nw + heights.sw) >> 1;
        underRgb = midRgb(colors.underlayNw, colors.underlaySw, GREY);
        overRgb = midRgb(colors.overlayNw, colors.overlaySw, GREY);
        break;
      case 13:
        px = tileWx + QUARTER; pz = tileWz + QUARTER; py = heights.sw;
        underRgb = colors.underlaySw ?? GREY;
        overRgb = colors.overlaySw ?? GREY;
        break;
      case 14:
        px = tileWx + THREE_QTR; pz = tileWz + QUARTER; py = heights.se;
        underRgb = colors.underlaySe ?? GREY;
        overRgb = colors.overlaySe ?? GREY;
        break;
      case 15:
        px = tileWx + THREE_QTR; pz = tileWz + THREE_QTR; py = heights.ne;
        underRgb = colors.underlayNe ?? GREY;
        overRgb = colors.overlayNe ?? GREY;
        break;
      default: // 16
        px = tileWx + QUARTER; pz = tileWz + THREE_QTR; py = heights.nw;
        underRgb = colors.underlayNw ?? GREY;
        overRgb = colors.overlayNw ?? GREY;
        break;
    }

    vx[i] = px;
    // getHeights() returns positive-is-up already (client stores heights
    // positive, renders them at -height for its Y-down axis). For Three.js
    // with Y-up we use the raw value. Do NOT negate here — doing so
    // inverts the landscape (rivers become ridges).
    vy[i] = py;
    vz[i] = pz;
    // Tile-local UVs in [0, 1]. Computed before the Z flip so textures
    // tile once per (128×128) tile regardless of our world convention.
    vu[i] = (px - tileWx) / TILE_SIZE;
    vvv[i] = (pz - tileWz) / TILE_SIZE;
    vUnder[i] = underRgb;
    vOver[i] = overRgb;
  }

  const hasAnyUnderlay =
    colors.underlaySw !== null ||
    colors.underlaySe !== null ||
    colors.underlayNe !== null ||
    colors.underlayNw !== null;

  for (let f = 0; f < faceTable.length; f += 4) {
    const isOverlayFace = faceTable[f] === 1 && hasOverlay;
    let a = faceTable[f + 1]!;
    let b = faceTable[f + 2]!;
    let c = faceTable[f + 3]!;
    if (a < 4) a = (a - rotation) & 3;
    if (b < 4) b = (b - rotation) & 3;
    if (c < 4) c = (c - rotation) & 3;

    // Skip fully void tiles (no underlay, no overlay).
    if (!isOverlayFace && !hasAnyUnderlay && !hasOverlay) continue;

    const rgbA = isOverlayFace ? vOver[a]! : vUnder[a]!;
    const rgbB = isOverlayFace ? vOver[b]! : vUnder[b]!;
    const rgbC = isOverlayFace ? vOver[c]! : vUnder[c]!;

    // Atlas cell: overlay faces sample the overlay's texture (or white if
    // the overlay is color-only); underlay faces always sample white so the
    // blended vertex color comes through.
    const cell = isOverlayFace ? atlas.overlayCell : atlas.underlayCell;
    const [uA, vA] = cellUV(atlas, cell, vu[a]!, vvv[a]!);
    const [uB, vB] = cellUV(atlas, cell, vu[b]!, vvv[b]!);
    const [uC, vC] = cellUV(atlas, cell, vu[c]!, vvv[c]!);

    // Coordinate conversion at output:
    //   - Y already flipped during per-vertex compute (heights positive-up).
    //   - Z negated here to put +Z = south (Three.js camera convention).
    // The double flip (Y + Z) is handedness-preserving, so triangle winding
    // from the OSRS tables remains correct for FrontSide rendering — no
    // b/c swap needed.
    out.positions.push(
      vx[a]!, vy[a]!, -vz[a]!,
      vx[b]!, vy[b]!, -vz[b]!,
      vx[c]!, vy[c]!, -vz[c]!,
    );
    out.colors.push(
      rgbA[0], rgbA[1], rgbA[2], 255,
      rgbB[0], rgbB[1], rgbB[2], 255,
      rgbC[0], rgbC[1], rgbC[2], 255,
    );
    out.uvs.push(uA, vA, uB, vB, uC, vC);
  }
}
