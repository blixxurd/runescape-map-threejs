import { describe, expect, it } from "vitest";
import { importLegacyEdits, type ImportLegacyOptions } from "./importLegacyEdits.js";
import type { Placer, SpawnAtOptions } from "../tools/placerTypes.js";

/**
 * Minimal `Placer` stub — `importLegacyEdits` only ever calls `spawnAt`, so
 * every other member is a no-op/never-called stub. This is a handful of
 * one-line methods, not a reimplementation of `ModelPlacer`, so it doesn't
 * cross the "mocking the whole placer" line the task brief warned about.
 */
function fakePlacer(spawnAt: (opts: SpawnAtOptions) => Promise<{ id: number } | null>): Placer {
  return {
    kind: "object",
    getSceneGroup: () => {
      throw new Error("not used by importLegacyEdits");
    },
    getPlacements: () => [],
    updatePose: () => {
      throw new Error("not used by importLegacyEdits");
    },
    removeMesh: () => {
      throw new Error("not used by importLegacyEdits");
    },
    duplicate: () => {
      throw new Error("not used by importLegacyEdits");
    },
    spawnAt: spawnAt as Placer["spawnAt"],
    isArmed: () => false,
    cancel: () => {},
  };
}

const TILE_SIZE = 128;

describe("importLegacyEdits", () => {
  it("reconstructs the bbox-center world position, swapping sizeX/sizeY at cardinal rotation 1", async () => {
    const spawnCalls: SpawnAtOptions[] = [];
    const placer = fakePlacer(async (opts) => {
      spawnCalls.push(opts);
      return { id: 1 } as unknown as { id: number };
    });

    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12850,
        removes: [],
        adds: [
          {
            locId: 4421,
            plane: 0,
            tileX: 10,
            tileZ: 5,
            type: 10, // bbox-centered
            rotation: 1, // triggers the sizeX/sizeY swap
            animationOverride: null,
            offsetX: 5,
            offsetZ: -3,
            offsetY: 2,
          },
        ],
      },
      offsetX: 0,
      offsetZ: 0,
      objectPlacer: placer,
      fetchSize: async () => ({ sizeX: 2, sizeY: 1 }),
      sampleTerrainAt: () => 20,
      onRemove: () => {
        throw new Error("no removes in this overlay");
      },
    };

    const result = await importLegacyEdits(opts);
    expect(result).toEqual({ imported: 1, skipped: 0 });
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;

    // rotation 1 on a bbox type swaps sizeX/sizeY (2,1) -> effective (1,2),
    // so the tile footprint used for the bbox-center offset is 1 cell wide
    // (X) and 2 cells deep (Z) — NOT the raw sizeX=2, sizeY=1.
    const bakeBaseX = 10 * TILE_SIZE + (1 * TILE_SIZE) / 2; // cellsX = effSX = sizeY = 1
    const bakeBaseZ = -(5 * TILE_SIZE + (2 * TILE_SIZE) / 2); // cellsY = effSY = sizeX = 2
    expect(call.position.x).toBeCloseTo(bakeBaseX + 5);
    expect(call.position.z).toBeCloseTo(bakeBaseZ - 3);
    expect(call.position.y).toBeCloseTo(20 + 2);
    expect(call.rotationY).toBeCloseTo(-1 * (Math.PI / 2));
    expect(call.plane).toBe(0);

    // Sanity check against the un-swapped math: if the swap were dropped,
    // the recorded offsetX=5 would land on entirely the wrong bbox base
    // (a 2-cell-wide footprint instead of 1), catching exactly the
    // regression the brief calls out.
    const wrongBakeBaseX = 10 * TILE_SIZE + (2 * TILE_SIZE) / 2;
    expect(call.position.x).not.toBeCloseTo(wrongBakeBaseX + 5);
  });

  it("does not swap sizeX/sizeY for non-bbox types even at rotation 1/3", async () => {
    const spawnCalls: SpawnAtOptions[] = [];
    const placer = fakePlacer(async (opts) => {
      spawnCalls.push(opts);
      return { id: 1 } as unknown as { id: number };
    });

    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12850,
        removes: [],
        adds: [
          {
            locId: 100,
            plane: 0,
            tileX: 2,
            tileZ: 3,
            type: 0, // wall — not bbox-centered
            rotation: 3,
            animationOverride: null,
          },
        ],
      },
      offsetX: 0,
      offsetZ: 0,
      objectPlacer: placer,
      fetchSize: async () => ({ sizeX: 5, sizeY: 7 }), // large — would blow up the base if swap/footprint applied
      sampleTerrainAt: () => 0,
      onRemove: () => {},
    };

    await importLegacyEdits(opts);
    const call = spawnCalls[0]!;
    // Non-bbox types always use a 1x1 cell footprint regardless of sizeX/sizeY.
    expect(call.position.x).toBeCloseTo(2 * TILE_SIZE + TILE_SIZE / 2);
    expect(call.position.z).toBeCloseTo(-(3 * TILE_SIZE + TILE_SIZE / 2));
    expect(call.rotationY).toBeCloseTo(-3 * (Math.PI / 2));
  });

  it("adds the region's live world offset on top of the region-local bake base", async () => {
    const spawnCalls: SpawnAtOptions[] = [];
    const sampleCalls: Array<[number, number, number | undefined]> = [];
    const placer = fakePlacer(async (opts) => {
      spawnCalls.push(opts);
      return { id: 1 } as unknown as { id: number };
    });

    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12851,
        removes: [],
        adds: [
          {
            locId: 200,
            plane: 0,
            tileX: 0,
            tileZ: 0,
            type: 22,
            rotation: 0,
            animationOverride: null,
          },
        ],
      },
      offsetX: 8064,
      offsetZ: -8064,
      objectPlacer: placer,
      fetchSize: async () => ({ sizeX: 1, sizeY: 1 }),
      sampleTerrainAt: (x, z, plane) => {
        sampleCalls.push([x, z, plane]);
        return 5;
      },
      onRemove: () => {},
    };

    await importLegacyEdits(opts);
    const call = spawnCalls[0]!;
    expect(call.position.x).toBeCloseTo(8064 + TILE_SIZE / 2);
    expect(call.position.z).toBeCloseTo(-8064 - TILE_SIZE / 2);
    // The terrain sample must be taken in WORLD space (region offset
    // applied), not region-local space — otherwise a non-center region's
    // Y would be sampled from the wrong tile entirely.
    expect(sampleCalls[0]).toEqual([8064 + TILE_SIZE / 2, -8064 - TILE_SIZE / 2, 0]);
  });

  it("counts a placement as skipped when the terrain sample misses", async () => {
    const placer = fakePlacer(async () => ({ id: 1 }));
    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12850,
        removes: [],
        adds: [
          {
            locId: 1,
            plane: 0,
            tileX: 0,
            tileZ: 0,
            type: 10,
            rotation: 0,
            animationOverride: null,
          },
        ],
      },
      offsetX: 0,
      offsetZ: 0,
      objectPlacer: placer,
      fetchSize: async () => ({ sizeX: 1, sizeY: 1 }),
      sampleTerrainAt: () => null,
      onRemove: () => {},
    };

    const result = await importLegacyEdits(opts);
    expect(result).toEqual({ imported: 0, skipped: 1 });
  });

  it("counts a placement as skipped — never a guessed 1x1 fallback — when the size fetch fails", async () => {
    const spawnCalls: SpawnAtOptions[] = [];
    const placer = fakePlacer(async (opts) => {
      spawnCalls.push(opts);
      return { id: 1 };
    });
    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12850,
        removes: [],
        adds: [
          {
            // A bbox type with a true footprint bigger than 1x1: if a
            // failed fetch silently fell back to sizeX=1, sizeY=1, this
            // would still spawn — half a tile off from where the 2x1
            // footprint should have put it — and count as imported.
            locId: 4421,
            plane: 0,
            tileX: 30,
            tileZ: 20,
            type: 10,
            rotation: 1,
            animationOverride: null,
            offsetX: 48.73807545606678,
            offsetZ: 6.92620781125197,
          },
        ],
      },
      offsetX: 0,
      offsetZ: 0,
      objectPlacer: placer,
      fetchSize: async () => {
        throw new Error("HTTP 500");
      },
      sampleTerrainAt: () => 20,
      onRemove: () => {},
    };

    const result = await importLegacyEdits(opts);
    expect(result).toEqual({ imported: 0, skipped: 1 });
    // The placer must never have been asked to spawn anything for this
    // add — a mispositioned-but-still-placed loc is exactly what the
    // "never silently mispositioned" constraint rules out.
    expect(spawnCalls).toHaveLength(0);
  });

  it("forwards every legacy remove to onRemove before processing adds", async () => {
    const removed: Array<[number, string]> = [];
    const placer = fakePlacer(async () => ({ id: 1 }));
    const opts: ImportLegacyOptions = {
      overlay: {
        regionId: 12850,
        removes: ["0320dfb1", "04dfd9bd"],
        adds: [],
      },
      offsetX: 0,
      offsetZ: 0,
      objectPlacer: placer,
      fetchSize: async () => ({ sizeX: 1, sizeY: 1 }),
      sampleTerrainAt: () => 0,
      onRemove: (regionId, hex) => removed.push([regionId, hex]),
    };

    const result = await importLegacyEdits(opts);
    expect(result).toEqual({ imported: 0, skipped: 0 });
    expect(removed).toEqual([
      [12850, "0320dfb1"],
      [12850, "04dfd9bd"],
    ]);
  });
});
