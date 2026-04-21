import * as THREE from "three";
import type { LocBlock, LocsManifest, TerrainMeta } from "@rsmap/shared";
import { TILE_SIZE, VERTICES_PER_SIDE, TILES_PER_SIDE } from "@rsmap/shared";

/**
 * Turn a region's loc manifest into scene-graph meshes. Output is bucketed
 * into four per-plane Groups (for `[` / `]` roof-removal toggling).
 *
 * Two flavours of mesh live inside each plane group:
 *
 *   - **Instanced** (`THREE.InstancedMesh`). Used for animated blocks and for
 *     static (block, plane) pairs with at least `MERGE_THRESHOLD` placements.
 *     Geometry is shared; one draw per mesh.
 *   - **Merged** (`THREE.Mesh`). One per plane. All *singleton* static
 *     placements (one instance on that plane) get their block vertices
 *     copied and translated into a giant non-indexed buffer. One draw per
 *     plane — collapses ~2k+ singleton draw calls per region.
 *
 * Why merge singletons? Per region ~85 % of (block, plane) pairs have only
 * one placement — "instancing" those was pure draw-call overhead. Merged
 * mode duplicates vertices instead, which trades CPU RAM (each placement's
 * ~100 verts no longer shares the block buffer) for a 6–8× draw-call drop.
 *
 * Loc world position = (tileX * 128 + 64, sampledHeight, tileZ * 128 + 64).
 * The +64 centers the loc on its tile. Wall loc types (0–3) should really
 * sit on a tile edge rather than its center, but for M1 the centered
 * placement gets the scene in roughly the right shape — a later pass will
 * branch on `type` and apply the wall/edge offset table.
 */
/**
 * Per-block animation state. `placeLocs` returns one of these per animated
 * block so the render loop can advance the frame and swap the geometry's
 * `position` attribute. Static blocks don't produce an entry.
 */
export interface LocAnimationState {
  /** The shared geometry whose `position` attribute gets replaced each tick. */
  geometry: THREE.BufferGeometry;
  /** `frameCount` non-overlapping Float32Array views into the frames blob.
   *  Each view is `vertexCount × 3` floats — ready to drop into the
   *  `position` attribute. */
  framePositions: Float32Array[];
  /** Per-frame duration, in ms (converted from the extractor's 20-ms unit). */
  frameDurationsMs: number[];
  /** Sum of all `frameDurationsMs` — the duration of one full play of
   *  `frames[0..frameCount)`. The animation always plays through this once
   *  before any loop logic kicks in. */
  introDurationMs: number;
  /** First frame in the loop tail — `frameCount - frameStep`, clamped.
   *  Only meaningful when the animation actually loops (`loopDurationMs > 0`). */
  loopStartFrame: number;
  /** Sum of `frameDurationsMs.slice(loopStartFrame)` — duration of one
   *  pass through the loop tail. Zero when the animation is one-shot
   *  (`frameStep <= 0` or out of range). */
  loopDurationMs: number;
  /** Last frame index applied — lets the loop skip the attribute swap when
   *  the current frame hasn't changed. */
  lastFrameApplied: number;
}

export interface PlaceLocsResult {
  group: THREE.Group;
  animated: LocAnimationState[];
}

export function placeLocs(
  manifest: LocsManifest,
  positions: Float32Array,
  colors: Uint8Array,
  uvs: Float32Array,
  framesPositions: Float32Array,
  terrainMeta: TerrainMeta,
  terrainHeights: Int16Array,
  atlasTexture: THREE.Texture,
): PlaceLocsResult {
  const group = new THREE.Group();
  group.name = `locs:${terrainMeta.regionId}`;
  if (manifest.placements.length === 0) return { group, animated: [] };

  const animated: LocAnimationState[] = [];

  // MeshBasicMaterial (no scene lighting) because the extractor pre-bakes
  // per-face lighting into the vertex colors, matching the OSRS client's
  // runtime pipeline (texture × pre-lit vertex color, no shader lights).
  // Using MeshStandardMaterial here would double-darken textured walls.
  // DoubleSide covers the inconsistent face winding in loc models.
  // Transparent blending honors the per-vertex alpha extractor emits from
  // `faceAlphas`.
  //
  // `polygonOffset` biases loc fragments slightly toward the camera so
  // they always win the depth test against terrain. OSRS scenery is
  // intentionally coplanar with the floor (rugs, fallen logs, ladders,
  // signs sitting flush against walls), and on a hardware Z-buffer
  // exact-equal depth is a per-pixel race that flashes during camera
  // motion. The client renders with painter's-algorithm + `faceRenderPriorities`
  // and never sees this; we use polygon offset as the standard decal fix.
  // Negative factor + units pulls fragments toward the near plane.
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    map: atlasTexture,
    side: THREE.DoubleSide,
    transparent: true,
    alphaTest: 0.01,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });

  // Bucket placements by (block, plane). Each `(block, plane)` cell lists
  // the placement indices that share that geometry on that plane — this is
  // the atomic unit for the "instance vs merge" decision below.
  const perBlockPlane: number[][][] = manifest.blocks.map(() => [[], [], [], []]);
  for (let i = 0; i < manifest.placements.length; i++) {
    const p = manifest.placements[i]!;
    const planeBuckets = perBlockPlane[p.blockIndex]!;
    if (p.plane >= 0 && p.plane < 4) planeBuckets[p.plane]!.push(i);
  }

  // A (block, plane) pair goes into the merged per-plane mesh unless it
  // clears this threshold. 2 keeps "a handful of identical trees" as a
  // real instanced draw while collapsing the long tail of one-off props.
  // In practice ~85 % of cells are singletons (see the audit numbers in
  // the doc comment at the top of this file), so this is where the bulk
  // of the draw-call savings come from. Animated blocks always get their
  // own InstancedMesh regardless — the tick loop mutates their position
  // attribute, and that can't work on a merged, translation-baked buffer.
  const INSTANCE_THRESHOLD = 2;

  // One Group per plane so `planeGroup.visible = true/false` toggles every
  // mesh on that plane at once. The plane-cap key handlers in main.ts
  // still look at `child.userData.plane`, which lives on each mesh below.
  const planeGroups: THREE.Group[] = [0, 1, 2, 3].map((plane) => {
    const g = new THREE.Group();
    g.name = `locs:plane${plane}`;
    g.userData.plane = plane;
    // Match terrain default: planes 0 and 1 visible, 2–3 hidden.
    g.visible = plane <= 1;
    return g;
  });
  for (const g of planeGroups) group.add(g);

  // Wall-decoration displacement LUTs. Indexed by the block's bakedRotation & 3.
  // Source: `SceneBuilder.displacementX/Y` + `diagonalDisplacementX/Y` in
  // rs-map-viewer. The Z axis is negated (our world +Z = south, cache +Y = north).
  const CARDINAL_DX = [1, 0, -1, 0];
  const CARDINAL_DZ = [0, 1, 0, -1];
  const DIAG_DX = [1, -1, -1, 1];
  const DIAG_DZ = [1, 1, -1, -1];

  // See the comment on `wy` below for why this exists. In short, OSRS
  // scenery is intentionally coplanar with the surface it stands on
  // (floor decorations, crate bases, wall bases) and a hardware Z-buffer
  // can't decide a winner on coplanar geometry without help.
  const LOC_TERRAIN_LIFT = 1.0;

  /**
   * Bilinear sample of the terrain height grid at an arbitrary client-space
   * (x, z) — not at a tile center. For contoured locs this matches the XZ
   * the extractor uses as the deformation origin (the placement's
   * bounding-box center), so per-vertex deltas line up: `wy = terrain_at_origin`
   * in both places. For 1×1 locs it degenerates to the old 4-corner-average
   * behaviour.
   */
  const sampleTerrain = (plane: number, clientX: number, clientZ: number): number => {
    const tx = Math.max(0, Math.min(TILES_PER_SIDE - 1, Math.floor(clientX / TILE_SIZE)));
    const tz = Math.max(0, Math.min(TILES_PER_SIDE - 1, Math.floor(clientZ / TILE_SIZE)));
    const fx = Math.max(0, Math.min(1, (clientX - tx * TILE_SIZE) / TILE_SIZE));
    const fz = Math.max(0, Math.min(1, (clientZ - tz * TILE_SIZE) / TILE_SIZE));
    const base = plane * VERTICES_PER_SIDE * VERTICES_PER_SIDE;
    const idx = (x: number, z: number): number => base + z * VERTICES_PER_SIDE + x;
    const sw = terrainHeights[idx(tx, tz)] ?? 0;
    const se = terrainHeights[idx(tx + 1, tz)] ?? sw;
    const nw = terrainHeights[idx(tx, tz + 1)] ?? sw;
    const ne = terrainHeights[idx(tx + 1, tz + 1)] ?? sw;
    return sw * (1 - fx) * (1 - fz) + se * fx * (1 - fz) + nw * (1 - fx) * fz + ne * fx * fz;
  };

  /**
   * Compute the world-space translation for a single placement. Same math
   * used for both the instanced and the merged paths — extracted so the
   * two can't drift. Returns (wx, wy, wz) already in world coords.
   */
  const placementWorldPos = (
    placementIdx: number,
    block: LocBlock,
  ): { wx: number; wy: number; wz: number } => {
    const p = manifest.placements[placementIdx]!;
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

    // Placement Y = terrain height at the model's bounding-box center.
    // The client-space Z of that point is `-wz` (world +Z = south is the
    // negation of client +Z = north). Sampling here (not at the base
    // tile's corner-average) matches what the extractor used as the
    // deformation origin for contoured blocks, so per-vertex deltas line
    // up. For non-contoured and 1×1 locs this is identical to the old
    // 4-corner-average.
    //
    // `LOC_TERRAIN_LIFT` lifts every loc a hair above the terrain it
    // sits on. The OSRS client renders with painter's-algorithm + per-
    // face draw priorities, so floor decorations / wall bases / crate
    // bottoms can sit at exactly the terrain Y without flicker. On a
    // hardware Z-buffer that's a coplanar race that flashes during
    // camera motion. 1.0 world unit = 0.78 % of a tile (TILE_SIZE = 128)
    // — well below one screen pixel at any reasonable camera distance.
    // Polygon offset on the loc material is the *correct* fix in
    // theory, but its sub-pixel bias isn't reliable across all GPUs;
    // a real offset always works.
    const wy = sampleTerrain(p.plane, wx, -wz) + LOC_TERRAIN_LIFT;
    return { wx, wy, wz };
  };

  // Decide per (block, plane) whether it becomes an InstancedMesh or folds
  // into the per-plane merged mesh. A block that's instanced on any plane
  // needs its block geometry built; blocks that are *only* singletons
  // everywhere skip the per-block geometry entirely (their verts go
  // straight into the merged buffer).
  interface InstEntry {
    blockIdx: number;
    plane: number;
    placementIdxs: number[];
  }
  const instEntries: InstEntry[] = [];
  const mergedPerPlane: number[][] = [[], [], [], []];
  const blockNeedsGeom = new Array<boolean>(manifest.blocks.length).fill(false);
  for (let b = 0; b < manifest.blocks.length; b++) {
    const block = manifest.blocks[b]!;
    const perPlane = perBlockPlane[b]!;
    for (let plane = 0; plane < 4; plane++) {
      const idxs = perPlane[plane]!;
      if (idxs.length === 0) continue;
      const mustInstance = !!block.animation || idxs.length >= INSTANCE_THRESHOLD;
      if (mustInstance) {
        instEntries.push({ blockIdx: b, plane, placementIdxs: idxs });
        blockNeedsGeom[b] = true;
      } else {
        // singleton placement on this plane — merge
        for (const i of idxs) mergedPerPlane[plane]!.push(i);
      }
    }
  }

  // Build one BufferGeometry per *instanced* block (shared by every
  // InstancedMesh that references it across planes). Animated blocks
  // always land here; static blocks only if they hit INSTANCE_THRESHOLD
  // on any plane.
  const geometries: (THREE.BufferGeometry | null)[] = manifest.blocks.map((block, b) => {
    if (!blockNeedsGeom[b]) return null;
    const posStart = block.positionsByteOffset / 4;
    const posEnd = posStart + block.vertexCount * 3;
    const colStart = block.colorsByteOffset;
    const colEnd = colStart + block.vertexCount * 4;
    const uvStart = block.uvsByteOffset / 4;
    const uvEnd = uvStart + block.vertexCount * 2;

    const geom = new THREE.BufferGeometry();
    // Animated blocks get a *mutable* copy of the position attribute so
    // we can swap its contents each tick without touching the shared
    // bundle buffer. Static blocks share the bundle buffer via
    // `.subarray` — zero copy.
    if (block.animation) {
      const posArr = new Float32Array(block.vertexCount * 3);
      posArr.set(positions.subarray(posStart, posEnd));
      geom.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      // Pre-slice each frame's position view. The frames blob is laid
      // out frame-major: frame 0 then frame 1 then ..., each frame is
      // `vertexCount × 3` floats.
      const vertexComponents = block.vertexCount * 3;
      const frameStart = block.animation.framesByteOffset / 4;
      const framePositions: Float32Array[] = [];
      for (let f = 0; f < block.animation.frameCount; f++) {
        const fs = frameStart + f * vertexComponents;
        framePositions.push(framesPositions.subarray(fs, fs + vertexComponents));
      }
      const frameDurationsMs = block.animation.frameTicks.map((t) => Math.max(1, t) * 20);
      const introDurationMs = frameDurationsMs.reduce((a, b) => a + b, 0);
      // SequenceDefinition.frameStep — interpret per the rs-map-viewer
      // `LocAnimated.update` algorithm:
      //   `frame -= frameStep` on hitting the end. If the result is in
      //   range, that's where the loop continues; otherwise the animation
      //   freezes. So:
      //     frameStep <= 0           → loop never re-engages → one-shot
      //     0 < frameStep < frameCount → tail loop of size frameStep
      //     frameStep >= frameCount  → full loop (back to frame 0)
      // Older bundles without this field default to full loop (the prior
      // behaviour), so animations don't regress when the bundle is stale.
      const frameCount = block.animation.frameCount;
      const frameStep = block.animation.frameStep ?? frameCount;
      let loopStartFrame: number;
      let loopDurationMs: number;
      if (frameStep <= 0) {
        loopStartFrame = frameCount; // sentinel: no loop
        loopDurationMs = 0;
      } else if (frameStep >= frameCount) {
        loopStartFrame = 0;
        loopDurationMs = introDurationMs;
      } else {
        loopStartFrame = frameCount - frameStep;
        loopDurationMs = 0;
        for (let f = loopStartFrame; f < frameCount; f++) {
          loopDurationMs += frameDurationsMs[f]!;
        }
      }
      animated.push({
        geometry: geom,
        framePositions,
        frameDurationsMs,
        introDurationMs,
        loopStartFrame,
        loopDurationMs,
        // -1 forces an explicit copy of framePositions[0] on the first
        // tick. Without this the initial position buffer (a copy of
        // the main bundle positions) would remain even if it disagreed
        // with framePositions[0] for any reason — it shouldn't, but
        // the invariant is cheap to enforce and makes startup
        // defensible.
        lastFrameApplied: -1,
      });
    } else {
      geom.setAttribute(
        "position",
        new THREE.BufferAttribute(positions.subarray(posStart, posEnd), 3),
      );
    }
    geom.setAttribute(
      "color",
      new THREE.BufferAttribute(colors.subarray(colStart, colEnd), 4, true),
    );
    geom.setAttribute("uv", new THREE.BufferAttribute(uvs.subarray(uvStart, uvEnd), 2));
    return geom;
  });

  const tmpMatrix = new THREE.Matrix4();

  // Emit one InstancedMesh per (block, plane) pair that qualified.
  // Instance matrices are translation-only — rotation is pre-baked into
  // the block geometry by the extractor (OSRS rotations above 3 require
  // extra transforms we can't express as a matrix).
  for (const entry of instEntries) {
    const block = manifest.blocks[entry.blockIdx]!;
    const geom = geometries[entry.blockIdx]!;
    const inst = new THREE.InstancedMesh(geom, mat, entry.placementIdxs.length);
    inst.name = `loc:${block.locId}:${block.modelType}:${block.bakedRotation}:p${entry.plane}`;
    inst.userData.blockIndex = entry.blockIdx;
    inst.userData.placementIdxs = entry.placementIdxs;
    for (let i = 0; i < entry.placementIdxs.length; i++) {
      const { wx, wy, wz } = placementWorldPos(entry.placementIdxs[i]!, block);
      tmpMatrix.makeTranslation(wx, wy, wz);
      inst.setMatrixAt(i, tmpMatrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    planeGroups[entry.plane]!.add(inst);
  }

  // Build one merged Mesh per plane from all singleton placements on that
  // plane. Each placement's block vertices get copied into the merged
  // buffers with the world translation baked in; colors and UVs are
  // copied verbatim. `placementByTri` lets the debug inspector resolve a
  // raycast `faceIndex` back to the originating placement.
  for (let plane = 0; plane < 4; plane++) {
    const placementIdxs = mergedPerPlane[plane]!;
    if (placementIdxs.length === 0) continue;

    let totalVerts = 0;
    for (const i of placementIdxs) {
      totalVerts += manifest.blocks[manifest.placements[i]!.blockIndex]!.vertexCount;
    }
    const pos = new Float32Array(totalVerts * 3);
    const col = new Uint8Array(totalVerts * 4);
    const uv = new Float32Array(totalVerts * 2);
    const placementByTri = new Uint32Array(totalVerts / 3);

    let vCursor = 0; // vertex cursor (in verts, not floats)
    let tCursor = 0; // triangle cursor
    for (const placementIdx of placementIdxs) {
      const p = manifest.placements[placementIdx]!;
      const block = manifest.blocks[p.blockIndex]!;
      const n = block.vertexCount;
      const { wx, wy, wz } = placementWorldPos(placementIdx, block);

      const posSrc = block.positionsByteOffset / 4;
      const colSrc = block.colorsByteOffset;
      const uvSrc = block.uvsByteOffset / 4;
      for (let v = 0; v < n; v++) {
        pos[(vCursor + v) * 3 + 0] = positions[posSrc + v * 3 + 0]! + wx;
        pos[(vCursor + v) * 3 + 1] = positions[posSrc + v * 3 + 1]! + wy;
        pos[(vCursor + v) * 3 + 2] = positions[posSrc + v * 3 + 2]! + wz;
      }
      col.set(colors.subarray(colSrc, colSrc + n * 4), vCursor * 4);
      uv.set(uvs.subarray(uvSrc, uvSrc + n * 2), vCursor * 2);
      const triCount = n / 3;
      for (let t = 0; t < triCount; t++) placementByTri[tCursor + t] = placementIdx;
      vCursor += n;
      tCursor += triCount;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 4, true));
    geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `locs:merged:p${plane}`;
    mesh.userData.isMergedLocs = true;
    mesh.userData.plane = plane;
    mesh.userData.placementByTri = placementByTri;
    planeGroups[plane]!.add(mesh);
  }

  return { group, animated };
}

/**
 * Advance every animated block's `position` attribute to the frame that
 * should be showing at `elapsedMs`. Called from the render loop. O(animated
 * blocks × frameCount) worst-case per call plus one GPU upload per block
 * whose frame changed since the last call.
 *
 * Cycle layout (mirrors `LocAnimated.update` in rs-map-viewer, which mirrors
 * the OSRS client):
 *   1. Always play the intro `frames[0..frameCount)` once over `introDurationMs`.
 *   2. After the intro, behaviour depends on `frameStep`:
 *      - one-shot (`loopDurationMs === 0`): freeze on the last frame.
 *      - tail loop (`loopDurationMs > 0`): repeat `frames[loopStartFrame..frameCount)`.
 *
 * All instances of a block share the same geometry, so they animate in
 * sync. That's both what OSRS does (it has no per-instance phase by
 * default — `randomizeAnimStart` would change that, not implemented here)
 * and the cheapest thing: no shader, no per-instance buffer, no skinning.
 */
export function tickLocAnimations(animated: LocAnimationState[], elapsedMs: number): void {
  for (const state of animated) {
    let frame: number;
    if (elapsedMs < state.introDurationMs) {
      // Within the first play-through.
      let acc = 0;
      frame = state.frameDurationsMs.length - 1;
      for (let i = 0; i < state.frameDurationsMs.length; i++) {
        acc += state.frameDurationsMs[i]!;
        if (elapsedMs < acc) {
          frame = i;
          break;
        }
      }
    } else if (state.loopDurationMs === 0) {
      // One-shot animation past the end — freeze on the last frame.
      frame = state.frameDurationsMs.length - 1;
    } else {
      // Looping tail. Re-enter the loop range each cycle.
      const loopMs = (elapsedMs - state.introDurationMs) % state.loopDurationMs;
      let acc = 0;
      frame = state.frameDurationsMs.length - 1;
      for (let i = state.loopStartFrame; i < state.frameDurationsMs.length; i++) {
        acc += state.frameDurationsMs[i]!;
        if (loopMs < acc) {
          frame = i;
          break;
        }
      }
    }
    if (frame === state.lastFrameApplied) continue;
    state.lastFrameApplied = frame;
    const posAttr = state.geometry.attributes.position as THREE.BufferAttribute;
    (posAttr.array as Float32Array).set(state.framePositions[frame]!);
    posAttr.needsUpdate = true;
  }
}
