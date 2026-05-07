import * as THREE from "three";
import type { LocsManifest, LocPlacement } from "@rsmap/shared";

/**
 * Shared resolver for raycast hits on baked-loc meshes (both the
 * `InstancedMesh` and merged-`Mesh` flavours emitted by `placeLocs`). The
 * eyedropper and selection both need to walk a hit back to its source
 * placement; centralising the lookup here keeps the two callers from
 * drifting and is the single place that knows about the userData layout.
 */
export interface LocHit {
  /** The mesh that was hit (Mesh or InstancedMesh). */
  mesh: THREE.Object3D;
  /** Index into `LocsManifest.placements`. */
  placementIdx: number;
  placement: LocPlacement;
  /** Loc id of the placement's resolved block. */
  locId: number;
  /** 8-char lowercase hex placement ID. `null` when the bundle has no
   *  placementIds blob (legacy / empty regions). Selection can still
   *  outline the hit; only commit-edit removes need the hex form. */
  placementIdHex: string | null;
  /** Filled for InstancedMesh hits, null for merged-mesh hits. The Delete
   *  path uses this to zero-scale a single instance's matrix. */
  instanceId: number | null;
  /** True when multiple placements of the same (block, plane) share the
   *  hit InstancedMesh — the inspector surfaces this so the user knows
   *  the cyan outline is highlighting *all* identical placements. */
  instancedSiblingCount: number;
}

interface LocMeshUserData {
  placementIdxs?: number[];
  placementByTri?: Uint32Array;
  placementIds?: Uint32Array;
}

export function resolveLocHit(
  hit: THREE.Intersection,
  manifest: LocsManifest,
): LocHit | null {
  const obj = hit.object;
  const ud = obj.userData as LocMeshUserData;

  let placementIdx: number | undefined;
  let instanceId: number | null = null;
  let instancedSiblingCount = 1;

  // InstancedMesh path: `placementIdxs[hit.instanceId]` → manifest index.
  if (ud.placementIdxs && hit.instanceId !== undefined && hit.instanceId !== null) {
    placementIdx = ud.placementIdxs[hit.instanceId];
    instanceId = hit.instanceId;
    instancedSiblingCount = ud.placementIdxs.length;
  } else if (
    ud.placementByTri &&
    hit.faceIndex !== undefined &&
    hit.faceIndex !== null
  ) {
    // Merged-mesh path: `placementByTri[faceIndex]` → manifest index.
    placementIdx = ud.placementByTri[hit.faceIndex];
  }
  if (placementIdx === undefined) return null;

  const placement = manifest.placements[placementIdx];
  if (!placement) return null;
  const block = manifest.blocks[placement.blockIndex];
  if (!block) return null;

  let placementIdHex: string | null = null;
  if (ud.placementIds && placementIdx < ud.placementIds.length) {
    placementIdHex = ud.placementIds[placementIdx]!.toString(16).padStart(8, "0");
  }

  return {
    mesh: obj,
    placementIdx,
    placement,
    locId: block.locId,
    placementIdHex,
    instanceId,
    instancedSiblingCount,
  };
}
