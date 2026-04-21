import type { RSCache, MapDefinition, UnderlayDefinition, OverlayDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  blendUnderlayTiles,
  hsl16ToRgb,
  mixLightness,
  packHsl16Client,
  type UnderlayHsl,
} from "../color/hsl.js";
import { computeVertexLights, LIGHT_BASE } from "../color/terrainLight.js";
import {
  emitTileTriangles,
  type CornerColors,
  type CornerHeights,
  type TileAtlasInfo,
} from "../tables/tileShapes.js";
import type { BakedAtlas } from "../texture/atlas.js";
import type {
  TerrainMeta,
  TerrainDebug,
  TerrainDebugTile,
  DebugUnderlayDef,
  DebugOverlayDef,
} from "@rsmap/shared";
import { TILES_PER_SIDE, VERTICES_PER_SIDE, PLANES, TILE_SIZE, packRegionId } from "@rsmap/shared";

interface ResolvedPalette {
  underlays: Map<number, UnderlayDefinition>;
  overlays: Map<number, OverlayDefinition>;
}

/**
 * Find every unique underlay/overlay id across the center region and every
 * loaded neighbor, and resolve their defs once. The neighbor maps contribute
 * the 5-tile border needed for the 11×11 underlay blend window — an underlay
 * id that exists in a neighbor but not the center still has to be resolved
 * or the blend would silently drop it.
 */
async function resolvePalette(
  cache: RSCache,
  maps: (MapDefinition | null)[],
): Promise<ResolvedPalette> {
  const underlayIds = new Set<number>();
  const overlayIds = new Set<number>();
  for (const map of maps) {
    if (!map) continue;
    for (let z = 0; z < PLANES; z++) {
      for (let x = 0; x < TILES_PER_SIDE; x++) {
        for (let y = 0; y < TILES_PER_SIDE; y++) {
          const t = map.tiles[z]?.[x]?.[y];
          if (!t) continue;
          if (t.underlayId && t.underlayId > 0) underlayIds.add(t.underlayId);
          if (t.overlayId && t.overlayId > 0) overlayIds.add(t.overlayId);
        }
      }
    }
  }

  const underlays = new Map<number, UnderlayDefinition>();
  for (const id of underlayIds) {
    const def = (await cache.getDef(
      IndexType.CONFIGS,
      ConfigType.UNDERLAY,
      id - 1,
    )) as UnderlayDefinition | undefined;
    if (def) underlays.set(id, def);
  }

  const overlays = new Map<number, OverlayDefinition>();
  for (const id of overlayIds) {
    const def = (await cache.getDef(
      IndexType.CONFIGS,
      ConfigType.OVERLAY,
      id - 1,
    )) as OverlayDefinition | undefined;
    if (def) overlays.set(id, def);
  }

  return { underlays, overlays };
}

/**
 * Width of the 5-tile border the blend needs past each region edge. Must
 * match `BLEND_RADIUS` in `color/hsl.ts` (the client's 11×11 blend window
 * radius). We pad the center region with this much neighbor data so the
 * blend window at tile x=63 sees the east neighbor's [0..4] tiles — making
 * the smoothed underlay colors line up across region seams.
 */
const SCENE_PAD = 5;
const SCENE_SIZE = TILES_PER_SIDE + 2 * SCENE_PAD; // 74

/**
 * `neighbors[di + 1][dj + 1]` where `di, dj ∈ {-1, 0, 1}`. Self is [1][1].
 * Null entries = ocean / missing-from-cache. Used to fill the 5-tile border
 * around the center region for both the underlay blend and the contoured-loc
 * height sampler.
 */
type NeighborGrid = (MapDefinition | null)[][];

/**
 * Per-tile blended packed-HSL grid, client-authentic.
 *
 * The OSRS client runs its 11×11 underlay blend (`Landscape.java:423–473`)
 * on a 104×104 scene array that already contains data from every region the
 * scene intersects. The blend therefore smoothly crosses region seams.
 *
 * We replicate that by building a 74×74 *padded* tile grid around the center
 * region — center fills [5..68], neighbors fill the 5-tile border — then run
 * the existing blend on it. After the blend, we return the central 64×64
 * slice as the per-region output. Edge tiles now see up to 5 rows of
 * neighbor data in the blend window and stop banding at seams.
 *
 * Where a neighbor is missing (ocean), that slice of the border is left
 * null; the blend naturally handles missing tiles (`if(!u) continue`), so
 * world-boundary regions fall back to the old truncated-window behavior
 * there — the same thing the client does when a scene extends past loaded
 * chunks.
 */
function buildBlendedUnderlays(
  neighbors: NeighborGrid,
  palette: ResolvedPalette,
): Int32Array[] {
  const perPlane: Int32Array[] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    const padded: (UnderlayHsl | null)[] = new Array(SCENE_SIZE * SCENE_SIZE).fill(null);
    for (let pz = 0; pz < SCENE_SIZE; pz++) {
      for (let px = 0; px < SCENE_SIZE; px++) {
        // Map scene index → (neighbor, local tile). A px of 0..4 is the west
        // neighbor's x=[59..63]; px of 5..68 is our region's x=[0..63];
        // px of 69..73 is the east neighbor's x=[0..4]. Same for z.
        const tx = px - SCENE_PAD;
        const tz = pz - SCENE_PAD;
        const di = tx < 0 ? -1 : tx >= TILES_PER_SIDE ? 1 : 0;
        const dj = tz < 0 ? -1 : tz >= TILES_PER_SIDE ? 1 : 0;
        const lx = tx - di * TILES_PER_SIDE;
        const lz = tz - dj * TILES_PER_SIDE;
        const src = neighbors[di + 1]![dj + 1]!;
        if (!src) continue;
        const tile = src.tiles[plane]?.[lx]?.[lz];
        const id = tile?.underlayId ?? 0;
        if (id === 0) continue;
        const def = palette.underlays.get(id);
        if (!def || def.hueMultiplier === undefined) continue;
        padded[pz * SCENE_SIZE + px] = {
          hue: def.hue,
          saturation: def.saturation,
          lightness: def.lightness,
          hueMultiplier: def.hueMultiplier,
        };
      }
    }
    const blendedPadded = blendUnderlayTiles(padded, SCENE_SIZE);
    // Extract the central 64×64 block — that's our region's result.
    const out = new Int32Array(TILES_PER_SIDE * TILES_PER_SIDE);
    for (let z = 0; z < TILES_PER_SIDE; z++) {
      for (let x = 0; x < TILES_PER_SIDE; x++) {
        out[z * TILES_PER_SIDE + x] =
          blendedPadded[(z + SCENE_PAD) * SCENE_SIZE + (x + SCENE_PAD)]!;
      }
    }
    perPlane.push(out);
  }
  return perPlane;
}

/** Phase-1 output: resolved data that later phases need but that doesn't depend on the atlas. */
export interface TerrainPlan {
  map: MapDefinition;
  palette: ResolvedPalette;
  /** 65×65 per-vertex heights used for terrain mesh emission. Central
   *  region's own tiles plus the east/north/NE edge stitched from neighbors
   *  so x=64 / z=64 / (64,64) vertices match the adjacent regions. */
  heights: number[][][];
  /** 74×74 padded heights (`sceneHeights[plane][px][pz]`, px,pz ∈ [0..73])
   *  used for contoured-loc vertex deformation so models whose geometry
   *  extends past the region edge sample from the neighbor region's
   *  heights, not a zero-filled default. Center region lives at px,pz ∈
   *  [5..69]. See `samplePaddedSceneHeight` in `region/locs.ts`. */
  sceneHeights: number[][][];
  blendedUnderlays: Int32Array[]; // per-plane packed-HSL grid
  regionX: number;
  regionZ: number;
  buildInfo: { buildId: number; sourceCacheId: number };
}

/**
 * Best-effort load of a neighbor region. Returns null if the neighbor doesn't
 * exist in the cache (ocean, off-map). osrscachereader throws from `getMap`
 * when no archive matches the name hash, so catch and absorb.
 */
async function loadNeighborMap(
  cache: RSCache,
  regionX: number,
  regionZ: number,
): Promise<MapDefinition | null> {
  try {
    const map = await cache.getMap(regionX, regionZ);
    if (!map || !map.tiles || !map.tiles[0]) return null;
    return map;
  } catch {
    return null;
  }
}

/**
 * Build the 65×65 per-vertex heights grid for terrain mesh emission.
 * `getHeights()` only gives 64×64 (one per tile SW corner), so the east
 * column, north row, and NE corner come from neighbors' (0, z) / (x, 0) /
 * (0, 0) tile corners.
 *
 * Without this the east + north edges of each region bundle were snapped
 * to Y=0, giving a visible cliff where two regions meet (and a sub-horizon
 * dip on the two far edges of a single-region view that fog happened to
 * hide). Fallback when a neighbor is missing: replicate the edge we do
 * have — flat ledge at the world boundary rather than a floor-dropping
 * seam. Mirrors what the client does at the world edge.
 */
function stitchEdgeHeights(
  self: number[][][],
  neighbors: NeighborGrid,
): void {
  const eastH = neighbors[2]![1]?.getHeights() ?? null;
  const northH = neighbors[1]![2]?.getHeights() ?? null;
  const neH = neighbors[2]![2]?.getHeights() ?? null;
  for (let plane = 0; plane < PLANES; plane++) {
    const p = self[plane]!;
    p[TILES_PER_SIDE] = new Array(VERTICES_PER_SIDE);
    for (let z = 0; z < TILES_PER_SIDE; z++) {
      const v = eastH?.[plane]?.[0]?.[z];
      p[TILES_PER_SIDE]![z] = v ?? p[TILES_PER_SIDE - 1]![z]!;
    }
    for (let x = 0; x < TILES_PER_SIDE; x++) {
      const v = northH?.[plane]?.[x]?.[0];
      p[x]![TILES_PER_SIDE] = v ?? p[x]![TILES_PER_SIDE - 1]!;
    }
    const ne =
      neH?.[plane]?.[0]?.[0] ??
      eastH?.[plane]?.[0]?.[TILES_PER_SIDE - 1] ??
      northH?.[plane]?.[TILES_PER_SIDE - 1]?.[0] ??
      p[TILES_PER_SIDE - 1]![TILES_PER_SIDE - 1]!;
    p[TILES_PER_SIDE]![TILES_PER_SIDE] = ne;
  }
}

/**
 * 74×74 padded per-tile heights (`[plane][px][pz]`, px,pz ∈ [0..73]) with the
 * center region's heights at px,pz ∈ [5..69] and a 5-tile border drawn from
 * each of the 8 neighbors. Used by contoured-loc vertex deformation so
 * models that extend past the region edge sample the neighbor's heights
 * instead of zero.
 *
 * Missing neighbors leave their slice replicated from the nearest
 * in-bounds column — the same flat-edge fallback terrain emission uses.
 * Heights are *tile SW corner* values (`getHeights()` semantics), so a
 * padded index px/pz refers to the SW corner of the scene-space tile at
 * that index.
 */
function buildSceneHeights(neighbors: NeighborGrid): number[][][] {
  const cache: (number[][][] | null)[][] = neighbors.map((row) =>
    row.map((map) => (map ? map.getHeights() : null)),
  );
  const sceneHeights: number[][][] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    const planeGrid: number[][] = new Array(SCENE_SIZE);
    for (let px = 0; px < SCENE_SIZE; px++) {
      planeGrid[px] = new Array(SCENE_SIZE);
      for (let pz = 0; pz < SCENE_SIZE; pz++) {
        const tx = px - SCENE_PAD;
        const tz = pz - SCENE_PAD;
        let di = tx < 0 ? -1 : tx >= TILES_PER_SIDE ? 1 : 0;
        let dj = tz < 0 ? -1 : tz >= TILES_PER_SIDE ? 1 : 0;
        let lx = tx - di * TILES_PER_SIDE;
        let lz = tz - dj * TILES_PER_SIDE;
        let src = cache[di + 1]![dj + 1]!;
        if (!src) {
          // Neighbor absent: fall back to the nearest in-bounds column of
          // the center region. Gives a flat ledge rather than y=0 cliffs.
          di = 0;
          dj = 0;
          lx = Math.max(0, Math.min(TILES_PER_SIDE - 1, tx));
          lz = Math.max(0, Math.min(TILES_PER_SIDE - 1, tz));
          src = cache[1]![1]!;
        }
        planeGrid[px]![pz] = src?.[plane]?.[lx]?.[lz] ?? 0;
      }
    }
    sceneHeights.push(planeGrid);
  }
  return sceneHeights;
}

/** Phase 1: resolve data (palette, heights, blends). No atlas, no geometry yet. */
export async function prepareTerrain(
  cache: RSCache,
  regionX: number,
  regionZ: number,
  buildInfo: { buildId: number; sourceCacheId: number },
): Promise<TerrainPlan> {
  console.log(`[terrain] getMap(${regionX}, ${regionZ})`);
  // `osrscachereader` throws an opaque "reading 'id'" error from deep
  // inside `getMap` when the region's archive is missing (off-map ids,
  // ocean squares). Treat any throw AND the null-ish return paths as
  // "no map data" so the middleware can answer 404 instead of 500.
  let map: MapDefinition | null | undefined;
  try {
    map = await cache.getMap(regionX, regionZ);
  } catch (e) {
    console.warn(`[terrain] getMap failed: ${(e as Error).message}`);
    throw new Error(`No map data for region (${regionX}, ${regionZ})`);
  }
  if (!map || !map.tiles || !map.tiles[0]) {
    throw new Error(`No map data for region (${regionX}, ${regionZ})`);
  }

  // Load the 8 cardinal + diagonal neighbors in parallel. We need them for:
  //   - stitching our 65×65 terrain vertex grid at the east/north edges,
  //   - running the underlay blend across the full 74×74 scene window,
  //   - feeding the contoured-loc height sampler past our region edge.
  // Missing neighbors (ocean, off-map) are null; every consumer handles that.
  const neighborFlat = await Promise.all([
    loadNeighborMap(cache, regionX - 1, regionZ - 1), // SW
    loadNeighborMap(cache, regionX, regionZ - 1),     // S
    loadNeighborMap(cache, regionX + 1, regionZ - 1), // SE
    loadNeighborMap(cache, regionX - 1, regionZ),     // W
    loadNeighborMap(cache, regionX + 1, regionZ),     // E
    loadNeighborMap(cache, regionX - 1, regionZ + 1), // NW
    loadNeighborMap(cache, regionX, regionZ + 1),     // N
    loadNeighborMap(cache, regionX + 1, regionZ + 1), // NE
  ]);
  // Fold into `neighbors[di + 1][dj + 1]` with self at [1][1].
  const neighbors: NeighborGrid = [
    [neighborFlat[0], neighborFlat[3], neighborFlat[5]], // di = -1 (west column)
    [neighborFlat[1], map,             neighborFlat[6]], // di =  0 (center column)
    [neighborFlat[2], neighborFlat[4], neighborFlat[7]], // di =  1 (east column)
  ];
  const loadedCount = neighborFlat.filter((n) => n !== null).length;
  console.log(`[terrain] loaded ${loadedCount}/8 neighbor regions for scene padding`);

  const heights = map.getHeights();
  stitchEdgeHeights(heights, neighbors);
  const sceneHeights = buildSceneHeights(neighbors);

  const palette = await resolvePalette(
    cache,
    neighborFlat.concat([map]),
  );
  console.log(
    `[terrain] ${palette.underlays.size} underlay defs, ${palette.overlays.size} overlay defs (incl. neighbors)`,
  );
  const blendedUnderlays = buildBlendedUnderlays(neighbors, palette);
  return {
    map,
    palette,
    heights,
    sceneHeights,
    blendedUnderlays,
    regionX,
    regionZ,
    buildInfo,
  };
}

/**
 * Every texture id referenced by this terrain (overlays + underlays). The
 * atlas builder needs this to size itself before geometry emission.
 */
export function collectTerrainTextureIds(plan: TerrainPlan): Set<number> {
  const ids = new Set<number>();
  for (const odef of plan.palette.overlays.values()) {
    if (odef.texture !== undefined && odef.texture >= 0) ids.add(odef.texture);
  }
  for (const udef of plan.palette.underlays.values()) {
    if (udef.textureId !== undefined && udef.textureId >= 0) ids.add(udef.textureId);
  }
  return ids;
}

export interface BakedTerrain {
  meta: TerrainMeta;
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  heights: Int16Array;
  triangleTiles: Uint16Array;
  debug: TerrainDebug;
}

/** Phase 2: emit geometry with UVs into the given atlas. */
export function emitTerrain(plan: TerrainPlan, atlas: BakedAtlas): BakedTerrain {
  const { map, palette, heights, blendedUnderlays, regionX, regionZ, buildInfo } = plan;
  const atlasInfoBase = {
    cellsPerRow: atlas.manifest.cellsPerRow,
    atlasSize: atlas.manifest.atlasSize,
    cellSize: atlas.manifest.cellSize,
    gutter: atlas.manifest.gutter ?? 0,
  };

  const perPlane: { positions: number[]; colors: number[]; uvs: number[]; triangleTiles: number[] }[] = [];
  // Debug tiles — one entry per (plane, x, z) we actually emit.
  const debugTiles: TerrainDebugTile[] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    const positions: number[] = [];
    const colors: number[] = [];
    const uvs: number[] = [];
    const triangleTiles: number[] = [];

    const planeHeights: number[] = new Array(VERTICES_PER_SIDE * VERTICES_PER_SIDE);
    for (let vz = 0; vz < VERTICES_PER_SIDE; vz++) {
      for (let vx = 0; vx < VERTICES_PER_SIDE; vx++) {
        planeHeights[vz * VERTICES_PER_SIDE + vx] = heights[plane]?.[vx]?.[vz] ?? 0;
      }
    }
    const vertexLights = computeVertexLights({
      heights: planeHeights,
      stride: VERTICES_PER_SIDE,
      size: VERTICES_PER_SIDE,
    });
    const lightAt = (vx: number, vz: number): number =>
      vertexLights[vz * VERTICES_PER_SIDE + vx] ?? LIGHT_BASE;

    const blended = blendedUnderlays[plane]!;

    /** Per-corner RGB for a tile's own underlay HSL, shaded by that
     *  corner's light. Per-client behavior (`Landscape.java:554`), all four
     *  corners of tile `(tx, tz)` share the tile's blended HSL and differ
     *  only in lighting. */
    const cornerUnderlayRgb = (
      tilePacked: number,
      vx: number,
      vz: number,
    ): [number, number, number] | null => {
      if (tilePacked < 0) return null;
      return hsl16ToRgb(mixLightness(tilePacked, lightAt(vx, vz)));
    };

    /** Same, but for an overlay's packed HSL (per-corner). Overlay HSL is
     *  the same across all corners of a tile; lighting makes them differ. */
    const cornerOverlayRgb = (
      overlayPacked: number,
      vx: number,
      vz: number,
    ): [number, number, number] | null => {
      if (overlayPacked < 0) return null;
      return hsl16ToRgb(mixLightness(overlayPacked, lightAt(vx, vz)));
    };

    for (let x = 0; x < TILES_PER_SIDE; x++) {
      for (let z = 0; z < TILES_PER_SIDE; z++) {
        const tile = map.tiles[plane]?.[x]?.[z];
        if (!tile) continue;

        // Cache stores `overlayPath` in 0..11. The render shape index is
        // `overlayPath + 1` per `Landscape.java:517` (cross-checked in
        // `reference/Model.java` + `SceneBuilder.addTileModels`). Our
        // shape table puts "2 underlay triangles" at index 0 and "2
        // overlay triangles" at index 1, so without this +1 any tile
        // fully covered by an overlay (overlayPath=0) rendered as pure
        // underlay (e.g. water tiles showed as grass).
        //
        // `Math.floor` because osrscachereader's MapLoader computes
        // `tile.overlayPath = (attribute - 2) / 4` — that's integer
        // division in Java but floating-point in JS, so attributes like
        // 20 give 4.5 → +1 = 5.5 → `TILE_SHAPE_FACES[5.5]` is undefined →
        // we silently fell back to shape 0 = pure underlay.
        const rotation = tile.overlayRotation ?? 0;
        const overlayIdRaw = tile.overlayId ?? 0;
        const underlayId = tile.underlayId ?? 0;

        // Magenta-sentinel overlays (raw RGB = 0xFF00FF) mean "invisible
        // overlay" in the OSRS client (Landscape.java line 526, cross-checked
        // against rs-map-viewer's SceneBuilder which reads `primaryRgb`). The
        // library's OverlayLoader packs `color` into HSL16 before we see it,
        // and its buggy `readInt24` sign-extends the low byte so 0xFF00FF
        // reads back as -1 (indistinguishable from 0xFFFFFF). Our
        // `floorLoaders.ts` patch reads three unsigned bytes directly and
        // preserves the clean uint24 in `rawPrimaryRgb`, which is what we
        // compare here. Treating the sentinel as "no overlay" lets the
        // underlay render through (matching the client) and — when the tile
        // has no underlay either — skips the tile entirely, which is how the
        // real "empty air on plane > 0" tiles end up invisible.
        const odefEarly = overlayIdRaw > 0 ? palette.overlays.get(overlayIdRaw) : undefined;
        const overlayIsMagentaSentinel = odefEarly?.rawPrimaryRgb === 0xff00ff;
        const overlayId = overlayIsMagentaSentinel ? 0 : overlayIdRaw;
        const hasOverlay = overlayId > 0;

        // With both overlay and underlay gone (pure sentinel on empty-plane
        // tile) there's nothing to draw — the client skips these entirely.
        if (!hasOverlay && underlayId === 0) continue;

        const shape = hasOverlay ? Math.floor(tile.overlayPath ?? 0) + 1 : 0;

        // Atlas cells for this tile: underlay-side and overlay-side.
        let underlayCell = 0;
        if (underlayId > 0) {
          const udef = palette.underlays.get(underlayId);
          if (udef?.textureId !== undefined && udef.textureId >= 0) {
            const cell = atlas.manifest.cellByTextureId[udef.textureId];
            if (cell !== undefined) underlayCell = cell;
          }
        }
        // Per-tile blended underlay HSL (11×11 window). All 4 corners of
        // this tile share it; per-corner lighting differentiates them.
        const underlayPacked = underlayId > 0 ? blended[z * TILES_PER_SIDE + x] ?? -1 : -1;

        // Per-tile overlay HSL. The library's OverlayLoader already packs
        // its `def.color` into 16-bit HSL via `convertToHsl`. For textured
        // overlays we pass a "lit white" HSL (hue=0, sat=0, lum=127) so
        // vertex colors describe lighting only and the atlas texture
        // provides hue.
        let overlayPacked = -1;
        let overlayCell = 0;
        let overlayIsMagenta = false;
        if (hasOverlay) {
          const odef = palette.overlays.get(overlayId);
          if (odef) {
            if (odef.texture !== undefined && odef.texture >= 0) {
              const cell = atlas.manifest.cellByTextureId[odef.texture];
              if (cell !== undefined) overlayCell = cell;
              // Lit-white HSL: hue=0, sat=0, lum=127 → pure white before lighting.
              overlayPacked = packHsl16Client(0, 0, 255);
            } else {
              overlayPacked = odef.color;
            }
          } else {
            overlayIsMagenta = true;
          }
        }

        const h: CornerHeights = {
          sw: heights[plane]?.[x]?.[z] ?? 0,
          se: heights[plane]?.[x + 1]?.[z] ?? 0,
          ne: heights[plane]?.[x + 1]?.[z + 1] ?? 0,
          nw: heights[plane]?.[x]?.[z + 1] ?? 0,
        };
        const magenta: [number, number, number] = [200, 60, 180];
        const colorsIn: CornerColors = {
          underlaySw: cornerUnderlayRgb(underlayPacked, x, z),
          underlaySe: cornerUnderlayRgb(underlayPacked, x + 1, z),
          underlayNe: cornerUnderlayRgb(underlayPacked, x + 1, z + 1),
          underlayNw: cornerUnderlayRgb(underlayPacked, x, z + 1),
          overlaySw: overlayIsMagenta ? magenta : cornerOverlayRgb(overlayPacked, x, z),
          overlaySe: overlayIsMagenta ? magenta : cornerOverlayRgb(overlayPacked, x + 1, z),
          overlayNe: overlayIsMagenta ? magenta : cornerOverlayRgb(overlayPacked, x + 1, z + 1),
          overlayNw: overlayIsMagenta ? magenta : cornerOverlayRgb(overlayPacked, x, z + 1),
        };
        const atlasInfo: TileAtlasInfo = { ...atlasInfoBase, underlayCell, overlayCell };

        emitTileTriangles(x, z, shape, rotation, h, colorsIn, atlasInfo, {
          positions,
          colors,
          uvs,
          triangleTiles,
        });

        debugTiles.push({
          plane,
          x,
          z,
          underlayId,
          overlayId,
          overlayShape: shape,
          overlayRotation: rotation,
          settings: tile.settings ?? 0,
          blendedHsl: underlayPacked,
        });
      }
    }
    perPlane.push({ positions, colors, uvs, triangleTiles });
    console.log(
      `[terrain] plane ${plane}: ${positions.length / 9} triangles, ${colors.length / 4} vertices`,
    );
  }

  let totalVertexCount = 0;
  for (const p of perPlane) totalVertexCount += p.positions.length / 3;

  const positions = new Float32Array(totalVertexCount * 3);
  const colors = new Uint8Array(totalVertexCount * 4);
  const uvs = new Float32Array(totalVertexCount * 2);
  const totalTriCount = totalVertexCount / 3;
  const triangleTiles = new Uint16Array(totalTriCount);
  const planeRanges: TerrainMeta["planeRanges"] = [];
  let posWrite = 0;
  let colWrite = 0;
  let uvWrite = 0;
  let triWrite = 0;
  for (let plane = 0; plane < PLANES; plane++) {
    const p = perPlane[plane]!;
    const vCount = p.positions.length / 3;
    planeRanges.push({
      plane,
      vertexCount: vCount,
      positionsByteOffset: posWrite * 4,
      colorsByteOffset: colWrite,
      uvsByteOffset: uvWrite * 4,
    });
    for (let i = 0; i < p.positions.length; i++) positions[posWrite + i] = p.positions[i]!;
    for (let i = 0; i < p.colors.length; i++) colors[colWrite + i] = p.colors[i]!;
    for (let i = 0; i < p.uvs.length; i++) uvs[uvWrite + i] = p.uvs[i]!;
    for (let i = 0; i < p.triangleTiles.length; i++) triangleTiles[triWrite + i] = p.triangleTiles[i]!;
    posWrite += p.positions.length;
    colWrite += p.colors.length;
    uvWrite += p.uvs.length;
    triWrite += p.triangleTiles.length;
  }

  const heights16 = new Int16Array(PLANES * VERTICES_PER_SIDE * VERTICES_PER_SIDE);
  for (let plane = 0; plane < PLANES; plane++) {
    for (let z = 0; z < VERTICES_PER_SIDE; z++) {
      for (let x = 0; x < VERTICES_PER_SIDE; x++) {
        const h = heights[plane]?.[x]?.[z] ?? 0;
        const hy = Math.max(-32768, Math.min(32767, h));
        heights16[plane * VERTICES_PER_SIDE * VERTICES_PER_SIDE + z * VERTICES_PER_SIDE + x] = hy;
      }
    }
  }

  const meta: TerrainMeta = {
    schemaVersion: 2,
    regionId: packRegionId(regionX, regionZ),
    regionX,
    regionZ,
    planes: PLANES,
    tileSize: TILE_SIZE,
    buildId: buildInfo.buildId,
    sourceCacheId: buildInfo.sourceCacheId,
    planeRanges,
    totalVertexCount,
    positionsByteLength: positions.byteLength,
    colorsByteLength: colors.byteLength,
    uvsByteLength: uvs.byteLength,
    positionsFile: "terrain.pos.bin",
    colorsFile: "terrain.col.bin",
    uvsFile: "terrain.uv.bin",
    heightsFile: "terrain.heights.bin",
    heightsByteLength: heights16.byteLength,
    triangleTilesFile: "terrain.tri_tiles.bin",
    triangleTilesByteLength: triangleTiles.byteLength,
  };

  const debugUnderlays: Record<number, DebugUnderlayDef> = {};
  for (const [id, u] of palette.underlays) {
    debugUnderlays[id] = {
      id,
      rawRgb: u.rawRgb ?? 0,
      hue: u.hue,
      saturation: u.saturation,
      lightness: u.lightness,
      hueMultiplier: u.hueMultiplier ?? 0,
      textureId: u.textureId,
    };
  }
  const debugOverlays: Record<number, DebugOverlayDef> = {};
  for (const [id, o] of palette.overlays) {
    debugOverlays[id] = {
      id,
      // Library doesn't keep raw RGB on overlays by default; our floorLoaders
      // patch captures it into `rawPrimaryRgb`. Fall back to 0 when missing
      // (e.g. overlay has no opcode 1 and is texture-only).
      rawRgb: o.rawPrimaryRgb ?? 0,
      packedHsl: o.color,
      textureId: o.texture,
      hideUnderlay: o.hideUnderlay,
      secondaryColor: o.secondaryColor,
      secondaryTextureId: o.secondaryTextureId,
    };
  }

  const debug: TerrainDebug = {
    schemaVersion: 1,
    regionId: meta.regionId,
    tiles: debugTiles,
    underlays: debugUnderlays,
    overlays: debugOverlays,
  };

  return { meta, positions, colors, uvs, heights: heights16, triangleTiles, debug };
}

export async function writeTerrainBundle(baked: BakedTerrain, outDir: string): Promise<void> {
  await writeFile(join(outDir, baked.meta.positionsFile), Buffer.from(baked.positions.buffer));
  await writeFile(join(outDir, baked.meta.colorsFile), Buffer.from(baked.colors.buffer));
  await writeFile(join(outDir, baked.meta.uvsFile), Buffer.from(baked.uvs.buffer));
  await writeFile(join(outDir, baked.meta.heightsFile), Buffer.from(baked.heights.buffer));
  await writeFile(join(outDir, baked.meta.triangleTilesFile), Buffer.from(baked.triangleTiles.buffer));
  await writeFile(join(outDir, "terrain.meta.json"), JSON.stringify(baked.meta, null, 2));
  await writeFile(join(outDir, "terrain.debug.json"), JSON.stringify(baked.debug));
  console.log(
    `[terrain] wrote ${baked.meta.totalVertexCount} vertices (` +
      `${(baked.meta.positionsByteLength / 1024).toFixed(1)} KB positions, ` +
      `${(baked.meta.colorsByteLength / 1024).toFixed(1)} KB colors, ` +
      `${(baked.meta.uvsByteLength / 1024).toFixed(1)} KB uvs, ` +
      `${(baked.meta.heightsByteLength / 1024).toFixed(1)} KB heights)`,
  );
}
