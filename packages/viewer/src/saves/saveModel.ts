import { REGION_SPAN, packRegionId, unpackRegionId } from "@rsmap/shared";

/**
 * Pure coordinate helpers shared by the save store and its tests. No
 * Three.js, no DOM, no fetch — everything here is a plain function over
 * numbers so the interesting math is unit-testable.
 *
 * Region-local coordinates are world coordinates minus the region's own
 * origin offset. Because that offset depends on which region the viewer
 * centred on, a save must store LOCAL coords: the same file then loads
 * identically whether you arrived from the north or the west.
 */

export interface RegionOrigin {
  offsetX: number;
  offsetZ: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** World-space offset applied to a region's groups. Mirrors `setupRegion`
 *  in `main.ts` exactly — cache +Y (north) maps to world −Z. */
export function regionOriginFor(
  regionId: number,
  centerRegionX: number,
  centerRegionZ: number,
): RegionOrigin {
  const { regionX, regionZ } = unpackRegionId(regionId);
  return {
    offsetX: 0 + (regionX - centerRegionX) * REGION_SPAN,
    offsetZ: 0 + -(regionZ - centerRegionZ) * REGION_SPAN,
  };
}

/** Which region owns this world position? Returns null outside the
 *  256×256 cache grid. Same region-attribution math `main.ts` uses when
 *  streaming regions in around the camera, minus the tile subdivision. */
export function worldToRegionId(
  worldX: number,
  worldZ: number,
  centerRegionX: number,
  centerRegionZ: number,
): number | null {
  const dRx = Math.floor(worldX / REGION_SPAN);
  const dRz = Math.floor(-worldZ / REGION_SPAN);
  const rx = centerRegionX + dRx;
  const rz = centerRegionZ + dRz;
  if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) return null;
  return packRegionId(rx, rz);
}

export function worldToRegionLocal(world: Vec3Like, origin: RegionOrigin): Vec3Like {
  return {
    x: world.x - origin.offsetX,
    y: world.y,
    z: world.z - origin.offsetZ,
  };
}

export function regionLocalToWorld(local: Vec3Like, origin: RegionOrigin): Vec3Like {
  return {
    x: local.x + origin.offsetX,
    y: local.y,
    z: local.z + origin.offsetZ,
  };
}
