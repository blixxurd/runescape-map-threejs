/**
 * On-disk schema for a preprocessed region bundle.
 *
 * The extractor flattens terrain and locs into plain binary typed-array blobs
 * + small JSON manifests. The viewer uploads them into Three.js BufferGeometry
 * with zero decoding work.
 *
 * Coordinate convention (matches Jagex, right-handed glTF/Three):
 *   - Tile width = 128 world units, east=+x, north=+z, up=+y.
 *   - Y/Z are negated from the client's native left-handed layout so the
 *     data drops straight into Three.js without extra flips.
 */

export const TILES_PER_SIDE = 64;
export const VERTICES_PER_SIDE = TILES_PER_SIDE + 1;
export const PLANES = 4;
export const TILE_SIZE = 128;

export interface RegionBundle {
  terrainMeta: TerrainMeta;
  locs: LocsManifest;
}

// ---------- Terrain ----------

/**
 * Terrain is baked into one non-indexed triangle soup per plane. Each vertex
 * carries a position (float32, 3) and a color (u8, 4 RGBA). The viewer builds
 * a `BufferGeometry` directly from these two attribute arrays.
 *
 * Why non-indexed? OSRS tile-coloring is per-sub-triangle (each sub-triangle
 * gets a flat underlay or overlay color), and many vertices sit on tile
 * corners shared by triangles with different colors. Duplicating vertices
 * sidesteps the "one color per vertex" limitation Three.js has and keeps
 * the per-triangle flat shading intent.
 */
export interface TerrainMeta {
  schemaVersion: 2;
  regionId: number;
  regionX: number;
  regionZ: number;
  planes: number;
  tileSize: number;
  buildId: number;
  sourceCacheId: number;
  /** Per-plane slice into the shared binary blobs. */
  planeRanges: Array<{
    plane: number;
    vertexCount: number;
    positionsByteOffset: number;
    colorsByteOffset: number;
    uvsByteOffset: number;
  }>;
  /** Total vertex count across all planes (positions array length / 3). */
  totalVertexCount: number;
  /** Byte lengths of the flat attribute blobs. */
  positionsByteLength: number;
  colorsByteLength: number;
  uvsByteLength: number;
  /** File names relative to the bundle root. */
  positionsFile: string; // "terrain.pos.bin"  — Float32 [x,y,z] × totalVertexCount
  colorsFile: string; // "terrain.col.bin"    — Uint8   [r,g,b,a] × totalVertexCount
  uvsFile: string; // "terrain.uv.bin"        — Float32 [u,v] × totalVertexCount
  /**
   * Grid of corner heights in world-Y (already flipped: +Y up).
   * Layout: plane-major Int16 (4 × 65 × 65). The viewer uses this to place
   * locs on terrain — `heightAt(plane, x, z) = heights[plane*65*65 + z*65 + x]`.
   */
  heightsFile: string; // "terrain.heights.bin"
  heightsByteLength: number;
}

/**
 * Shared texture atlas for overlay/loc textures. Cells are the same size and
 * arranged in a square grid so UVs are simple: `u ∈ [cellU, cellU+cellSize]`.
 *
 * A special "solid" cell (always at grid index 0) is a single-color white
 * texture used by all vertices that don't have an overlay texture — the
 * vertex color fully drives their appearance.
 */
export interface TextureAtlas {
  schemaVersion: 1;
  atlasFile: string; // "atlas.png"
  atlasSize: number; // pixels square
  cellSize: number; // pixels square
  cellsPerRow: number;
  /** Map from OSRS texture ID → cell index (0..cellsPerRow²). Cell 0 is white. */
  cellByTextureId: Record<number, number>;
  /** Inverse: grid index → texture id (−1 for the white cell and empty cells). */
  textureIdByCell: number[];
}

// ---------- Locs ----------

/**
 * One "loc block" is the geometry for a single (locId, modelType, bakedRotation)
 * triple. Rotation is baked into the vertices because OSRS's rotation values
 * above 3 trigger extra transforms (method1194 flip, method1206 offset) that
 * aren't expressible as a Three.js instance matrix. Instances only translate.
 *
 * Block geometry is non-indexed triangle soup (per-face flat color requires
 * vertex duplication).
 */
export interface LocBlock {
  locId: number;
  /** 0..22. This is the `modelType` passed to `getModel`, which for most
   *  placement types equals the placement type, but e.g. type 11
   *  (NORMAL_DIAGIONAL) resolves to modelType 10. */
  modelType: number;
  /** Full 0..7 rotation that was baked into the model. */
  bakedRotation: number;
  vertexCount: number;
  positionsByteOffset: number;
  colorsByteOffset: number;
  uvsByteOffset: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/**
 * One placement = one rendered instance. Some OSRS loc types expand into
 * multiple placements (e.g. WALL_CORNER = two blocks per original loc record).
 * The cache-level (type, rotation) are kept for diagnostics only — the viewer
 * just translates the referenced block to (x, z, plane).
 */
export interface LocPlacement {
  locId: number;
  /** Original cache placement type (0..22) for debugging. */
  origType: number;
  /** Original cache rotation (0..3) for debugging. */
  origRotation: number;
  /** Region-local tile coords (0..63). */
  x: number;
  z: number;
  plane: number;
  /** Index into `LocsManifest.blocks`. Geometry is pre-rotated. */
  blockIndex: number;
}

export interface LocsManifest {
  schemaVersion: 2;
  blocks: LocBlock[];
  placements: LocPlacement[];
  positionsByteLength: number;
  colorsByteLength: number;
  uvsByteLength: number;
  positionsFile: string; // "locs.pos.bin"
  colorsFile: string; // "locs.col.bin"
  uvsFile: string; // "locs.uv.bin"
  /** loc ids that appeared in placements but could not be resolved (missing from cache). */
  skippedLocIds: number[];
}
