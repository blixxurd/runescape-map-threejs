import * as THREE from "three";
import type { LocsManifest, TerrainMeta } from "@rsmap/shared";
import { TILE_SIZE, VERTICES_PER_SIDE } from "@rsmap/shared";

/**
 * Build an InstancedMesh per (locId, type) block and scatter placements
 * across them. One draw call per block — cheap even for a couple thousand
 * locs on a single 64×64 region.
 *
 * Loc world position = (tileX * 128 + 64, sampledHeight, tileZ * 128 + 64).
 * The +64 centers the loc on its tile. Wall loc types (0–3) should really
 * sit on a tile edge rather than its center, but for M1 the centered
 * placement gets the scene in roughly the right shape — a later pass will
 * branch on `type` and apply the wall/edge offset table.
 */
export function placeLocs(
  manifest: LocsManifest,
  positions: Float32Array,
  colors: Uint8Array,
  uvs: Float32Array,
  terrainMeta: TerrainMeta,
  terrainHeights: Int16Array,
  atlasTexture: THREE.Texture,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `locs:${terrainMeta.regionId}`;
  if (manifest.placements.length === 0) return group;

  // Build one BufferGeometry per block (shared by every instance of that block).
  const geometries: THREE.BufferGeometry[] = manifest.blocks.map((block) => {
    const posStart = block.positionsByteOffset / 4;
    const posEnd = posStart + block.vertexCount * 3;
    const colStart = block.colorsByteOffset;
    const colEnd = colStart + block.vertexCount * 4;
    const uvStart = block.uvsByteOffset / 4;
    const uvEnd = uvStart + block.vertexCount * 2;

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
    geom.computeVertexNormals();
    return geom;
  });

  // MeshBasicMaterial (no scene lighting) because the extractor pre-bakes
  // per-face lighting into the vertex colors, matching the OSRS client's
  // runtime pipeline (texture × pre-lit vertex color, no shader lights).
  // Using MeshStandardMaterial here would double-darken textured walls.
  // DoubleSide covers the inconsistent face winding in loc models.
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    map: atlasTexture,
    side: THREE.DoubleSide,
  });

  // Bucket placements by block.
  const perBlock: number[][] = manifest.blocks.map(() => []);
  for (let i = 0; i < manifest.placements.length; i++) {
    const p = manifest.placements[i]!;
    perBlock[p.blockIndex]!.push(i);
  }

  // Rotation is baked into block geometry by the extractor (OSRS rotations
  // above 3 imply non-rotational transforms we can't express here). Instance
  // matrices are pure translations.
  const tmpMatrix = new THREE.Matrix4();

  const heightAt = (plane: number, tileX: number, tileZ: number): number => {
    // heights are stored at grid corners (65×65 per plane). Use the center
    // of the tile by averaging the 4 corners; cheaper than re-interpolating.
    const base = plane * VERTICES_PER_SIDE * VERTICES_PER_SIDE;
    const idx = (x: number, z: number): number =>
      base + z * VERTICES_PER_SIDE + x;
    const sw = terrainHeights[idx(tileX, tileZ)] ?? 0;
    const se = terrainHeights[idx(tileX + 1, tileZ)] ?? 0;
    const ne = terrainHeights[idx(tileX + 1, tileZ + 1)] ?? 0;
    const nw = terrainHeights[idx(tileX, tileZ + 1)] ?? 0;
    return (sw + se + ne + nw) / 4;
  };

  for (let b = 0; b < manifest.blocks.length; b++) {
    const idxs = perBlock[b]!;
    if (idxs.length === 0) continue;
    // Pre-filter plane to know the exact instance count — leaving
    // uninitialized slots at identity would pile loc copies at origin.
    const onPlane = idxs.filter((i) => manifest.placements[i]!.plane === 0);
    if (onPlane.length === 0) continue;

    const block = manifest.blocks[b]!;
    const geom = geometries[b]!;
    const inst = new THREE.InstancedMesh(geom, mat, onPlane.length);
    inst.name = `loc:${block.locId}:${block.modelType}:${block.bakedRotation}`;
    // Used by the debug inspector to map a raycast `instanceId` back to a
    // concrete placement.
    inst.userData.blockIndex = b;
    inst.userData.placementIdxs = onPlane;

    for (let i = 0; i < onPlane.length; i++) {
      const p = manifest.placements[onPlane[i]!]!;
      // +Z = south convention: the cache's tileY increases northward, so
      // we negate to put north at −Z in world space.
      const wx = p.x * TILE_SIZE + TILE_SIZE / 2;
      const wz = -(p.z * TILE_SIZE + TILE_SIZE / 2);
      const wy = heightAt(p.plane, p.x, p.z);
      tmpMatrix.makeTranslation(wx, wy, wz);
      inst.setMatrixAt(i, tmpMatrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  return group;
}
