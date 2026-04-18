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
  // Transparent blending honors the per-vertex alpha extractor emits from
  // `faceAlphas`.
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    map: atlasTexture,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.01,
  });

  // Bucket placements by (block, plane) so we can toggle plane visibility
  // at runtime via the OSRS roof-removal camera convention.
  const perBlockPlane: number[][][] = manifest.blocks.map(() => [[], [], [], []]);
  for (let i = 0; i < manifest.placements.length; i++) {
    const p = manifest.placements[i]!;
    const planeBuckets = perBlockPlane[p.blockIndex]!;
    if (p.plane >= 0 && p.plane < 4) planeBuckets[p.plane]!.push(i);
  }

  // One Group per plane so `planeGroup.visible = true/false` toggles every
  // InstancedMesh on that plane at once. The inspector resolves instance
  // ids the same as before; all the `userData` still lives on the meshes.
  const planeGroups: THREE.Group[] = [0, 1, 2, 3].map((plane) => {
    const g = new THREE.Group();
    g.name = `locs:plane${plane}`;
    g.userData.plane = plane;
    // Match terrain default: planes 0 and 1 visible, 2–3 hidden.
    g.visible = plane <= 1;
    return g;
  });
  for (const g of planeGroups) group.add(g);

  // Rotation is baked into block geometry by the extractor (OSRS rotations
  // above 3 imply non-rotational transforms we can't express here). Instance
  // matrices are pure translations.
  const tmpMatrix = new THREE.Matrix4();

  // Wall-decoration displacement LUTs. Indexed by the block's bakedRotation & 3.
  // Source: `SceneBuilder.displacementX/Y` + `diagonalDisplacementX/Y` in
  // rs-map-viewer. The Z axis is negated (our world +Z = south, cache +Y = north).
  const CARDINAL_DX = [1, 0, -1, 0];
  const CARDINAL_DZ = [0, 1, 0, -1];
  const DIAG_DX = [1, -1, -1, 1];
  const DIAG_DZ = [1, 1, -1, -1];

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
    const block = manifest.blocks[b]!;
    const geom = geometries[b]!;
    const planeBuckets = perBlockPlane[b]!;

    for (let plane = 0; plane < 4; plane++) {
      const onPlane = planeBuckets[plane]!;
      if (onPlane.length === 0) continue;

      const inst = new THREE.InstancedMesh(geom, mat, onPlane.length);
      inst.name = `loc:${block.locId}:${block.modelType}:${block.bakedRotation}:p${plane}`;
      inst.userData.blockIndex = b;
      inst.userData.placementIdxs = onPlane;

      for (let i = 0; i < onPlane.length; i++) {
        const p = manifest.placements[onPlane[i]!]!;
        const isBoundingBoxed = p.origType === 10 || p.origType === 11;
        let sizeX = block.sizeX ?? 1;
        let sizeY = block.sizeY ?? 1;
        if (isBoundingBoxed && (p.origRotation === 1 || p.origRotation === 3)) {
          const t = sizeX; sizeX = sizeY; sizeY = t;
        }
        const offsetCellsX = isBoundingBoxed ? sizeX : 1;
        const offsetCellsZ = isBoundingBoxed ? sizeY : 1;
        let wx = p.x * TILE_SIZE + (offsetCellsX * TILE_SIZE) / 2;
        let wz = -(p.z * TILE_SIZE + (offsetCellsZ * TILE_SIZE) / 2);

        // Wall decorations — OUTSIDE (5), DIAGONAL_OUTSIDE (6), DIAGONAL_DOUBLE (8) —
        // nudge toward the wall they attach to. Displacement magnitude is
        // `LocType.DEFAULT_DECOR_DISPLACEMENT = 16` (half-wall-thickness).
        // Diagonal variants use half that (8). INSIDE (4) and DIAGONAL_INSIDE
        // (7) sit at the tile's conceptual "inside" and don't displace.
        // Direction arrays match SceneBuilder.displacementX/Y and
        // diagonalDisplacementX/Y, negated on Z to go from cache +Y=north
        // to world +Z=south.
        if (p.origType === 5 || p.origType === 6 || p.origType === 8) {
          const cardinal = p.origType === 5;
          const disp = cardinal ? 16 : 8;
          const baseRot = block.bakedRotation & 3;
          const dx = cardinal ? CARDINAL_DX[baseRot]! : DIAG_DX[baseRot]!;
          const dz = cardinal ? CARDINAL_DZ[baseRot]! : DIAG_DZ[baseRot]!;
          wx += disp * dx;
          wz += disp * dz;
        }

        const wy = heightAt(p.plane, p.x, p.z);
        tmpMatrix.makeTranslation(wx, wy, wz);
        inst.setMatrixAt(i, tmpMatrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      planeGroups[plane]!.add(inst);
    }
  }

  return group;
}
