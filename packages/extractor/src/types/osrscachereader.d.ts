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
    color: number; // packed HSL (16-bit)
    hue: number;
    saturation: number;
    lightness: number;
  }

  export interface OverlayDefinition {
    id: number;
    color: number; // packed HSL (16-bit)
    texture: number;
    hideUnderlay: boolean;
    secondaryColor: number;
  }

  export interface ObjectDefinition {
    id: number;
    name?: string;
    objectTypes: number[] | null;
    objectModels: number[] | null;
    sizeX: number;
    sizeY: number;
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
    getModel(cache: RSCache, modelType: number, rotation: number): Promise<ModelDefinition | null>;
  }

  export interface ModelDefinition {
    vertexPositionsX: Int32Array | number[];
    vertexPositionsY: Int32Array | number[];
    vertexPositionsZ: Int32Array | number[];
    faceVertexIndices1: Int32Array | number[];
    faceVertexIndices2: Int32Array | number[];
    faceVertexIndices3: Int32Array | number[];
    faceColors?: Int32Array | number[];
    faceTextures?: Int32Array | number[];
    faceAlphas?: Int32Array | number[];
    faceCount: number;
    vertexCount: number;
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
