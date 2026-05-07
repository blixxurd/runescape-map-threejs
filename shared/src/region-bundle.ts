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

/**
 * Schema versions for each on-disk artifact. The viewer's loader compares
 * these against the values written into the JSON manifests and throws a
 * clear "rerun pnpm extract" error on mismatch — so a code-side schema
 * bump never silently drops fields from older bundles.
 *
 * Bump rules:
 *   - Add a field anywhere in an interface → bump that artifact's version
 *     (the loader uses the version to decide whether older bundles are
 *     still safe; "field added" is always a breaking read).
 *   - Change a field's meaning → bump.
 *   - Remove a field → bump.
 *   - Add an OPTIONAL artifact (e.g. a new sibling .bin) → don't bump if
 *     the loader treats absence as "feature off."
 */
export const TERRAIN_META_SCHEMA = 3 as const;
export const TERRAIN_DEBUG_SCHEMA = 1 as const;
export const TEXTURE_ATLAS_SCHEMA = 1 as const;
export const LOCS_MANIFEST_SCHEMA = 8 as const;
export const LOCS_DEBUG_SCHEMA = 2 as const;

/** Jagex region-id layout: the high byte is regionX, the low byte is regionZ. */
export const packRegionId = (regionX: number, regionZ: number): number =>
  ((regionX & 0xff) << 8) | (regionZ & 0xff);

export const unpackRegionId = (regionId: number): { regionX: number; regionZ: number } => ({
  regionX: (regionId >> 8) & 0xff,
  regionZ: regionId & 0xff,
});

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
  schemaVersion: typeof TERRAIN_META_SCHEMA;
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
  /**
   * Per-triangle tile index, used by the debug-inspector to resolve a
   * raycast hit back to cache data. Layout: Uint16 per triangle, value =
   * `tileZ * 64 + tileX` within that triangle's plane. Triangles are in
   * the same order as `positionsFile`. Plane boundaries are at
   * `planeRanges[i].vertexCount / 3` triangle offsets.
   */
  triangleTilesFile: string; // "terrain.tri_tiles.bin"
  triangleTilesByteLength: number;
  /**
   * Per-tile passability bitmap derived from `tile.settings & 0x1` (the
   * OSRS "blocked tile" gameplay flag — see `memory/tile_settings_byte.md`).
   * Layout: plane-major Uint8 (4 × 64 × 64). Value 1 = blocked, 0 = walkable.
   * Read with `blocked[plane*4096 + z*64 + x]`. Worth ~16 KB per region;
   * loaded eagerly so pathfinding / passability overlays don't touch debug.
   */
  blockedFile: string; // "terrain.blocked.bin"
  blockedByteLength: number;
}

/**
 * Per-tile cache data used exclusively by the in-viewer debug inspector.
 * Kept separate from the rendering bundle so the runtime load is cheap
 * when debug is off.
 */
export interface TerrainDebug {
  schemaVersion: typeof TERRAIN_DEBUG_SCHEMA;
  regionId: number;
  /** Plane-major tiles (4 × 64 × 64). `tiles[plane*4096 + z*64 + x]`. */
  tiles: TerrainDebugTile[];
  underlays: Record<number, DebugUnderlayDef>;
  overlays: Record<number, DebugOverlayDef>;
}

export interface TerrainDebugTile {
  plane: number;
  x: number;
  z: number;
  underlayId: number; // 0 means "no underlay"
  overlayId: number; // 0 means "no overlay"
  overlayShape: number;
  overlayRotation: number;
  settings: number;
  /** blended packed HSL16 at this tile (the value we sampled for rendering) */
  blendedHsl: number;
}

export interface DebugUnderlayDef {
  id: number;
  rawRgb: number; // 0xRRGGBB
  hue: number;
  saturation: number;
  lightness: number;
  hueMultiplier: number;
  textureId?: number;
}

export interface DebugOverlayDef {
  id: number;
  rawRgb: number; // 0xRRGGBB
  packedHsl: number;
  textureId: number;
  hideUnderlay: boolean;
  secondaryColor?: number;
  secondaryTextureId?: number;
}

/**
 * Shared texture atlas for overlay/loc textures. Cells are the same size and
 * arranged in a square grid.
 *
 * A special "solid" cell (always at grid index 0) is a single-color white
 * texture used by all vertices that don't have an overlay texture — the
 * vertex color fully drives their appearance.
 *
 * Layout: each grid slot is `(cellSize + 2*gutter)` texels. The center
 * `cellSize × cellSize` holds the texture; the surrounding `gutter` band is
 * a wrap-replicated copy of the cell's opposite edges, so mipmap
 * minification never bleeds in neighboring cells. Baked UVs already skip
 * the gutter.
 */
export interface TextureAtlas {
  schemaVersion: typeof TEXTURE_ATLAS_SCHEMA;
  atlasFile: string; // "atlas.png"
  atlasSize: number; // pixels square (= cellsPerRow × (cellSize + 2*gutter))
  cellSize: number; // pixels square — content area only
  cellsPerRow: number;
  /** Pixels of wrap-replicated edge padding around each cell. Omit or 0 for
   *  legacy bundles without gutter. */
  gutter?: number;
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
  /** Bounding-box tile footprint from the ObjectDefinition (1..N).
   *  Used by NORMAL/NORMAL_DIAGIONAL placement to offset to the center
   *  of the footprint; WALL/FLOOR_DEC/ROOF ignore it (1×1 placement). */
  sizeX: number;
  sizeY: number;
  /** True when `ObjectDefinition.contouredGround != undefined` (opcodes
   *  21 or 81). The viewer tilts each instance of a contoured block to
   *  match the terrain's surface normal at its placement tile, so trees,
   *  rocks, and signs follow slopes instead of floating. */
  contoured: boolean;
  vertexCount: number;
  positionsByteOffset: number;
  colorsByteOffset: number;
  uvsByteOffset: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /**
   * `ObjectDefinition.interactType`: 0 = walkable, 1 = blocks player,
   * 2 = blocks player + projectiles. Per-def field, so all blocks for the
   * same locId share this. Lifted to `LocBlock` (not `LocPlacement`) to
   * keep the bundle smaller — the viewer joins on `placement.blockIndex`
   * to recover per-tile passability.
   */
  interactType: number;
  /**
   * `ObjectDefinition.blockingMask` (cache opcode 79). Override for the
   * default per-rotation wall-edge bits — when set, takes precedence over
   * the type+rotation-derived `blockedEdges`. Most defs leave this 0;
   * elided from the JSON when 0 to save bundle bytes.
   *
   * Bit semantics match `LocPlacement.blockedEdges` below. Verified
   * against `reference/Scene.java` and `osrscachereader/ObjectLoader.js`
   * line 437; consumption in the OSRS reference client we have is
   * indirect (passed to CollisionMap which we don't have a reference
   * for) — preserve raw and consume cautiously.
   */
  blockingMask?: number;
  /** Present iff this block is an animated loc. The main `positionsByteOffset`
   *  in this block already holds frame 0. All other frames live packed in
   *  `locs.frames.pos.bin` at `framesByteOffset` (Float32 x,y,z × vertexCount
   *  × frameCount, frame-major). */
  animation?: LocBlockAnimation;
}

export interface LocBlockAnimation {
  /** Total number of frames, including frame 0. Always ≥ 2 (1-frame anims
   *  don't need animation). */
  frameCount: number;
  /** Per-frame duration, in 20-ms "client-frame" units (OSRS's native unit
   *  for sequence timing). Viewer multiplies by 20 to get milliseconds. */
  frameTicks: number[];
  /** Byte offset into `locs.frames.pos.bin`. Layout is frame-major Float32:
   *  frames × (vertexCount × 3). Frame 0 is duplicated here for simple
   *  indexing — slight redundancy vs the main blob, tiny cost. */
  framesByteOffset: number;
  /** `SequenceDefinition.frameStep` — controls end-of-cycle behaviour.
   *  Mirrors `LocAnimated.update` in rs-map-viewer (`frame -= frameStep` on
   *  reaching the end). Three regimes:
   *    -1 or 0  → animation plays once and freezes on the last frame
   *               (out-of-range subtraction freezes the loc in the client).
   *    1..frameCount-1 → after the first full cycle the loop range is
   *               `[frameCount - frameStep, frameCount)` — i.e. the
   *               first `frameCount - frameStep` frames are an intro
   *               played once and the tail loops forever.
   *    ≥ frameCount → full loop (every cycle replays `[0, frameCount)`).
   *  We always include this even when it equals frameCount; the viewer
   *  branches on it. */
  frameStep: number;
  /**
   * `ObjectDefinition.randomizeAnimStart` — when true, every placement of
   * this animated loc starts at a hash-of-position frame offset instead of
   * frame 0. Without it, a row of identical animated locs ticks in lockstep
   * (visible on barrels, water wheels). Viewer hashes (locId, x, z, plane)
   * to derive a stable per-instance phase.
   */
  randomizePhase: boolean;
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
  /**
   * Pre-baked wall-edge / corner blocking bits, derived in the extractor
   * from `(origType, origRotation)` per `ROTATION_WALL_TYPE` and
   * `ROTATION_WALL_CORNER_TYPE` in `reference/Scene.java:16-17`.
   *
   * Layout (OSRS-native compass — `+Y = north` in the cache, **not** our
   * post-flip viewer space; consumers must remap if they want viewer
   * compass):
   *   bit 0 (0x01) = W edge blocked
   *   bit 1 (0x02) = N edge blocked
   *   bit 2 (0x04) = E edge blocked
   *   bit 3 (0x08) = S edge blocked
   *   bit 4 (0x10) = SW corner blocked (diagonal-only)
   *   bit 5 (0x20) = NW corner blocked
   *   bit 6 (0x40) = NE corner blocked
   *   bit 7 (0x80) = SE corner blocked
   *
   * 0 for non-wall placements (types 4..8, 9..22). Consumers handle
   * full-tile blocking for those by combining `block.interactType > 0`
   * with `block.sizeX/Y` to cover the placement footprint.
   *
   * Already includes the cache-rotation transform; if `block.blockingMask`
   * is set, it has already overridden these bits before bake.
   */
  blockedEdges: number;
  /**
   * Sub-tile world-unit offset added to the placement's translation when
   * rendering. Carries free-place precision from the in-viewer commit-edits
   * editor (cache placements never set these). Both fields default to 0
   * and are elided from the JSON when zero. Range typically ±64 (half a
   * tile); the editor doesn't enforce a hard limit.
   *
   * Sign convention: world space — `offsetX` adds to `wx` (east+), `offsetZ`
   * adds to `wz` (south+). Editor side: `offset = mesh.position - tileCenter`.
   */
  offsetX?: number;
  offsetZ?: number;
  /**
   * Residual Y-axis rotation (radians) applied per-instance ON TOP of
   * the cardinal `bakedRotation` already pre-applied to the block's
   * vertices. Lets the editor commit non-cardinal angles (45°, 22.5°,
   * etc.) without needing a separate model bake per fine angle.
   *
   * Cache placements never set this (rotation is always cardinal in the
   * cache). Adds with non-zero residuals from the in-viewer free-rotation
   * editor record it here. Default 0; omitted from the JSON when 0.
   *
   * Sign convention: Three.js right-hand rule around world +Y. Positive
   * rotates +Z toward +X. Decomposition:
   *   `cardinal  = round(rotationY / (π/2)) mod 4` → `bakedRotation`.
   *   `residual  = rotationY − cardinal × (π/2)` → this field.
   * For contoured locs the residual is applied BEFORE the per-placement
   * deformation read on the viewer side, so the rotated trunk samples
   * the right terrain.
   */
  rotationY?: number;
}

export interface LocsManifest {
  schemaVersion: typeof LOCS_MANIFEST_SCHEMA;
  blocks: LocBlock[];
  placements: LocPlacement[];
  positionsByteLength: number;
  colorsByteLength: number;
  uvsByteLength: number;
  positionsFile: string; // "locs.pos.bin"
  colorsFile: string; // "locs.col.bin"
  uvsFile: string; // "locs.uv.bin"
  /** Optional frame-positions blob for animated blocks — only present when
   *  at least one block has an `animation` field. */
  framesFile?: string; // "locs.frames.pos.bin"
  framesByteLength?: number;
  /**
   * Per-placement stable ID, parallel to `placements` by index. Layout:
   * Uint32 × placements.length. Hash of
   * `(plane, localX, localZ, locId, origType, origRotation)`, computed by
   * `placementHash` in `packages/extractor/src/region/edits.ts`. Used by
   * the in-viewer "commit edits" feature: a raycast hit → instanceId or
   * faceIndex → placement index → placement ID, which the viewer sends to
   * `/api/dev/commit-edits` as a "remove" tombstone. WALL_CORNER (type 2)
   * expands to two LocPlacements sharing one cache record; both rows get
   * the same ID, so one tombstone removes both halves cleanly. Empty
   * regions get `placementIdsByteLength: 0` and skip the file.
   */
  placementIdsFile: string; // "locs.placementIds.bin"
  placementIdsByteLength: number;
  /** loc ids that appeared in placements but could not be resolved (missing from cache). */
  skippedLocIds: number[];
  /**
   * Phase 5: per-source-locId morph spec, keyed by the locId that originally
   * appears in the cache placements. When a placement's locId is in this map,
   * the rendered geometry depends on the controlling var's value:
   *   alternates[varValue] = the locId whose blocks should render instead.
   *   Last entry of `alternates` is the "default-when-unmatched" locId
   *   (opcode 92) or -1 (opcode 77, "freeze on the previous render").
   *   -1 in `alternates` means "hide entirely for this state."
   *
   * Each alternate locId is also baked into `blocks` with the same
   * `(modelType, bakedRotation)` set as the source loc, so the viewer can
   * find a renderable block per `(altLocId, modelType, bakedRotation)`
   * triple via `blockIndexByKey`-style lookup.
   *
   * Source: cache opcodes 77 and 92 in
   * `osrscachereader/loaders/ObjectLoader.js`. Verified the field naming
   * (`varbitID` is the varbit, `varpID` the varp) by reading the loader.
   */
  morphs?: Record<number, LocMorphSpec>;
}

export interface LocMorphSpec {
  /** Which kind of game-state var controls this morph. */
  varKind: "varbit" | "varp";
  /** ID of the controlling varbit or varp. -1 means "neither set" — only
   *  the default alternate is reachable. */
  varId: number;
  /** Alternate locIds keyed by var value. -1 means "no render". */
  alternates: number[];
}

/** Debug-only summary for a single resolved loc block. */
export interface LocDebugBlock {
  locId: number;
  modelType: number;
  bakedRotation: number;
  faceCount: number;
  texturedFaceCount: number;
  distinctFaceColors: number;
  /** object definition name if the cache provided one (may be omitted) */
  name?: string;
  /**
   * Optional def-level fields surfaced for the inspector. All are present
   * iff the cache opcode that sets them appeared (i.e. defaults are
   * usually omitted from the JSON to keep bundles small). Source field
   * meanings come from `osrscachereader/src/cacheReader/loaders/ObjectLoader.js`
   * and the OSRS reference client at `/reference/`.
   */
  obstructsGround?: boolean;
  /** False (only persisted when explicitly disabled). Default in cache is true. */
  shadow?: boolean;
  hollow?: boolean;
  /** 0 or 1. Whether ground items rest on top of this loc. */
  supportsItems?: number;
  /** Default 16 (omitted when default). Wall-decor pull-out distance. */
  decorDisplacement?: number;
  wallOrDoor?: number;
  mapSceneID?: number;
  mapAreaId?: number;
  /** Mirror of LocBlock.interactType, surfaced here for the inspector
   *  without having to cross-index. 0 = walkable, 1 = blocks, 2 = blocks + projectiles. */
  interactType: number;
  randomizeAnimStart?: boolean;
}

export interface LocsDebug {
  schemaVersion: typeof LOCS_DEBUG_SCHEMA;
  /** Parallel to `LocsManifest.blocks` by index. */
  blocks: LocDebugBlock[];
}

// ---------- Edits overlay ----------

/**
 * On-disk overlay applied to a region during extraction so user edits made
 * in the viewer survive a re-extract. Lives at
 * `packages/extractor/edits/<regionId>.json` (checked into git — source
 * data, NOT under `regions/` which is gitignored).
 *
 * Two operations:
 *   - **removes**: hex placement IDs (8 chars; uint32 zero-padded). The
 *     extractor filters out any cache-record placement whose hash matches.
 *   - **adds**: synthesised placements appended to the region. Adds with
 *     unknown `locId` are rejected at the API boundary (commit-edits
 *     endpoint validates against the object catalog).
 *
 * "Move a placement" is modelled as remove + add — the placement ID changes
 * because the hash inputs change. Out of scope for v1: moving baked locs at
 * all. v1 supports add-fresh + delete-baked only.
 */
export const EDITS_SCHEMA = 1 as const;

export interface EditsOverlay {
  schemaVersion: typeof EDITS_SCHEMA;
  regionId: number;
  removes: string[];
  adds: EditsOverlayAdd[];
}

export interface EditsOverlayAdd {
  locId: number;
  plane: number;
  /** Region-local tile coords (0..63). */
  tileX: number;
  tileZ: number;
  /** OSRS placement type 0..22. The viewer emits whatever type the source
   *  bake chose (walls 0..3, wall decor 4..8, normal scenery 10, floor
   *  decor 22). Hardcoding 10 used to silently drop fences/doors at
   *  re-bake time. */
  type: number;
  /** Cardinal cache rotation 0..3 (from `decomposeRotation` in the viewer).
   *  Non-cardinal placement angles ride along in `rotationY` below — the
   *  pair round-trips losslessly. */
  rotation: number;
  /** Per-placement animation override. v1 ignores this on the extract
   *  side; reserved for future per-instance animation overrides. */
  animationOverride: number | null;
  /** Sub-tile offset in world units (relative to the tile center). Set
   *  by the in-viewer free-place mode so committed placements land at the
   *  exact spot the user dropped them, not snapped to the tile centre.
   *  Both fields default to 0; either may be omitted. */
  offsetX?: number;
  offsetZ?: number;
  /** Residual Y-axis rotation (radians) applied on top of the cardinal
   *  `rotation`. Lets the editor preserve non-cardinal placement angles
   *  (45°, 22.5°, etc.) — the cache schema only stores cardinal rotations,
   *  so anything in between would otherwise snap on commit. Default 0,
   *  omitted when 0. See `LocPlacement.rotationY` for the sign convention. */
  rotationY?: number;
}
