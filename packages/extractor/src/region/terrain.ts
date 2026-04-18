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
import { TILES_PER_SIDE, VERTICES_PER_SIDE, PLANES, TILE_SIZE } from "@rsmap/shared";

interface ResolvedPalette {
  underlays: Map<number, UnderlayDefinition>;
  overlays: Map<number, OverlayDefinition>;
}

/** Find every unique underlay/overlay id in the region and resolve their defs once. */
async function resolvePalette(cache: RSCache, map: MapDefinition): Promise<ResolvedPalette> {
  const underlayIds = new Set<number>();
  const overlayIds = new Set<number>();
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
 * Per-tile blended packed-HSL grid. Client-authentic 11×11 window blend that
 * correctly normalizes the pre-weighted underlay hue via
 * `avgHue = (sumHue × 256) / sumMultiplier` (see memory notes for why this
 * matters).
 */
function buildBlendedUnderlays(
  map: MapDefinition,
  palette: ResolvedPalette,
): Int32Array[] {
  const perPlane: Int32Array[] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    const tileHsl: (UnderlayHsl | null)[] = new Array(TILES_PER_SIDE * TILES_PER_SIDE).fill(null);
    for (let x = 0; x < TILES_PER_SIDE; x++) {
      for (let z = 0; z < TILES_PER_SIDE; z++) {
        const tile = map.tiles[plane]?.[x]?.[z];
        const id = tile?.underlayId ?? 0;
        if (id === 0) continue;
        const def = palette.underlays.get(id);
        if (!def || def.hueMultiplier === undefined) continue;
        tileHsl[z * TILES_PER_SIDE + x] = {
          hue: def.hue,
          saturation: def.saturation,
          lightness: def.lightness,
          hueMultiplier: def.hueMultiplier,
        };
      }
    }
    perPlane.push(blendUnderlayTiles(tileHsl, TILES_PER_SIDE));
  }
  return perPlane;
}

/** Phase-1 output: resolved data that later phases need but that doesn't depend on the atlas. */
export interface TerrainPlan {
  map: MapDefinition;
  palette: ResolvedPalette;
  heights: number[][][]; // [plane][x][y] in client-space positive-up values
  blendedUnderlays: Int32Array[]; // per-plane packed-HSL grid
  regionX: number;
  regionZ: number;
  buildInfo: { buildId: number; sourceCacheId: number };
}

/** Phase 1: resolve data (palette, heights, blends). No atlas, no geometry yet. */
export async function prepareTerrain(
  cache: RSCache,
  regionX: number,
  regionZ: number,
  buildInfo: { buildId: number; sourceCacheId: number },
): Promise<TerrainPlan> {
  console.log(`[terrain] getMap(${regionX}, ${regionZ})`);
  const map = await cache.getMap(regionX, regionZ);
  if (!map || !map.tiles || !map.tiles[0]) {
    throw new Error(`No map data for region (${regionX}, ${regionZ})`);
  }

  const heights = map.getHeights();
  const palette = await resolvePalette(cache, map);
  console.log(
    `[terrain] ${palette.underlays.size} underlay defs, ${palette.overlays.size} overlay defs`,
  );
  const blendedUnderlays = buildBlendedUnderlays(map, palette);
  return { map, palette, heights, blendedUnderlays, regionX, regionZ, buildInfo };
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
        const overlayId = tile.overlayId ?? 0;
        const hasOverlay = overlayId > 0;
        const underlayId = tile.underlayId ?? 0;
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
    regionId: (regionX << 8) | regionZ,
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
      rawRgb: 0, // not captured by library for overlays; leave as 0
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
