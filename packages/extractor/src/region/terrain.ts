import type { RSCache, MapDefinition, UnderlayDefinition, OverlayDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  blendUnderlayCorner,
  hsl16ToRgb,
  unpackHue,
  unpackSaturation,
  unpackLuminance,
  type UnderlayHsl,
} from "../color/hsl.js";
import { computeVertexLights, shadeRgb, LIGHT_BASE } from "../color/terrainLight.js";
import { emitTileTriangles, type CornerColors, type CornerHeights } from "../tables/tileShapes.js";
import type { TerrainMeta } from "@rsmap/shared";
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
    // OSRS stores underlays with id = opcode - 81; the archive index is id - 1
    // (opcode 82 = underlay id 1 = archive file 0).
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
 * Pre-compute HSL-blended underlay color at every tile-grid corner on every
 * plane. Returns a flat (PLANES × VERTICES_PER_SIDE × VERTICES_PER_SIDE) array
 * of either `null` (no underlay touches this corner) or an rgb tuple.
 */
function buildCornerUnderlayColors(
  map: MapDefinition,
  palette: ResolvedPalette,
): Array<[number, number, number] | null> {
  const corners = new Array<[number, number, number] | null>(
    PLANES * VERTICES_PER_SIDE * VERTICES_PER_SIDE,
  );

  // For each plane, build a per-tile HSL array first.
  for (let plane = 0; plane < PLANES; plane++) {
    const tileHsl: (UnderlayHsl | null)[] = new Array(TILES_PER_SIDE * TILES_PER_SIDE).fill(null);
    for (let x = 0; x < TILES_PER_SIDE; x++) {
      for (let z = 0; z < TILES_PER_SIDE; z++) {
        const tile = map.tiles[plane]?.[x]?.[z];
        const id = tile?.underlayId ?? 0;
        if (id === 0) continue;
        const def = palette.underlays.get(id);
        if (!def) continue;
        // UnderlayLoader stores raw hue/sat/lum in ~0..256 scale, then packs
        // them into a 16-bit HSL via `packHsl` (stored on def.color). Our
        // blend math expects the packed ranges (hue 0..63, sat 0..7, lum
        // 0..127), so round-trip through the packed value rather than using
        // the raw fields.
        tileHsl[z * TILES_PER_SIDE + x] = {
          hue: unpackHue(def.color),
          saturation: unpackSaturation(def.color),
          lightness: unpackLuminance(def.color),
        };
      }
    }
    // Then blend at each vertex corner using the 4 adjacent tiles.
    const base = plane * VERTICES_PER_SIDE * VERTICES_PER_SIDE;
    for (let vz = 0; vz < VERTICES_PER_SIDE; vz++) {
      for (let vx = 0; vx < VERTICES_PER_SIDE; vx++) {
        corners[base + vz * VERTICES_PER_SIDE + vx] = blendUnderlayCorner(vx, vz, tileHsl, TILES_PER_SIDE);
      }
    }
  }
  return corners;
}

interface BakedTerrain {
  meta: TerrainMeta;
  positions: Float32Array;
  colors: Uint8Array;
  heights: Int16Array;
}

export async function bakeTerrain(
  cache: RSCache,
  regionX: number,
  regionZ: number,
  buildInfo: { buildId: number; sourceCacheId: number },
): Promise<BakedTerrain> {
  console.log(`[terrain] getMap(${regionX}, ${regionZ})`);
  const map = await cache.getMap(regionX, regionZ);
  if (!map || !map.tiles || !map.tiles[0]) {
    throw new Error(`No map data for region (${regionX}, ${regionZ})`);
  }

  const heights = map.getHeights(); // [plane][x][y], world Y units
  console.log(`[terrain] resolving palette`);
  const palette = await resolvePalette(cache, map);
  console.log(
    `[terrain] ${palette.underlays.size} underlay defs, ${palette.overlays.size} overlay defs`,
  );
  const cornerRgb = buildCornerUnderlayColors(map, palette);

  // Accumulate per-plane triangle soup, then merge.
  const perPlane: { positions: number[]; colors: number[] }[] = [];
  for (let plane = 0; plane < PLANES; plane++) {
    const positions: number[] = [];
    const colors: number[] = [];
    const cornerBase = plane * VERTICES_PER_SIDE * VERTICES_PER_SIDE;

    // Per-vertex lighting from this plane's height gradients. We bake the
    // slope-based shading into vertex colors so the extractor can keep
    // emitting a flat-shaded triangle soup and the viewer stays dumb.
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

    const getCornerRgb = (vx: number, vz: number): [number, number, number] | null => {
      const base = cornerRgb[cornerBase + vz * VERTICES_PER_SIDE + vx];
      if (!base) return null;
      return shadeRgb(base, lightAt(vx, vz));
    };

    for (let x = 0; x < TILES_PER_SIDE; x++) {
      for (let z = 0; z < TILES_PER_SIDE; z++) {
        const tile = map.tiles[plane]?.[x]?.[z];
        if (!tile) continue;

        const shape = tile.overlayPath ?? 0;
        const rotation = tile.overlayRotation ?? 0;
        const overlayId = tile.overlayId ?? 0;
        const hasOverlay = overlayId > 0;

        let overlayRgb: [number, number, number] | null = null;
        if (hasOverlay) {
          const odef = palette.overlays.get(overlayId);
          if (odef) {
            // Shade the overlay by the average of the 4 tile-corner lights.
            const tileLight =
              (lightAt(x, z) +
                lightAt(x + 1, z) +
                lightAt(x + 1, z + 1) +
                lightAt(x, z + 1)) >>
              2;
            overlayRgb = shadeRgb(hsl16ToRgb(odef.color), tileLight);
          } else {
            overlayRgb = [200, 60, 180]; // missing-data magenta, easy to spot
          }
        }

        // Heights at the 4 corners. getHeights() returns [plane][x][y].
        const h: CornerHeights = {
          sw: heights[plane]?.[x]?.[z] ?? 0,
          se: heights[plane]?.[x + 1]?.[z] ?? 0,
          ne: heights[plane]?.[x + 1]?.[z + 1] ?? 0,
          nw: heights[plane]?.[x]?.[z + 1] ?? 0,
        };

        const colorsIn: CornerColors = {
          underlaySw: getCornerRgb(x, z),
          underlaySe: getCornerRgb(x + 1, z),
          underlayNe: getCornerRgb(x + 1, z + 1),
          underlayNw: getCornerRgb(x, z + 1),
          overlay: overlayRgb,
        };

        emitTileTriangles(x, z, shape, rotation, h, colorsIn, {
          positions,
          colors,
        });
      }
    }
    perPlane.push({ positions, colors });
    console.log(
      `[terrain] plane ${plane}: ${positions.length / 9} triangles, ${colors.length / 4} vertices`,
    );
  }

  // Flatten into contiguous typed arrays + meta.
  let totalVertexCount = 0;
  for (const p of perPlane) totalVertexCount += p.positions.length / 3;

  const positions = new Float32Array(totalVertexCount * 3);
  const colors = new Uint8Array(totalVertexCount * 4);
  const planeRanges: TerrainMeta["planeRanges"] = [];
  let posWrite = 0;
  let colWrite = 0;
  for (let plane = 0; plane < PLANES; plane++) {
    const p = perPlane[plane]!;
    const vCount = p.positions.length / 3;
    planeRanges.push({
      plane,
      vertexCount: vCount,
      positionsByteOffset: posWrite * 4,
      colorsByteOffset: colWrite,
    });
    for (let i = 0; i < p.positions.length; i++) positions[posWrite + i] = p.positions[i]!;
    for (let i = 0; i < p.colors.length; i++) colors[colWrite + i] = p.colors[i]!;
    posWrite += p.positions.length;
    colWrite += p.colors.length;
  }

  // Heights grid (65x65 corners × 4 planes). Stored directly — no Y-flip
  // (see comment in emitTileTriangles for why positive values are already
  // Three.js "up").
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
    schemaVersion: 1,
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
    positionsFile: "terrain.pos.bin",
    colorsFile: "terrain.col.bin",
    heightsFile: "terrain.heights.bin",
    heightsByteLength: heights16.byteLength,
  };

  return { meta, positions, colors, heights: heights16 };
}

export async function writeTerrainBundle(baked: BakedTerrain, outDir: string): Promise<void> {
  await writeFile(join(outDir, baked.meta.positionsFile), Buffer.from(baked.positions.buffer));
  await writeFile(join(outDir, baked.meta.colorsFile), Buffer.from(baked.colors.buffer));
  await writeFile(join(outDir, baked.meta.heightsFile), Buffer.from(baked.heights.buffer));
  await writeFile(join(outDir, "terrain.meta.json"), JSON.stringify(baked.meta, null, 2));
  console.log(
    `[terrain] wrote ${baked.meta.totalVertexCount} vertices (` +
      `${(baked.meta.positionsByteLength / 1024).toFixed(1)} KB positions, ` +
      `${(baked.meta.colorsByteLength / 1024).toFixed(1)} KB colors, ` +
      `${(baked.meta.heightsByteLength / 1024).toFixed(1)} KB heights)`,
  );
}
