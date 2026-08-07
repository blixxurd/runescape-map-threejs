import { TILE_SIZE } from "@rsmap/shared";
import type { Placer } from "../tools/placerTypes.js";

/**
 * THROWAWAY. Converts the pre-saves `packages/extractor/edits/<id>.json`
 * overlay into live placements so it can be saved as a named map. Delete
 * this file once the conversion is committed — keeping it would mean
 * keeping the bbox-base inverse below alive forever, which is exactly what
 * the saves redesign retires.
 *
 * The old format stored `tileX/tileZ` plus offsets measured against the
 * position `placeLocs` produces AFTER a re-bake. Reconstructing a world
 * position therefore means redoing the bake prediction and adding the
 * recorded offset:
 *
 *   bakeBaseX = tileX * TILE_SIZE + (offsetCellsX * TILE_SIZE) / 2
 *   bakeBaseZ = -(tileZ * TILE_SIZE + (offsetCellsY * TILE_SIZE) / 2)
 *   worldX    = offsetX(region) + bakeBaseX + (offsetX(add) ?? 0)
 *   worldZ    = offsetZ(region) + bakeBaseZ + (offsetZ(add) ?? 0)
 *   worldY    = terrainY(bakeBaseX + offsetX(region), bakeBaseZ + offsetZ(region), plane)
 *               + (offsetY ?? 0)
 *
 * where offsetCells is the loc's tile footprint for bbox-centered types
 * (10, 11) and 1 otherwise — with sizeX/sizeY SWAPPED when the cardinal
 * rotation is 1 or 3. `bakeBaseX/Z` are region-local (the old overlay
 * format predates the multi-region grid, back when the edited region
 * always sat at world origin); the region's live `offsetX/offsetZ` (from
 * `main.ts`'s `regions` map) convert that into the current world frame.
 *
 * This is the exact inverse of `subOffsetForTile` + `decomposeRotation`,
 * both deleted from `main.ts` in Task 7 (see git history at b8f5774,
 * around lines 782-873).
 *
 * World rotation is the inverse of `decomposeRotation`: cardinal R means
 * world angle −R × π/2, plus the stored residual `rotationY`.
 */

interface LegacyAdd {
  locId: number;
  plane: number;
  tileX: number;
  tileZ: number;
  type: number;
  rotation: number;
  animationOverride: number | null;
  offsetX?: number;
  offsetZ?: number;
  offsetY?: number;
  rotationY?: number;
}

interface LegacyOverlay {
  regionId: number;
  removes: string[];
  adds: LegacyAdd[];
}

export interface ImportLegacyOptions {
  /** Fetched JSON of the old overlay file. */
  overlay: LegacyOverlay;
  /** Region offsets for the overlay's region, from the loaded region. */
  offsetX: number;
  offsetZ: number;
  objectPlacer: Placer;
  /** Object footprint lookup — `/api/object/:id` returns sizeX/sizeY. A
   *  rejection is treated as a hard skip for that add (never a guessed
   *  1x1 fallback) — see the skip path in the main loop below for why. */
  fetchSize: (locId: number) => Promise<{ sizeX: number; sizeY: number }>;
  sampleTerrainAt: (worldX: number, worldZ: number, plane?: number) => number | null;
  onRemove: (regionId: number, placementIdHex: string) => void;
}

/** Reconstruct the world-space position `placeLocs` would have baked for a
 *  single legacy add, mirroring `subOffsetForTile`'s bbox-base math in
 *  reverse (including the sizeX/sizeY swap on cardinal rotation 1/3). */
function resolveBakeBase(
  add: LegacyAdd,
  sizeX: number,
  sizeY: number,
): { bakeBaseX: number; bakeBaseZ: number } {
  const isBoundingBoxed = add.type === 10 || add.type === 11;
  const swap = isBoundingBoxed && (add.rotation === 1 || add.rotation === 3);
  const effSX = swap ? sizeY : sizeX;
  const effSY = swap ? sizeX : sizeY;
  const cellsX = isBoundingBoxed ? effSX : 1;
  const cellsY = isBoundingBoxed ? effSY : 1;
  const bakeBaseX = add.tileX * TILE_SIZE + (cellsX * TILE_SIZE) / 2;
  const bakeBaseZ = -(add.tileZ * TILE_SIZE + (cellsY * TILE_SIZE) / 2);
  return { bakeBaseX, bakeBaseZ };
}

export async function importLegacyEdits(
  opts: ImportLegacyOptions,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const hex of opts.overlay.removes) opts.onRemove(opts.overlay.regionId, hex);

  for (const add of opts.overlay.adds) {
    // A failed size fetch must NOT fall back to a guessed 1x1 footprint —
    // for a bbox-centered type (10/11) with a true footprint bigger than
    // 1x1, a wrong footprint shifts `bakeBaseX/Z` by up to half a tile and
    // the placement would still spawn and still count as imported. Skip
    // instead, same as a terrain-sample miss.
    const size = await opts.fetchSize(add.locId).catch((err: unknown) => {
      console.warn(`[legacy] size fetch failed for loc ${add.locId}:`, err);
      return null;
    });
    if (size === null) {
      skipped++;
      continue;
    }
    const { sizeX, sizeY } = size;
    const { bakeBaseX, bakeBaseZ } = resolveBakeBase(add, sizeX, sizeY);

    const worldX = opts.offsetX + bakeBaseX + (add.offsetX ?? 0);
    const worldZ = opts.offsetZ + bakeBaseZ + (add.offsetZ ?? 0);
    const terrainY = opts.sampleTerrainAt(
      opts.offsetX + bakeBaseX,
      opts.offsetZ + bakeBaseZ,
      add.plane,
    );
    if (terrainY === null) {
      console.warn(`[legacy] no terrain under loc ${add.locId} at ${add.tileX},${add.tileZ}`);
      skipped++;
      continue;
    }
    const worldY = terrainY + (add.offsetY ?? 0);
    const rotationY = -add.rotation * (Math.PI / 2) + (add.rotationY ?? 0);

    const mesh = await opts.objectPlacer.spawnAt({
      id: add.locId,
      position: { x: worldX, y: worldY, z: worldZ },
      rotationY,
      plane: add.plane,
      animationOverride: add.animationOverride ?? undefined,
      notify: true, // let the normal spawn hook track it into the store
    });
    if (mesh) imported++;
    else skipped++;
  }

  return { imported, skipped };
}
