import type { ModelDefinition, FramesDefinition } from "osrscachereader";

/**
 * Apply a single OSRS animation frame to a model's vertex positions in place.
 *
 * Port of `Model.method811` from `reference/Model.java` (transform opcodes 0,
 * 1, 2, 3 only — ALPHA (5) and LIGHT (7) operate on face colors, which we've
 * already baked into per-vertex lighting and can't meaningfully reapply
 * mid-pipeline).
 *
 * Algorithm:
 *   1. Read `vectorSkin[label] = [vertexIndex...]` from `model.vertexGroups`
 *      — osrscachereader's `computeAnimationTables` pre-builds this reverse
 *      lookup and then nulls out `vertexSkins`, so `vertexSkins` is gone by
 *      the time we see the model.
 *   2. For each entry `i` in `frame.indexFrameIds`, let
 *        groupIdx = indexFrameIds[i]
 *        type     = framemap.types[groupIdx]
 *        labels   = framemap.frameMaps[groupIdx]
 *      and apply the transform of kind `type` (using translator[x,y,z][i])
 *      to every vertex whose skin label is in `labels`.
 *   3. Pivot is tracked across calls — opcode 0 (ORIGIN) updates the pivot,
 *      opcodes 2 and 3 (ROTATE, SCALE) use it.
 *
 * Rotation angle encoding: `(byte & 0xff) * 8` maps to a sine-table index
 * in [0, 2048), with the table's period being 16384 entries. We compute
 * sin/cos inline rather than precomputing — 18 defs × a handful of rotates
 * each is cheap.
 */
export function applyFramePose(model: ModelDefinition, frame: FramesDefinition): void {
  const framemap = frame.framemap;
  if (!framemap || !framemap.types || !framemap.frameMaps) return;
  const vectorSkin = model.vertexGroups;
  if (!vectorSkin) return;

  const vx = model.vertexPositionsX as number[];
  const vy = model.vertexPositionsY as number[];
  const vz = model.vertexPositionsZ as number[];
  const types = framemap.types;
  const frameMaps = framemap.frameMaps;
  const idxIds = frame.indexFrameIds;
  const tx = frame.translator_x;
  const ty = frame.translator_y;
  const tz = frame.translator_z;

  let pivotX = 0;
  let pivotY = 0;
  let pivotZ = 0;

  for (let i = 0; i < idxIds.length; i++) {
    const groupIdx = idxIds[i]!;
    const type = types[groupIdx] ?? -1;
    const labels = frameMaps[groupIdx];
    if (!labels || labels.length === 0) continue;
    const dx = tx[i]!;
    const dy = ty[i]!;
    const dz = tz[i]!;

    if (type === 0) {
      // ORIGIN — pivot = mean of labeled vertex positions + translator.
      let count = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const label of labels) {
        const verts = vectorSkin[label];
        if (!verts) continue;
        for (const v of verts) {
          sx += vx[v]!;
          sy += vy[v]!;
          sz += vz[v]!;
          count++;
        }
      }
      if (count > 0) {
        pivotX = ((sx / count) | 0) + dx;
        pivotY = ((sy / count) | 0) + dy;
        pivotZ = ((sz / count) | 0) + dz;
      } else {
        pivotX = dx;
        pivotY = dy;
        pivotZ = dz;
      }
    } else if (type === 1) {
      // TRANSLATE — add translator to each vertex.
      for (const label of labels) {
        const verts = vectorSkin[label];
        if (!verts) continue;
        for (const v of verts) {
          vx[v]! += dx;
          vy[v]! += dy;
          vz[v]! += dz;
        }
      }
    } else if (type === 2) {
      // ROTATE — around pivot, Z-axis then X-axis then Y-axis (matches
      // reference Model.java:1199-1236).
      const aX = (dx & 0xff) * 8;
      const aY = (dy & 0xff) * 8;
      const aZ = (dz & 0xff) * 8;
      const sX = aX !== 0 ? sinFixed(aX) : 0;
      const cX = aX !== 0 ? cosFixed(aX) : 0;
      const sY = aY !== 0 ? sinFixed(aY) : 0;
      const cY = aY !== 0 ? cosFixed(aY) : 0;
      const sZ = aZ !== 0 ? sinFixed(aZ) : 0;
      const cZ = aZ !== 0 ? cosFixed(aZ) : 0;
      for (const label of labels) {
        const verts = vectorSkin[label];
        if (!verts) continue;
        for (const v of verts) {
          let x = vx[v]! - pivotX;
          let y = vy[v]! - pivotY;
          let z = vz[v]! - pivotZ;
          if (aZ !== 0) {
            const nx = (y * sZ + x * cZ) >> 16;
            y = (y * cZ - x * sZ) >> 16;
            x = nx;
          }
          if (aX !== 0) {
            const ny = (y * cX - z * sX) >> 16;
            z = (y * sX + z * cX) >> 16;
            y = ny;
          }
          if (aY !== 0) {
            const nz = (z * sY + x * cY) >> 16;
            z = (z * cY - x * sY) >> 16;
            x = nz;
          }
          vx[v] = x + pivotX;
          vy[v] = y + pivotY;
          vz[v] = z + pivotZ;
        }
      }
    } else if (type === 3) {
      // SCALE — around pivot; translator values are scales ×128.
      for (const label of labels) {
        const verts = vectorSkin[label];
        if (!verts) continue;
        for (const v of verts) {
          const x = vx[v]! - pivotX;
          const y = vy[v]! - pivotY;
          const z = vz[v]! - pivotZ;
          vx[v] = ((x * dx) / 128 | 0) + pivotX;
          vy[v] = ((y * dy) / 128 | 0) + pivotY;
          vz[v] = ((z * dz) / 128 | 0) + pivotZ;
        }
      }
    }
    // Types 5 (alpha offset on faceAlphas via triangleSkin) and 7 (HSL offset
    // on faceColors) are skipped intentionally — our pipeline bakes face
    // colors into per-vertex RGB in `flattenModel`, so a post-bake face-color
    // shift wouldn't propagate. For most static-pose animations these types
    // don't appear on frame 0 anyway.
  }
}

/**
 * Apply the `method1188/1189/1190` quarter-turns for rotation 1, 2, 3 on a
 * model's vertex positions. This is what `ObjectDefinition.getModel` does
 * internally when called with a non-zero rotation, but we call getModel
 * with rotation=0 for animated locs so we can interpose the animation and
 * rotate afterward.
 */
export function rotateModelVertices(model: ModelDefinition, rotation: number): void {
  const r = rotation & 3;
  if (r === 0) return;
  const vx = model.vertexPositionsX as number[];
  const vz = model.vertexPositionsZ as number[];
  const n = model.vertexCount;
  if (r === 1) {
    for (let i = 0; i < n; i++) {
      const x = vx[i]!;
      vx[i] = vz[i]!;
      vz[i] = -x;
    }
  } else if (r === 2) {
    for (let i = 0; i < n; i++) {
      vx[i] = -vx[i]!;
      vz[i] = -vz[i]!;
    }
  } else {
    // r === 3
    for (let i = 0; i < n; i++) {
      const z = vz[i]!;
      vz[i] = vx[i]!;
      vx[i] = -z;
    }
  }
}

/** Fixed-point sine at the OSRS SINE-table angle domain (0..2047 = one full
 *  period of 2π), returning sin(angle) × 65536 as an integer. Matches the
 *  `Rasterizer3D.sinetable` the client precomputes at startup (2048 entries,
 *  `65536 × sin(2π × i / 2048)`; see `reference/Rasterizer3D.java:43`+).
 *
 *  Animation frame translators multiply by 8: `(byte & 0xff) * 8` produces
 *  an index in [0, 2040], covering the full period. An earlier version of
 *  this file used period 16384 (confused with a different OSRS angle table),
 *  which made every rotate-style frame spin by only 1/8 of the intended
 *  angle — water wheels partially-rotated then snapped back, grandfather
 *  clock pendulums barely moved, etc. Period 2048 matches `Model.java:1213`
 *  and osrscachereader `ModelLoader.animate` (`var14 × π / 1024` = `2π × var14 / 2048`). */
function sinFixed(angleIndex: number): number {
  return Math.round(Math.sin((angleIndex * 2 * Math.PI) / 2048) * 65536);
}
function cosFixed(angleIndex: number): number {
  return Math.round(Math.cos((angleIndex * 2 * Math.PI) / 2048) * 65536);
}
