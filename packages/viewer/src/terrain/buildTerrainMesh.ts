import * as THREE from "three";
import type { TerrainMeta } from "@rsmap/shared";

/**
 * Build one Three.js mesh per plane. Vertex positions, colors, UVs, and the
 * shared overlay atlas are all ready to upload as-is — the extractor already
 * did shape subdivision, HSL-to-RGB + slope-baked lighting, and Y/Z handling.
 *
 * Material setup: `MeshBasicMaterial` with `map` = atlas + `vertexColors: true`.
 * Three.js multiplies the sampled atlas texel by the vertex color. Textured
 * overlay triangles sample their texture from the atlas; untextured triangles
 * (underlay + flat-colored overlays) point at a white cell so the vertex
 * color drives the full color.
 */
export function buildTerrainMeshes(
  meta: TerrainMeta,
  positions: Float32Array,
  colors: Uint8Array,
  uvs: Float32Array,
  atlasTexture: THREE.Texture,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `terrain:${meta.regionId}`;

  for (const range of meta.planeRanges) {
    if (range.vertexCount === 0) continue;

    const posStart = range.positionsByteOffset / 4;
    const posEnd = posStart + range.vertexCount * 3;
    const colStart = range.colorsByteOffset;
    const colEnd = colStart + range.vertexCount * 4;
    const uvStart = range.uvsByteOffset / 4;
    const uvEnd = uvStart + range.vertexCount * 2;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.BufferAttribute(positions.subarray(posStart, posEnd), 3),
    );
    geom.setAttribute(
      "color",
      new THREE.BufferAttribute(colors.subarray(colStart, colEnd), 4, true),
    );
    geom.setAttribute("uv", new THREE.BufferAttribute(uvs.subarray(uvStart, uvEnd), 2));

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      map: atlasTexture,
      side: THREE.FrontSide,
    });
    mat.transparent = false;

    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `terrain:plane${range.plane}`;
    // Visibility is controlled by the viewer's current "plane cap" —
    // OSRS's roof-removal convention, where every plane <= cap is shown.
    mesh.userData.plane = range.plane;
    // Default: bridges visible, upper roofs hidden. main.ts can change
    // this via setPlaneCap.
    mesh.visible = range.plane <= 1;
    group.add(mesh);
  }
  return group;
}
