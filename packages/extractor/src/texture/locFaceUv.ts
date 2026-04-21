/**
 * Per-vertex UV derivation for textured loc faces.
 *
 * OSRS model texturing works like this:
 *   - Each face has a `textureId` (via `faceTextures[i]`) and a
 *     `textureTriangleIndex` (via `textureCoordinates[i]`, or -1 to mean
 *     "project onto the face's own vertex triple").
 *   - The model stores a separate list of texture triangles, each defined
 *     by 3 vertex indices into the model's position arrays.
 *   - UV basis: `origin = P_A`, `U-axis = P_B - P_A`, `V-axis = P_C - P_A`,
 *     where A/B/C are the texture triangle's vertex positions (in original
 *     client-space coordinates — *before* any axis flips or resizes).
 *   - For each face vertex V, its UV is the affine projection of V onto
 *     that basis. In the "identity" case where the texture triangle IS the
 *     face triangle, UVs collapse to (0,0), (1,0), (0,1).
 *
 * This matches `SceneTileModel`-style UV derivation in the client and in
 * dennisdev/rs-map-viewer, and generalizes to any model — walls, floors,
 * rooftops, props.
 */

interface ModelLike {
  vertexPositionsX: ArrayLike<number>;
  vertexPositionsY: ArrayLike<number>;
  vertexPositionsZ: ArrayLike<number>;
  faceVertexIndices1: ArrayLike<number>;
  faceVertexIndices2: ArrayLike<number>;
  faceVertexIndices3: ArrayLike<number>;
  faceTextures?: ArrayLike<number>;
  // osrscachereader uses inconsistent field names across load paths.
  textureCoords?: ArrayLike<number>; // load1 / load2
  textureCoordinates?: ArrayLike<number>; // loadOriginal
  texIndices1?: ArrayLike<number>; // load1 / load2
  texIndices2?: ArrayLike<number>;
  texIndices3?: ArrayLike<number>;
  textureTriangleVertexIndices1?: ArrayLike<number>; // loadOriginal
  textureTriangleVertexIndices2?: ArrayLike<number>;
  textureTriangleVertexIndices3?: ArrayLike<number>;
}

function getTexCoord(model: ModelLike, faceIndex: number): number {
  // Resolve whichever name the loader populated.
  if (model.textureCoords && model.textureCoords.length > faceIndex) {
    return model.textureCoords[faceIndex] as number;
  }
  if (model.textureCoordinates && model.textureCoordinates.length > faceIndex) {
    return model.textureCoordinates[faceIndex] as number;
  }
  return -1;
}

function getTexTriangle(
  model: ModelLike,
): { t1: ArrayLike<number>; t2: ArrayLike<number>; t3: ArrayLike<number> } | null {
  if (model.texIndices1 && model.texIndices2 && model.texIndices3) {
    return { t1: model.texIndices1, t2: model.texIndices2, t3: model.texIndices3 };
  }
  if (
    model.textureTriangleVertexIndices1 &&
    model.textureTriangleVertexIndices2 &&
    model.textureTriangleVertexIndices3
  ) {
    return {
      t1: model.textureTriangleVertexIndices1,
      t2: model.textureTriangleVertexIndices2,
      t3: model.textureTriangleVertexIndices3,
    };
  }
  return null;
}

/**
 * Returns [u0, v0, u1, v1, u2, v2] for face `faceIndex`. The three pairs
 * correspond to faceVertexIndices1/2/3 in order.
 */
export function computeFaceUv(model: ModelLike, faceIndex: number): [number, number, number, number, number, number] {
  const fa = model.faceVertexIndices1[faceIndex] as number;
  const fb = model.faceVertexIndices2[faceIndex] as number;
  const fc = model.faceVertexIndices3[faceIndex] as number;

  // Select texture triangle. -1 means identity — the face's own vertices
  // are the texture triangle, so UVs collapse to (0,0), (1,0), (0,1).
  const texCoord = getTexCoord(model, faceIndex);
  const triIdx = getTexTriangle(model);

  let ta: number;
  let tb: number;
  let tc: number;
  if (texCoord === -1 || !triIdx) {
    ta = fa;
    tb = fb;
    tc = fc;
  } else {
    ta = triIdx.t1[texCoord] as number;
    tb = triIdx.t2[texCoord] as number;
    tc = triIdx.t3[texCoord] as number;
  }

  const ax = model.vertexPositionsX[ta] as number;
  const ay = model.vertexPositionsY[ta] as number;
  const az = model.vertexPositionsZ[ta] as number;
  const bx = model.vertexPositionsX[tb] as number;
  const by = model.vertexPositionsY[tb] as number;
  const bz = model.vertexPositionsZ[tb] as number;
  const cx = model.vertexPositionsX[tc] as number;
  const cy = model.vertexPositionsY[tc] as number;
  const cz = model.vertexPositionsZ[tc] as number;

  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const uDotU = ux * ux + uy * uy + uz * uz;
  const vDotV = vx * vx + vy * vy + vz * vz;
  const uDotV = ux * vx + uy * vy + uz * vz;
  // Gramian determinant of the 2D basis {e1, e2}; zero = degenerate triangle.
  const D = uDotU * vDotV - uDotV * uDotV;
  if (D === 0) {
    return [0, 0, 1, 0, 0, 1];
  }

  // Solve `rel = u*e1 + v*e2` as a least-squares 2D affine projection. For a
  // non-orthogonal texture triangle (diagonal walls, roof slopes, etc.) the
  // naive `u = dot(rel, e1) / |e1|²` is only correct when e1 ⊥ e2; otherwise
  // it shears UVs and the texture appears stretched on the face. The Gramian
  // inverse gives the correct affine coords.
  const project = (pi: number): [number, number] => {
    const px = model.vertexPositionsX[pi] as number;
    const py = model.vertexPositionsY[pi] as number;
    const pz = model.vertexPositionsZ[pi] as number;
    const rx = px - ax, ry = py - ay, rz = pz - az;
    const relU = rx * ux + ry * uy + rz * uz;
    const relV = rx * vx + ry * vy + rz * vz;
    const u = (relU * vDotV - relV * uDotV) / D;
    const v = (relV * uDotU - relU * uDotV) / D;
    return [u, v];
  };

  const [u0, v0] = project(fa);
  const [u1, v1] = project(fb);
  const [u2, v2] = project(fc);
  return [u0, v0, u1, v1, u2, v2];
}

/**
 * Map a texture-local UV (both in [0, 1]) to absolute atlas UVs for the
 * given cell. Each slot holds `cellSize × cellSize` content wrapped by a
 * `gutter`-wide band; UVs map into the content area only.
 *
 * UVs outside [0, 1] are **clamped**, not wrapped. Atlases don't compose
 * with `RepeatWrapping` — wrapping would jump to the opposite edge of the
 * cell and alias into a different texture. If OSRS geometry ever tiles a
 * face across its own texture (rare; tiles are usually per-face), it'll
 * show a stretched last-texel edge, which is far less visually wrong than
 * a mid-wall seam.
 */
export function cellUV(
  atlasSize: number,
  cellsPerRow: number,
  cellSize: number,
  gutter: number,
  cell: number,
  u: number,
  v: number,
): [number, number] {
  const slotSize = cellSize + 2 * gutter;
  const cellCol = cell % cellsPerRow;
  const cellRow = Math.floor(cell / cellsPerRow);
  const uu = Math.max(0, Math.min(1, u));
  const vv = Math.max(0, Math.min(1, v));
  return [
    (cellCol * slotSize + gutter + uu * cellSize) / atlasSize,
    (cellRow * slotSize + gutter + vv * cellSize) / atlasSize,
  ];
}
