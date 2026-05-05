/**
 * Minimal ambient declarations for `osrscachereader`.
 * The library ships no types. We declare only what the extractor actually calls.
 */

declare module "osrscachereader" {
  export interface RSCacheIndexType {
    id: number;
    loader: unknown;
  }
  export interface RSCacheConfigType {
    id: number;
    loader: unknown;
  }

  export const IndexType: {
    CONFIGS: RSCacheIndexType;
    MAPS: RSCacheIndexType;
    MODELS: RSCacheIndexType;
    SPRITES: RSCacheIndexType;
    TEXTURES: RSCacheIndexType;
    FRAMES: RSCacheIndexType;
    [key: string]: RSCacheIndexType | ((id: number) => RSCacheIndexType | undefined);
  };

  export const ConfigType: {
    UNDERLAY: RSCacheConfigType;
    OVERLAY: RSCacheConfigType;
    OBJECT: RSCacheConfigType;
    NPC: RSCacheConfigType;
    ITEM: RSCacheConfigType;
    SEQUENCE: RSCacheConfigType;
    SPOTANIM: RSCacheConfigType;
    [key: string]: RSCacheConfigType | ((id: number) => RSCacheConfigType | undefined);
  };

  export interface Tile {
    /** Byte height value. May be undefined → default noise-based height. */
    height?: number;
    attrOpcode?: number;
    overlayId?: number;
    /** Overlay shape, 0..12. */
    overlayPath?: number;
    overlayRotation?: number;
    settings?: number;
    underlayId?: number;
  }

  export interface MapDefinition {
    id: number;
    regionX: number;
    regionY: number;
    tiles: Tile[][][]; // [plane][x][y]
    heights?: number[][][];
    getHeights(): number[][][]; // [plane][x][y], already × 8 and cumulative over planes
  }

  export interface LocationPlacement {
    id: number;
    type: number;
    orientation: number;
    position: { localX: number; localY: number; height: number };
  }

  export interface LocationDefinition {
    id: number;
    regionX: number;
    regionY: number;
    locations: LocationPlacement[];
  }

  export interface UnderlayDefinition {
    id: number;
    color: number; // packed HSL (16-bit) computed by loadHsl+packHsl
    /** hue = hueMultiplier × (wheelPos in [0,1]). NOT suitable for packing
     *  directly — must normalize via `(hue * 256) / hueMultiplier` first
     *  (or average across tiles first, then do the normalization). */
    hue: number;
    saturation: number; // 0..255
    lightness: number; // 0..255
    /** Present after the UnderlayLoader patch reads opcode 2. */
    textureId?: number;
    /** Raw 0xRRGGBB captured by the patched handleOpcode. */
    rawRgb?: number;
    /** The per-tile weighting factor for hue blending, saved by our patch. */
    hueMultiplier?: number;
  }

  export interface OverlayDefinition {
    id: number;
    color: number; // packed HSL (16-bit) after the library's convertToHsl
    texture: number;
    hideUnderlay: boolean;
    secondaryColor: number;
    secondaryTextureId?: number;
    /** Raw 0xRRGGBB from opcode 1, captured by the patched handleOpcode
     *  BEFORE the library overwrites `color` with packed HSL. Needed to
     *  detect the OSRS magenta sentinel (0xFF00FF = invisible overlay). */
    rawPrimaryRgb?: number;
    /** Opcode 6 name (only set when present in the cache entry). */
    name?: string;
  }

  export interface ItemDefinition {
    id: number;
    name?: string;
    inventoryModel?: number;
    recolorToFind?: number[];
    recolorToReplace?: number[];
    retextureToFind?: number[];
    retextureToReplace?: number[];
    ambient?: number;
    contrast?: number;
    /** Scale multiplied by 128 (128 = 1×). Used for ground-item scaling. */
    resizeX?: number;
    resizeY?: number;
    resizeZ?: number;
    /** Rotations used for 2D inventory rendering — ignored for ground models. */
    xan2d?: number;
    yan2d?: number;
    zan2d?: number;
    /** Present for banknotes: item that owns the graphic template. */
    notedID?: number;
    notedTemplate?: number;
    /** Present for placeholder items (empty bank slots etc). */
    placeholderId?: number;
    placeholderTemplateId?: number;
    members?: boolean;
    stackable?: number;
    category?: number;
    /** Phase 4 catalog metadata. All optional — opcode-gated in the loader. */
    examineText?: string;
    /** GE buy price in coins. Loader stores raw int; default unset. */
    cost?: number;
    weight?: number;
    isTradeable?: boolean;
    /** Team-cape ID, 1..N. Default unset. */
    team?: number;
    /** Right-click sub-options (e.g. "Equip", "Wield"). Cache opcode 35. */
    subops?: string[][];
  }

  export interface NpcDefinition {
    id: number;
    name?: string;
    models: number[];
    size: number;
    standingAnimation?: number;
    walkingAnimation?: number;
    runAnimation?: number;
    rotateLeftAnimation?: number;
    rotateRightAnimation?: number;
    rotate180Animation?: number;
    rotate90LeftAnimation?: number;
    rotate90RightAnimation?: number;
    runRotate180Animation?: number;
    runRotateLeftAnimation?: number;
    runRotateRightAnimation?: number;
    crawlAnimation?: number;
    crawlRotate180Animation?: number;
    crawlRotateLeftAnimation?: number;
    crawlRotateRightAnimation?: number;
    combatLevel?: number;
    ambient?: number;
    contrast?: number;
    recolorToFind?: number[];
    recolorToReplace?: number[];
    retextureToFind?: number[];
    retextureToReplace?: number[];
    heightScale?: number;
    category?: number;
    isMinimapVisible?: boolean;
    /** Phase 4 picker metadata. */
    renderPriority?: number;
    rotationSpeed?: number;
    /** `headIconArchiveIds[i]` indexes into the headicons sprite archive,
     *  with `headIconSpriteIndex[i]` the cell within that archive. */
    headIconArchiveIds?: number[];
    headIconSpriteIndex?: number[];
  }

  export interface ObjectDefinition {
    id: number;
    name?: string;
    objectTypes: number[] | null;
    objectModels: number[] | null;
    sizeX: number;
    sizeY: number;
    ambient?: number;
    contrast?: number;
    contouredGround?: number;
    modelSizeX: number;
    modelSizeHeight: number;
    modelSizeY: number;
    offsetX: number;
    offsetHeight: number;
    offsetY: number;
    rotated: boolean;
    contouredGround?: number;
    mergeNormals: boolean;
    interactType: number;
    recolorToFind?: number[];
    recolorToReplace?: number[];
    retextureToFind?: number[];
    textureToReplace?: number[];
    animationID?: number;
    shadow?: boolean;
    decorDisplacement?: number;
    obstructsGround?: boolean;
    varbitID?: number;
    varpID?: number;
    /** Cache opcode 77/92 — alternate locIds keyed by varbit/varp value.
     *  `configChangeDest[i]` is the locId to render when the controlling
     *  var equals `i`. Last entry is -1 (or, for opcode 92, the explicit
     *  default-when-unmatched value). */
    configChangeDest?: number[];
    /** Phase 4 catalog metadata (loc category for picker filters). */
    category?: number;
    /** Phase 4 free-form key/value bag from `params{}` — script-driven
     *  metadata (teleport destinations, varbit thresholds, etc.). Keys
     *  are int paramId; values are string or number. */
    params?: Record<string, string | number>;
    getModel(cache: RSCache, modelType: number, rotation: number): Promise<ModelDefinition | null>;
  }

  /**
   * SpotAnim — projectiles, spell effects, gfx-on-NPC, hitsplats. Single
   * model + optional animation. Per `osrscachereader/loaders/SpotAnimLoader.js`.
   */
  export interface SpotAnimDefinition {
    id: number;
    name?: string;
    modelId?: number;
    animationId?: number;
    /** Scale multiplier × 128 (128 = 1×). */
    resizeX?: number;
    resizeY?: number;
    /** Initial yaw, OSRS units (0..2047). */
    rotation?: number;
    ambient?: number;
    contrast?: number;
    recolorToFind?: number[];
    recolorToReplace?: number[];
    textureToFind?: number[];
    textureToReplace?: number[];
  }

  export interface SequenceDefinition {
    id: number;
    name?: string;
    frameLengths: number[];
    frameIDs: number[];
    frameStep: number;
  }

  /** Per-group animation skeleton: `frameMaps[g]` is the list of vertex-skin
   *  labels that belong to group `g`; `types[g]` is the transform opcode
   *  (0=origin, 1=translate, 2=rotate, 3=scale, 5=alpha, 7=light) that frames
   *  apply to group `g`. */
  export interface FramemapDefinition {
    id: number;
    length: number;
    types: number[];
    frameMaps: number[][];
  }

  export interface FramesDefinition {
    id: number;
    framemap: FramemapDefinition;
    indexFrameIds: number[];
    translator_x: number[];
    translator_y: number[];
    translator_z: number[];
    translatorCount: number;
    showing?: boolean;
    colorTransform?: boolean;
  }

  export interface ModelDefinition {
    vertexPositionsX: Int32Array | number[];
    vertexPositionsY: Int32Array | number[];
    vertexPositionsZ: Int32Array | number[];
    faceVertexIndices1: Int32Array | number[];
    faceVertexIndices2: Int32Array | number[];
    faceVertexIndices3: Int32Array | number[];
    faceColors?: Int32Array | number[];
    /** Per-face texture id; -1 or absent for untextured faces. */
    faceTextures?: Int32Array | number[];
    faceAlphas?: Int32Array | number[];
    /**
     * Per-face index into the texture-triangle arrays, selecting which
     * texture-triangle to project the face vertices onto for UVs. -1 means
     * "use the face's own vertex indices" (identity projection).
     *
     * `osrscachereader` is inconsistent about field names across load paths:
     *   - `load1` / `load2` populate `textureCoords` (short) + `texIndices1/2/3`.
     *   - `loadOriginal` populates `textureCoordinates` (long) + `textureTriangleVertexIndices1/2/3`.
     * We expose both so the UV code doesn't have to care which loader ran.
     */
    textureCoords?: Int32Array | number[];
    textureCoordinates?: Int32Array | number[];
    /** Texture-triangle vertex indices (`load1`/`load2` short names). */
    texIndices1?: Int32Array | number[];
    texIndices2?: Int32Array | number[];
    texIndices3?: Int32Array | number[];
    /** Texture-triangle vertex indices (`loadOriginal` long names). */
    textureTriangleVertexIndices1?: Int32Array | number[];
    textureTriangleVertexIndices2?: Int32Array | number[];
    textureTriangleVertexIndices3?: Int32Array | number[];
    /** Count of texture triangles. */
    numTextureFaces?: number;
    faceCount: number;
    vertexCount: number;
    /** Per-vertex animation skin label (0..255 as a byte). ONLY populated
     *  during cache decode — `computeAnimationTables` nulls this out after
     *  building `vertexGroups`. Don't rely on it post-load. */
    vertexSkins?: number[] | null;
    /** Pre-built reverse lookup: `vertexGroups[label] = [vertexIdx...]`.
     *  This is what animation frames actually index into — the framemap's
     *  `frameMaps[groupIdx]` array is a list of labels, each resolving
     *  to a list of vertices here. */
    vertexGroups?: number[][];
    /** Per-face animation skin label — same lifetime as vertexSkins. */
    faceSkins?: number[] | null;
    /** Post-decode reverse lookup for face alpha transforms. */
    faceLabelsAlpha?: number[][];
    // a bunch of method1xxx/resize/recolor etc we don't call directly
  }

  export interface RSCacheOptions {
    cacheResults?: boolean;
    threaded?: boolean;
    loadSprites?: boolean;
    isAnimaya?: boolean;
    earlyStop?: boolean;
  }

  export class RSCache {
    constructor(cacheRootDir: string | Date | number, progressFunc?: (amount: number) => void);
    onload: Promise<void>;
    indicies: Record<number, unknown>;
    cacheRequester: { xteas: Record<number, { mapsquare: number; key: number[] }> };

    close(): void;
    getMap(x: number, y: number): Promise<MapDefinition>;
    getLoc(x: number, y: number): Promise<LocationDefinition>;
    getNPC(id: number, options?: RSCacheOptions): Promise<NpcDefinition>;
    getDef<T = unknown>(
      indexId: number | RSCacheIndexType,
      archiveId: number | RSCacheConfigType,
      fileId?: number,
      options?: RSCacheOptions,
    ): Promise<T>;
    getAllDefs<T = unknown>(
      indexId: number | RSCacheIndexType,
      archiveId: number | RSCacheConfigType,
      options?: RSCacheOptions,
    ): Promise<T[]>;
  }

  export class GLTFExporter {
    constructor();
    addModel(model: ModelDefinition, name?: string): void;
    export(): Uint8Array; // returns glb bytes
  }
}
