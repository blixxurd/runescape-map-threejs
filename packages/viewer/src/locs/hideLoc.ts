import * as THREE from "three";

/**
 * Hiding baked locs at runtime, plus the index that lets a save find them.
 *
 * Two mesh shapes come out of `placeLocs`: repeated locs live as slots in
 * an `InstancedMesh`, singleton locs are merged into one big `Mesh` per
 * plane. Hiding differs per shape, so both helpers live here and both
 * selection (interactive delete) and the save store (apply on load) use
 * them.
 *
 * Neither helper is reversible on its own — restoring a hidden loc means
 * reloading the region, which is cheap because bundles on disk are always
 * vanilla.
 */

/** Y depth to sink hidden geometry to. Far below any terrain, so a
 *  degenerate triangle can never poke back into view. */
export const SUNK_Y = -100000;

/** Zero-scale a single InstancedMesh slot and sink it underground. The
 *  slot stays allocated; the per-instance matrix is degenerate so the
 *  fragment shader produces no output and raycasts find no hit. */
export function hideInstancedSlot(inst: THREE.InstancedMesh, instanceId: number): void {
  const m = new THREE.Matrix4();
  m.makeScale(0, 0, 0);
  m.setPosition(0, SUNK_Y, 0);
  inst.setMatrixAt(instanceId, m);
  inst.instanceMatrix.needsUpdate = true;
}

/** Collapse every triangle owned by `placementIdx` in a merged-loc Mesh's
 *  position buffer to a single point at SUNK_Y. The merged buffer is
 *  owned by this mesh alone (`placeLocs` mints a fresh Float32Array) so
 *  in-place mutation doesn't affect any other placement. */
export function hideMergedTriangles(mesh: THREE.Mesh, placementIdx: number): void {
  const placementByTri = (mesh.userData as { placementByTri?: Uint32Array })
    .placementByTri;
  if (!placementByTri) return;
  const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  for (let t = 0; t < placementByTri.length; t++) {
    if (placementByTri[t] !== placementIdx) continue;
    // Each triangle = 3 vertices = 9 floats. Collapse all three vertices
    // to (0, SUNK_Y, 0) — degenerate zero-area, no rasterised fragments.
    const off = t * 9;
    positions[off + 0] = 0; positions[off + 1] = SUNK_Y; positions[off + 2] = 0;
    positions[off + 3] = 0; positions[off + 4] = SUNK_Y; positions[off + 5] = 0;
    positions[off + 6] = 0; positions[off + 7] = SUNK_Y; positions[off + 8] = 0;
  }
  posAttr.needsUpdate = true;
}

/** Where a given baked placement lives in the scene. `instanceId` is null
 *  for merged (singleton) placements. */
export interface PlacementSlot {
  mesh: THREE.Mesh;
  instanceId: number | null;
  placementIdx: number;
}

/** Map every baked placement in a region's locs group by its 8-char hex
 *  placement id, so a save's `removes` list can be applied without
 *  raycasting. Built once per region load.
 *
 *  Bundles predating the `placementIds` blob yield an empty index — the
 *  caller warns; there's nothing to key on. */
export function buildPlacementIndex(locsGroup: THREE.Object3D): Map<string, PlacementSlot> {
  const index = new Map<string, PlacementSlot>();
  locsGroup.traverse((obj) => {
    const ud = obj.userData as {
      placementIds?: Uint32Array;
      placementIdxs?: number[];
      placementByTri?: Uint32Array;
    };
    const ids = ud.placementIds;
    if (!ids || ids.length === 0) return;
    const hex = (placementIdx: number): string =>
      ids[placementIdx]!.toString(16).padStart(8, "0");

    if (obj instanceof THREE.InstancedMesh && ud.placementIdxs) {
      for (let instanceId = 0; instanceId < ud.placementIdxs.length; instanceId++) {
        const placementIdx = ud.placementIdxs[instanceId]!;
        index.set(hex(placementIdx), { mesh: obj, instanceId, placementIdx });
      }
      return;
    }
    if (obj instanceof THREE.Mesh && ud.placementByTri) {
      // One entry per distinct placement, not per triangle.
      let last = -1;
      for (const placementIdx of ud.placementByTri) {
        if (placementIdx === last) continue;
        last = placementIdx;
        index.set(hex(placementIdx), { mesh: obj, instanceId: null, placementIdx });
      }
    }
  });
  return index;
}

/** Hide whatever a `PlacementSlot` points at, whichever shape it is. */
export function hideSlot(slot: PlacementSlot): void {
  if (slot.mesh instanceof THREE.InstancedMesh && slot.instanceId !== null) {
    hideInstancedSlot(slot.mesh, slot.instanceId);
  } else {
    hideMergedTriangles(slot.mesh, slot.placementIdx);
  }
}
