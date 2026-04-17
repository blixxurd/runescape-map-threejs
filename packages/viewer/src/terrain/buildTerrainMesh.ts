import * as THREE from "three";
import type { TerrainMeta } from "@rsmap/shared";

/**
 * Build one Three.js mesh per plane from the baked triangle soup. The
 * extractor already did the hard work (shape subdivision, HSL → RGB,
 * Y-flip), so this is a straight upload.
 *
 * Non-indexed geometry: `position` and `color` arrays are already in
 * triangle-soup order. We let `computeVertexNormals` infer per-face
 * normals from positions (flat shading via face normals is what we want
 * for a faceted RS look).
 */
export function buildTerrainMeshes(
  meta: TerrainMeta,
  positions: Float32Array,
  colors: Uint8Array,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `terrain:${meta.regionId}`;

  for (const range of meta.planeRanges) {
    if (range.vertexCount === 0) continue;

    // Slice per-plane view into the shared buffers (no copy — subarray).
    const posStart = range.positionsByteOffset / 4;
    const posEnd = posStart + range.vertexCount * 3;
    const colStart = range.colorsByteOffset;
    const colEnd = colStart + range.vertexCount * 4;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(positions.subarray(posStart, posEnd), 3),
    );
    geom.setAttribute(
      "color",
      new THREE.BufferAttribute(colors.subarray(colStart, colEnd), 4, true),
    );
    // No computeVertexNormals — lighting is pre-baked into the vertex
    // colors by the extractor (OSRS-style per-vertex slope shading). Using
    // MeshBasicMaterial avoids double-shading from the scene lights.

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });
    // Alpha channel is always 255; drop vertex alpha so it doesn't interact
    // with material opacity.
    mat.transparent = false;

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `terrain:plane${range.plane}`;
    mesh.visible = range.plane === 0; // M1 shows plane 0 only
    group.add(mesh);
  }
  return group;
}
