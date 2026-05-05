import type {
  RSCache,
  LocationDefinition,
  ObjectDefinition,
  ModelDefinition,
  SequenceDefinition,
  FramesDefinition,
} from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hsl16ToRgb } from "../color/hsl.js";
import { computeFaceUv, cellUV } from "../texture/locFaceUv.js";
import type { BakedAtlas } from "../texture/atlas.js";
import type { LocsManifest, LocBlock, LocPlacement, LocsDebug, LocDebugBlock, LocMorphSpec } from "@rsmap/shared";
import {
  TILE_SIZE,
  TILES_PER_SIDE,
  LOCS_MANIFEST_SCHEMA,
  LOCS_DEBUG_SCHEMA,
} from "@rsmap/shared";
import { applyFramePose, rotateModelVertices } from "./animate.js";

import {
  BASE_AMBIENT,
  BASE_CONTRAST,
  faceLightness,
  applyLightToHsl,
  applyFaceColorSubstitution,
  applyFaceTextureSubstitution,
} from "../color/modelLight.js";

/**
 * Loc-type → (modelType, rotationOffset) expansion. See memory notes for why
 * WALL_CORNER and NORMAL_DIAGIONAL need special treatment.
 */
interface BlockDraw {
  modelType: number;
  bakedRotation: number;
}

function expandPlacement(type: number, rotation: number): BlockDraw[] {
  switch (type) {
    case 2: // WALL_CORNER
      return [
        { modelType: 2, bakedRotation: rotation + 4 },
        { modelType: 2, bakedRotation: (rotation + 1) & 3 },
      ];
    case 5: // WALL_DECORATION_OUTSIDE: resolves to modelType 4 (INSIDE) geom
      return [{ modelType: 4, bakedRotation: rotation }];
    case 6: // WALL_DECORATION_DIAGONAL_OUTSIDE: modelType 4, rot+4
      return [{ modelType: 4, bakedRotation: rotation + 4 }];
    case 7: // WALL_DECORATION_DIAGONAL_INSIDE: modelType 4, insideRot+4
      return [{ modelType: 4, bakedRotation: ((rotation + 2) & 3) + 4 }];
    case 8: // WALL_DECORATION_DIAGONAL_DOUBLE: two modelType-4 draws
      return [
        { modelType: 4, bakedRotation: rotation + 4 },
        { modelType: 4, bakedRotation: ((rotation + 2) & 3) + 4 },
      ];
    case 11: // NORMAL_DIAGIONAL
      return [{ modelType: 10, bakedRotation: rotation + 4 }];
    default:
      return [{ modelType: type, bakedRotation: rotation }];
  }
}

/**
 * Per-rotation wall-edge bits. Verbatim from `reference/Scene.java:16-17`
 * (`ROTATION_WALL_TYPE` / `ROTATION_WALL_CORNER_TYPE`). Indexed by the
 * cache-level `face` / `rotation` 0..3.
 *
 * Bit semantics (OSRS-native compass, +Y = north):
 *   0x01=W  0x02=N  0x04=E  0x08=S
 *   0x10=SW 0x20=NW 0x40=NE 0x80=SE  (corner-pillar variants)
 *
 * Compass mapping cross-checked against the `tileCullingBitsets` /
 * `tileShadowIntensity` writes in `reference/Landscape.java:953..1043`:
 *   face 0 → west wall (extends along x=localX from y..y+1)
 *   face 1 → north wall (extends along y=localY+1 from x..x+1)
 *   face 2 → east wall  (extends along x=localX+1 from y..y+1)
 *   face 3 → south wall (extends along y=localY from x..x+1)
 */
const ROTATION_WALL_TYPE = [0x01, 0x02, 0x04, 0x08] as const;
const ROTATION_WALL_CORNER_TYPE = [0x10, 0x20, 0x40, 0x80] as const;

/**
 * Bake wall-edge / corner-block bits for a single placement.
 *
 *   type 0 (WALL):              `ROTATION_WALL_TYPE[rotation]`
 *   type 1 (WALL_TRI_CORNER):   `ROTATION_WALL_CORNER_TYPE[rotation]`
 *   type 2 (WALL_CORNER):       two adjacent edges
 *                                 `ROTATION_WALL_TYPE[rotation] |
 *                                  ROTATION_WALL_TYPE[(rotation+1)&3]`
 *   type 3 (WALL_RECT_CORNER):  `ROTATION_WALL_CORNER_TYPE[rotation]`
 *   types 4..8 (wall decor):    no edge blocking (decorative; collision
 *                                follows the parent wall, not the decor)
 *   types 9..22 (full-tile):    no edge blocking (consumer applies
 *                                center-tile block via interactType +
 *                                sizeX/Y footprint)
 *
 * If `blockingMask` (cache opcode 79) is non-zero, it overrides this
 * derivation entirely. The override is applied at the call site so the
 * default table stays simple.
 */
function deriveBlockedEdges(origType: number, origRotation: number): number {
  const rot = origRotation & 3;
  switch (origType) {
    case 0: // WALL
      return ROTATION_WALL_TYPE[rot]!;
    case 1: // WALL_TRI_CORNER
      return ROTATION_WALL_CORNER_TYPE[rot]!;
    case 2: // WALL_CORNER (two adjacent edges, faces rot and rot+1)
      return ROTATION_WALL_TYPE[rot]! | ROTATION_WALL_TYPE[(rot + 1) & 3]!;
    case 3: // WALL_RECT_CORNER
      return ROTATION_WALL_CORNER_TYPE[rot]!;
    default:
      return 0;
  }
}

// ---------- Phase 1: resolve ----------

interface ResolvedBlock {
  key: string;
  locId: number;
  modelType: number;
  bakedRotation: number;
  sizeX: number;
  sizeY: number;
  /** Effective ambient/contrast for this loc: base 64/768 +
   *  `ObjectDefinition.ambient`/`ObjectDefinition.contrast` overrides. */
  ambient: number;
  contrast: number;
  contoured: boolean;
  /** `ObjectDefinition.contouredGround` — for opcode 21 this is 0
   *  (fully deform every vertex), for opcode 81 it's `byte * 256`
   *  (the client treats that as an upper Y-threshold above which
   *  deformation stops; used by trees so the canopy stays stable). */
  contouredThreshold: number;
  /** Phase 1 def-level passthroughs. All optional except `interactType`
   *  (0 default). Cleaned up in `pushBlock` — the JSON only carries them
   *  when meaningfully different from defaults. */
  defFields: {
    interactType: number;
    name?: string;
    obstructsGround?: boolean;
    /** Only persisted when `false` (default true). */
    shadow?: false;
    hollow?: boolean;
    supportsItems?: number;
    /** Default 16; only persisted when different. */
    decorDisplacement?: number;
    wallOrDoor?: number;
    mapSceneID?: number;
    mapAreaId?: number;
    randomizeAnimStart?: boolean;
    /** Phase 2: cache opcode 79 blockingMask override. Default 0 (use the
     *  type-derived bits). Only persisted on LocBlock when non-zero. */
    blockingMask?: number;
  };
  /** The *base* model, pre-animation. For animated blocks the caller
   *  clones vertex positions per-frame and applies the matching frame;
   *  for static blocks this is just the final model. */
  model: ModelDefinition;
  /** Non-null only when the loc has `animationID >= 0` *and* we can apply
   *  it (bakedRotation 0..3, vertexGroups present, frames fetch clean).
   *  Stores the frames in order — each element has a copy of the base
   *  model's vertex arrays with that frame's transforms applied, and
   *  the per-frame duration in client-frame units (20 ms each). */
  animationFrames?: AnimationFrameBake[];
  /** Mirrors `SequenceDefinition.frameStep`. Only meaningful when
   *  `animationFrames` is set; otherwise leave undefined. -1 means "play
   *  once and freeze" in the OSRS client. See LocBlockAnimation.frameStep
   *  for the full regime table. */
  animationFrameStep?: number;
}

interface AnimationFrameBake {
  /** Vertex positions (client-space, pre-Y/Z flip) for this frame after
   *  applying the frame transforms and post-rotation. */
  vx: number[];
  vy: number[];
  vz: number[];
  /** Duration in client-frame units (20ms each). */
  ticks: number;
}

export interface LocsPlan {
  regionX: number;
  regionZ: number;
  locDef: LocationDefinition | undefined;
  blocks: ResolvedBlock[];
  blockIndexByKey: Map<string, number>;
  skippedLocIds: Set<number>;
  skipReasons: { noDef: number; noModel: number; emptyModel: number; error: number };
  /** Number of *blocks* that had frame-0 animation successfully baked into
   *  vertex positions. Diagnostic only. */
  animatedBlockCount: number;
  /** Phase 5: per-source-locId morph spec, captured during `prepareLocs` from
   *  `objDef.varbitID/varpID/configChangeDest`. Empty when the region has
   *  no morphing locs (most regions). Each alternate locId in the spec
   *  has its blocks already resolved into `blocks` via the same
   *  `(modelType, bakedRotation)` set as the source loc. */
  morphs: Map<number, { varKind: "varbit" | "varp"; varId: number; alternates: number[] }>;
  /** One-shot census over unique locIds that appeared in the region. Counts
   *  *unique defs* with each feature set, not placements — use the raw
   *  numbers as a cost/benefit signal before implementing a new field. */
  defCensus: {
    uniqueDefs: number;
    obstructsGround: number;
    mergeNormals: number;
    shadowSuppressed: number;
    animationId: number;
    varbit: number;
    customDecorDisplacement: number;
    contoured: number;
    contouredThresholded: number;
  };
}

/**
 * Bake every frame of a sequence into vertex-position arrays. Each frame is
 * computed from the *original* (pre-animation) model — applying frame N to
 * an already-animated model would accumulate transforms.
 *
 * Frame 0 is also included (so the viewer can uniformly address frames
 * 0..N-1). Colors / UVs / faces aren't recomputed — they carry over from
 * the base model, which `flattenModel` will later emit unchanged. A naive
 * "re-run lighting per frame" is possible but costs 4× the bundle
 * (colors + uvs + positions + frame-specific lighting) and OSRS scenery
 * animations are almost all rotations (mills, cranes) where the face
 * normals change little enough that the frame-0 lighting reads fine.
 */
async function bakeAnimationFrames(
  cache: RSCache,
  model: ModelDefinition,
  seq: SequenceDefinition,
  bakedRotation: number,
): Promise<AnimationFrameBake[] | undefined> {
  const frameIds = seq.frameIDs;
  if (!frameIds || frameIds.length === 0) return undefined;
  // Snapshot the base vertex arrays before any frame applies.
  const baseX = Array.from(model.vertexPositionsX as ArrayLike<number>);
  const baseY = Array.from(model.vertexPositionsY as ArrayLike<number>);
  const baseZ = Array.from(model.vertexPositionsZ as ArrayLike<number>);
  const frames: AnimationFrameBake[] = [];
  for (let i = 0; i < frameIds.length; i++) {
    const packed = frameIds[i]!;
    const frameArchive = packed >>> 16;
    const frameIndex = packed & 0xffff;
    let frame: FramesDefinition | null = null;
    try {
      frame = ((await cache.getDef(
        IndexType.FRAMES,
        frameArchive,
        frameIndex,
      )) as FramesDefinition | undefined) ?? null;
    } catch (e) {
      console.warn(
        `[anim] seq ${seq.id} frame ${i} (${frameArchive}/${frameIndex}) load failed: ${(e as Error).message}`,
      );
      return undefined; // Abort; don't emit a partially-animated block.
    }
    if (!frame || !frame.framemap) return undefined;
    // Reset the model's vertex arrays to the base pose, apply this frame,
    // rotate, snapshot.
    (model.vertexPositionsX as number[]) = baseX.slice();
    (model.vertexPositionsY as number[]) = baseY.slice();
    (model.vertexPositionsZ as number[]) = baseZ.slice();
    applyFramePose(model, frame);
    rotateModelVertices(model, bakedRotation);
    frames.push({
      vx: Array.from(model.vertexPositionsX as ArrayLike<number>),
      vy: Array.from(model.vertexPositionsY as ArrayLike<number>),
      vz: Array.from(model.vertexPositionsZ as ArrayLike<number>),
      ticks: seq.frameLengths?.[i] ?? 1,
    });
  }
  return frames;
}

/** Resolve all unique (locId, modelType, bakedRotation) combinations → models. */
export async function prepareLocs(cache: RSCache, regionX: number, regionZ: number): Promise<LocsPlan> {
  console.log(`[locs] getLoc(${regionX}, ${regionZ})`);
  let locDef: LocationDefinition | undefined;
  try {
    locDef = await cache.getLoc(regionX, regionZ);
  } catch (e) {
    console.warn(`[locs] getLoc failed: ${(e as Error).message}`);
  }
  const emptyCensus = {
    uniqueDefs: 0,
    obstructsGround: 0,
    mergeNormals: 0,
    shadowSuppressed: 0,
    animationId: 0,
    varbit: 0,
    customDecorDisplacement: 0,
    contoured: 0,
    contouredThresholded: 0,
  };
  if (!locDef || !locDef.locations || locDef.locations.length === 0) {
    console.warn(`[locs] no location data for region (${regionX}, ${regionZ})`);
    return {
      regionX,
      regionZ,
      locDef: undefined,
      blocks: [],
      blockIndexByKey: new Map(),
      skippedLocIds: new Set(),
      skipReasons: { noDef: 0, noModel: 0, emptyModel: 0, error: 0 },
      animatedBlockCount: 0,
      defCensus: emptyCensus,
      morphs: new Map(),
    };
  }
  console.log(`[locs] ${locDef.locations.length} placements`);

  const drawKey = (locId: number, modelType: number, bakedRotation: number): string =>
    `${locId}:${modelType}:${bakedRotation}`;
  const uniqueDraws = new Map<string, { locId: number } & BlockDraw>();
  for (const p of locDef.locations) {
    for (const draw of expandPlacement(p.type, p.orientation)) {
      uniqueDraws.set(drawKey(p.id, draw.modelType, draw.bakedRotation), { locId: p.id, ...draw });
    }
  }
  console.log(`[locs] ${uniqueDraws.size} unique (locId, modelType, rotation) blocks`);

  const blocks: ResolvedBlock[] = [];
  const blockIndexByKey = new Map<string, number>();
  const skippedLocIds = new Set<number>();
  const skipReasons = { noDef: 0, noModel: 0, emptyModel: 0, error: 0 };
  const defCensus = { ...emptyCensus };
  const censusedDefs = new Set<number>();

  const defCache = new Map<number, ObjectDefinition | null>();
  const getObjDef = async (locId: number): Promise<ObjectDefinition | null> => {
    if (defCache.has(locId)) return defCache.get(locId)!;
    let def: ObjectDefinition | null = null;
    try {
      def = ((await cache.getDef(
        IndexType.CONFIGS,
        ConfigType.OBJECT,
        locId,
      )) as ObjectDefinition | undefined) ?? null;
    } catch (e) {
      console.warn(`[locs] getDef(OBJECT, ${locId}) failed: ${(e as Error).message}`);
    }
    defCache.set(locId, def);
    return def;
  };

  // Phase 5: pre-scan placements for varbit/varp morph defs. For each
  // morphing source locId, expand `uniqueDraws` to also bake every
  // alternate locId at the same (modelType, bakedRotation) the source
  // is drawn at. The viewer then picks one based on var state at runtime.
  // We do this BEFORE the main resolve loop so the alternates ride the
  // same model fetch / atlas pipeline.
  const morphs = new Map<
    number,
    { varKind: "varbit" | "varp"; varId: number; alternates: number[] }
  >();
  // Preserve the per-source draw set so we know which (modelType, rotation)
  // combos to instantiate the alternates with.
  const drawsBySourceLoc = new Map<number, BlockDraw[]>();
  for (const p of locDef.locations) {
    if (!drawsBySourceLoc.has(p.id)) {
      drawsBySourceLoc.set(p.id, expandPlacement(p.type, p.orientation));
    }
  }
  for (const [sourceLocId, draws] of drawsBySourceLoc) {
    const def = await getObjDef(sourceLocId);
    if (!def) continue;
    const dx = def as unknown as {
      varbitID?: number;
      varpID?: number;
      configChangeDest?: number[];
    };
    const dest = dx.configChangeDest;
    if (!dest || dest.length === 0) continue;
    // Either varbit or varp may be set (-1 if not). Prefer varbit (the
    // OSRS client checks varbit first; varp is the fallback for older
    // morph defs).
    const hasVarbit = dx.varbitID !== undefined && dx.varbitID >= 0;
    const hasVarp = dx.varpID !== undefined && dx.varpID >= 0;
    if (!hasVarbit && !hasVarp) continue;
    const varKind: "varbit" | "varp" = hasVarbit ? "varbit" : "varp";
    const varId = hasVarbit ? dx.varbitID! : dx.varpID!;
    morphs.set(sourceLocId, { varKind, varId, alternates: dest.slice() });
    for (const altLocId of dest) {
      if (altLocId < 0 || altLocId === sourceLocId) continue;
      for (const d of draws) {
        const k = drawKey(altLocId, d.modelType, d.bakedRotation);
        if (!uniqueDraws.has(k)) {
          uniqueDraws.set(k, { locId: altLocId, modelType: d.modelType, bakedRotation: d.bakedRotation });
        }
      }
    }
  }
  if (morphs.size > 0) {
    console.log(`[locs] ${morphs.size} morphing locs; expanded uniqueDraws to ${uniqueDraws.size}`);
  }

  // Per-session cache so we don't re-fetch the same SeqDefinition 20 times.
  const seqCache = new Map<number, SequenceDefinition | null>();
  const getSeqDef = async (id: number): Promise<SequenceDefinition | null> => {
    if (seqCache.has(id)) return seqCache.get(id)!;
    let def: SequenceDefinition | null = null;
    try {
      def = ((await cache.getDef(
        IndexType.CONFIGS,
        ConfigType.SEQUENCE,
        id,
      )) as SequenceDefinition | undefined) ?? null;
    } catch (e) {
      console.warn(`[locs] getDef(SEQUENCE, ${id}) failed: ${(e as Error).message}`);
    }
    seqCache.set(id, def);
    return def;
  };

  let animatedCount = 0;

  for (const [key, draw] of uniqueDraws) {
    const objDef = await getObjDef(draw.locId);
    if (!objDef) {
      skippedLocIds.add(draw.locId);
      skipReasons.noDef++;
      continue;
    }
    // Animated locs need frame 0 baked into vertex positions *before* the
    // model gets rotated. For bakedRotation 0..3 we fetch the unrotated
    // model, apply the frame, then rotate manually. For rotation >= 4 the
    // method1194 / method1206 / changeOffset chain happens inside
    // `getModel` and is painful to undo, so we skip animation and render
    // the static pose. In Lumbridge this only affects diagonal wall
    // decorations, which are rare among animated locs.
    const animationID = objDef.animationID ?? -1;
    const canAnimate = animationID >= 0 && (draw.bakedRotation & ~3) === 0;
    let model: ModelDefinition | null = null;
    try {
      const rotationForFetch = canAnimate ? 0 : draw.bakedRotation;
      model = await objDef.getModel(cache, draw.modelType, rotationForFetch);
    } catch (e) {
      console.warn(
        `[locs] getModel(${draw.locId}, mt=${draw.modelType}, rot=${draw.bakedRotation}) threw: ${(e as Error).message}`,
      );
      skipReasons.error++;
    }
    // Bake animation frames, if applicable. The base model we just
    // fetched is at rotation=0 (for animated locs) — we clone its vertex
    // positions per frame, apply the frame's transforms, then rotate to
    // match bakedRotation. The frames are stored on the ResolvedBlock
    // and serialised by `emitLocs` into a separate `locs.frames.pos.bin`
    // blob for the viewer to swap between at runtime.
    //
    // Two sub-cases:
    //  - seq has ≥2 frames → full animation bake (viewer cycles through).
    //  - seq has exactly 1 frame → apply that frame's pose to the model
    //    so the static render matches the client's "idle" pose, but don't
    //    emit animation data (nothing to cycle).
    //
    // Earlier code bailed for 1-frame sequences and lost the idle pose
    // entirely, leaving the unanimated default visible — that's why the
    // pose Aaron saw before animation landed disappeared for some locs.
    let animationFrames: AnimationFrameBake[] | undefined;
    let animationFrameStep: number | undefined;
    if (canAnimate && model) {
      const seq = await getSeqDef(animationID);
      const frameIds = seq?.frameIDs;
      if (seq && frameIds && frameIds.length >= 1 && model.vertexGroups) {
        const bakedFrames = await bakeAnimationFrames(
          cache,
          model,
          seq,
          draw.bakedRotation,
        );
        if (bakedFrames && bakedFrames.length >= 2) {
          animationFrames = bakedFrames;
          // SequenceLoader defaults frameStep to -1 when opcode 2 is absent,
          // matching the client. Pass it through verbatim — the viewer's
          // tick loop interprets it.
          animationFrameStep = seq.frameStep ?? -1;
          animatedCount++;
        } else if (bakedFrames && bakedFrames.length === 1) {
          // Idle-pose sequence: commit frame 0 to the model so the next
          // flattenModel picks up its vertex positions. No `animation`
          // field on the block — viewer treats it as static.
          const f0 = bakedFrames[0]!;
          (model.vertexPositionsX as number[]) = f0.vx;
          (model.vertexPositionsY as number[]) = f0.vy;
          (model.vertexPositionsZ as number[]) = f0.vz;
        }
      }
      // For any "no animation baked" case (no seq, 0-frame seq, fetch
      // failure), still apply the bakedRotation so the static pose
      // matches a non-animated loc. When animation WAS baked,
      // bakeAnimationFrames already rotated each frame.
      if (!animationFrames) {
        rotateModelVertices(model, draw.bakedRotation);
      }
    }
    if (!model) {
      skippedLocIds.add(draw.locId);
      skipReasons.noModel++;
      continue;
    }
    if (model.faceVertexIndices1.length === 0) {
      skippedLocIds.add(draw.locId);
      skipReasons.emptyModel++;
      continue;
    }
    applyFaceColorSubstitution(model, objDef.recolorToFind, objDef.recolorToReplace);
    applyFaceTextureSubstitution(model, objDef.retextureToFind, objDef.textureToReplace);

    // Def-level census — count unique defs (not blocks or placements) with
    // each feature set. Tells us whether to invest in supporting the field
    // before porting the client code. Census is stable across rotations
    // since all blocks for a given locId share the def.
    if (!censusedDefs.has(draw.locId)) {
      censusedDefs.add(draw.locId);
      defCensus.uniqueDefs++;
      const d = objDef as unknown as {
        obstructsGround?: boolean;
        mergeNormals?: boolean;
        shadow?: boolean;
        animationID?: number;
        varbitID?: number;
        varpID?: number;
        decorDisplacement?: number;
        contouredGround?: number;
      };
      if (d.obstructsGround) defCensus.obstructsGround++;
      if (d.mergeNormals) defCensus.mergeNormals++;
      // `shadow === false` means "no shadow" (opcode 64); default is true.
      if (d.shadow === false) defCensus.shadowSuppressed++;
      if (d.animationID !== undefined && d.animationID >= 0) defCensus.animationId++;
      if ((d.varbitID !== undefined && d.varbitID >= 0) ||
          (d.varpID !== undefined && d.varpID >= 0)) defCensus.varbit++;
      if (d.decorDisplacement !== undefined && d.decorDisplacement !== 16) {
        defCensus.customDecorDisplacement++;
      }
      if (d.contouredGround !== undefined) defCensus.contoured++;
      if (d.contouredGround !== undefined && d.contouredGround > 0) defCensus.contouredThresholded++;
    }

    blockIndexByKey.set(key, blocks.length);
    // Per-loc lighting overrides. The cache stores `ambient` as a raw
    // signed byte and `contrast` as `byte × 25` (the loader applies the
    // ×25 when parsing opcode 39). Both are offsets from the baseline the
    // client calls `Model.light` with (64 / 768) — a positive ambient
    // lightens the loc, a negative darkens it.
    const ambientOverride = (objDef as unknown as { ambient?: number }).ambient ?? 0;
    const contrastOverride = (objDef as unknown as { contrast?: number }).contrast ?? 0;
    const rawContour = (objDef as unknown as { contouredGround?: number }).contouredGround;
    const contoured = rawContour !== undefined;
    // Phase 1 def-level passthroughs. `objDef` is typed minimally in our
    // ambient declarations; broaden via cast so we can reach the rarer
    // opcodes (loader populates them, type defs just don't list them all).
    const dx = objDef as unknown as {
      name?: string;
      interactType?: number;
      obstructsGround?: boolean;
      shadow?: boolean;
      hollow?: boolean;
      supportsItems?: number;
      decorDisplacement?: number;
      wallOrDoor?: number;
      mapSceneID?: number;
      mapAreaId?: number;
      randomizeAnimStart?: boolean;
      blockingMask?: number;
    };
    // Cache defaults set by osrscachereader's ObjectDefinition constructor
    // (verified against
    // node_modules/osrscachereader/src/cacheReader/loaders/ObjectLoader.js):
    //   interactType = 2  (blocks player + projectiles)
    //   wallOrDoor = -1   (no wall/door semantics)
    //   mapSceneID = -1   (no minimap icon)
    //   supportsItems = -1 (no item-on-loc support)
    //   mapAreaId = -1    (no area tag)
    //   decorDisplacement default = 16
    // Persist into the bundle only when the cache opcode actually fired —
    // i.e. when the field deviates from these defaults. Saves ~80 KB on
    // Lumbridge's locs.debug.json.
    const defFields: ResolvedBlock["defFields"] = {
      interactType: dx.interactType ?? 2,
    };
    if (dx.name !== undefined) defFields.name = dx.name;
    if (dx.obstructsGround) defFields.obstructsGround = true;
    if (dx.shadow === false) defFields.shadow = false;
    if (dx.hollow) defFields.hollow = true;
    if (dx.supportsItems !== undefined && dx.supportsItems !== -1) {
      defFields.supportsItems = dx.supportsItems;
    }
    if (dx.decorDisplacement !== undefined && dx.decorDisplacement !== 16) {
      defFields.decorDisplacement = dx.decorDisplacement;
    }
    if (dx.wallOrDoor !== undefined && dx.wallOrDoor !== -1) {
      defFields.wallOrDoor = dx.wallOrDoor;
    }
    if (dx.mapSceneID !== undefined && dx.mapSceneID !== -1) {
      defFields.mapSceneID = dx.mapSceneID;
    }
    if (dx.mapAreaId !== undefined && dx.mapAreaId !== -1) {
      defFields.mapAreaId = dx.mapAreaId;
    }
    if (dx.randomizeAnimStart) defFields.randomizeAnimStart = true;
    if (dx.blockingMask !== undefined && dx.blockingMask !== 0) {
      defFields.blockingMask = dx.blockingMask;
    }

    blocks.push({
      key,
      locId: draw.locId,
      modelType: draw.modelType,
      bakedRotation: draw.bakedRotation,
      sizeX: objDef.sizeX ?? 1,
      sizeY: objDef.sizeY ?? 1,
      ambient: BASE_AMBIENT + ambientOverride,
      contrast: BASE_CONTRAST + contrastOverride,
      contoured,
      contouredThreshold: rawContour ?? 0,
      defFields,
      model,
      animationFrames,
      animationFrameStep,
    });
    // If we baked animation frames, overwrite the base model's vertex
    // positions with frame 0 so static emission (flattenModel) renders
    // frame 0 as the default pose. Other frames live in animationFrames
    // and are written to the frames blob by emitLocs.
    if (animationFrames && animationFrames.length > 0) {
      const f0 = animationFrames[0]!;
      (model.vertexPositionsX as number[]) = f0.vx;
      (model.vertexPositionsY as number[]) = f0.vy;
      (model.vertexPositionsZ as number[]) = f0.vz;
    }
  }

  return {
    regionX,
    regionZ,
    locDef,
    blocks,
    blockIndexByKey,
    skippedLocIds,
    skipReasons,
    animatedBlockCount: animatedCount,
    defCensus,
    morphs,
  };
}

/** Every texture id referenced by any loc face in the resolved plan. */
export function collectLocsTextureIds(plan: LocsPlan): Set<number> {
  const ids = new Set<number>();
  for (const block of plan.blocks) {
    const ft = block.model.faceTextures;
    if (!ft) continue;
    for (let i = 0; i < ft.length; i++) {
      const t = ft[i] as number;
      if (t >= 0) ids.add(t);
    }
  }
  return ids;
}

// ---------- Phase 2: emit ----------

export interface BakedLocs {
  manifest: LocsManifest;
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  /** Packed frame positions for animated blocks. Absent (length 0) if no
   *  animated blocks survived the bake. */
  framesPositions: Float32Array;
  debug: LocsDebug;
}


/**
 * Convert one resolved loc model to non-indexed triangle soup + vertex colors
 * + atlas UVs. Textured faces project their vertices onto the model's texture
 * triangle to get per-vertex (u, v) in texture space, which we then remap to
 * the face's assigned atlas cell.
 */
function flattenModel(
  model: ModelDefinition,
  atlas: BakedAtlas,
  ambient: number,
  contrast: number,
): {
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
} {
  const faceCount = model.faceVertexIndices1.length;
  const vertCount = faceCount * 3;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Uint8Array(vertCount * 4);
  const uvs = new Float32Array(vertCount * 2);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const atlasSize = atlas.manifest.atlasSize;
  const cellsPerRow = atlas.manifest.cellsPerRow;
  const cellSize = atlas.manifest.cellSize;
  const gutter = atlas.manifest.gutter ?? 0;


  for (let i = 0; i < faceCount; i++) {
    const a = model.faceVertexIndices1[i] as number;
    const b = model.faceVertexIndices2[i] as number;
    const c = model.faceVertexIndices3[i] as number;

    // Convert OSRS left-handed (+X east, +Y down, +Z north) to our
    // Three.js-compat space (+X east, +Y up, +Z south). Negate Y and Z.
    const ax = model.vertexPositionsX[a] as number;
    const ay = -(model.vertexPositionsY[a] as number);
    const az = -(model.vertexPositionsZ[a] as number);
    const bx = model.vertexPositionsX[b] as number;
    const by = -(model.vertexPositionsY[b] as number);
    const bz = -(model.vertexPositionsZ[b] as number);
    const cx = model.vertexPositionsX[c] as number;
    const cy = -(model.vertexPositionsY[c] as number);
    const cz = -(model.vertexPositionsZ[c] as number);

    const off = i * 9;
    positions[off + 0] = ax; positions[off + 1] = ay; positions[off + 2] = az;
    positions[off + 3] = bx; positions[off + 4] = by; positions[off + 5] = bz;
    positions[off + 6] = cx; positions[off + 7] = cy; positions[off + 8] = cz;

    for (const [px, py, pz] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] as [number, number, number][]) {
      if (px < min[0]) min[0] = px;
      if (py < min[1]) min[1] = py;
      if (pz < min[2]) min[2] = pz;
      if (px > max[0]) max[0] = px;
      if (py > max[1]) max[1] = py;
      if (pz > max[2]) max[2] = pz;
    }

    // Lighting uses CLIENT-space positions (pre-Y/Z-flip) so the client's
    // light direction constants apply directly. Computing it on the flipped
    // positions would require flipping the light vector too; easier to do
    // it once on raw data.
    const rax = model.vertexPositionsX[a] as number;
    const ray = model.vertexPositionsY[a] as number;
    const raz = model.vertexPositionsZ[a] as number;
    const rbx = model.vertexPositionsX[b] as number;
    const rby = model.vertexPositionsY[b] as number;
    const rbz = model.vertexPositionsZ[b] as number;
    const rcx = model.vertexPositionsX[c] as number;
    const rcy = model.vertexPositionsY[c] as number;
    const rcz = model.vertexPositionsZ[c] as number;
    const e1x = rbx - rax, e1y = rby - ray, e1z = rbz - raz;
    const e2x = rcx - rax, e2y = rcy - ray, e2z = rcz - raz;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const lightness = faceLightness(nx, ny, nz, ambient, contrast);

    // Color + texture selection per face.
    const faceTexId = (model.faceTextures?.[i] as number | undefined) ?? -1;
    const faceHsl = (model.faceColors?.[i] as number) ?? 0;
    const faceRenderType =
      ((model as unknown as { faceRenderTypes?: ArrayLike<number> }).faceRenderTypes?.[i] as
        | number
        | undefined) ?? -1;
    // `osrscachereader` reads `faceAlphas` with `readInt8()` on modern caches,
    // so signed sentinels come through as-is: -1 = hide the face,
    // -2 = "force textured-flat, treat as opaque". rs-map-viewer handles
    // these in `ModelData.light()` before the render-type branch. Positive
    // values 0..254 are regular alpha (0 = opaque, 255 = invisible); the
    // `>= 255` skip catches the upper bound. Without the sentinel branch
    // arithmetic quietly wraps in `Uint8Array`: `255 - (-1) = 256 → 0`
    // (accidentally correct) and `255 - (-2) = 257 → 1` (wrong — hides
    // a face that should render).
    const faceAlpha = (model.faceAlphas?.[i] as number | undefined) ?? 0;
    if (faceAlpha === -1) continue;
    const effectiveAlpha = faceAlpha < 0 ? 0 : faceAlpha;
    if (effectiveAlpha >= 255) continue;
    const vertexAlpha = 255 - effectiveAlpha;
    const uvOff = i * 6;
    const coff = i * 12;

    // faceRenderTypes[i] === 2 is the "hide this face" sentinel set by
    // `ModelData.mergeNormals` on occluded faces — ones whose vertices
    // are all shared with an adjacent model (roof abutments, wall joins).
    // rs-map-viewer resolves this in `ModelData.light()` to the
    // `faceColors3[i] = -2` skip-sentinel. Positions for this face were
    // already written above; leaving colors (incl. alpha) and UVs
    // zero-init makes the material's `alphaTest: 0.01` discard them.
    // See memory/face_render_types.md.
    if (faceRenderType === 2) continue;

    // Lit HSL = method816 on the face's stored HSL. For textured faces,
    // this is the tint that multiplies the sampled texel; for untextured
    // faces, this IS the final color (texture is white cell 0).
    const litHsl = applyLightToHsl(faceHsl, lightness);
    const [litR, litG, litB] = hsl16ToRgb(litHsl);

    if (faceTexId >= 0) {
      const cell = atlas.manifest.cellByTextureId[faceTexId];
      if (cell !== undefined) {
        const [tu0, tv0, tu1, tv1, tu2, tv2] = computeFaceUv(model, i);
        const [u0, v0] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu0, tv0);
        const [u1, v1] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu1, tv1);
        const [u2, v2] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu2, tv2);
        uvs[uvOff + 0] = u0; uvs[uvOff + 1] = v0;
        uvs[uvOff + 2] = u1; uvs[uvOff + 3] = v1;
        uvs[uvOff + 4] = u2; uvs[uvOff + 5] = v2;

        for (let k = 0; k < 3; k++) {
          colors[coff + k * 4 + 0] = litR;
          colors[coff + k * 4 + 1] = litG;
          colors[coff + k * 4 + 2] = litB;
          colors[coff + k * 4 + 3] = vertexAlpha;
        }
        continue;
      }
      // Texture not in atlas — fall through to color path.
    }

    // Untextured face: sample atlas cell 0 (white), vertex color drives appearance.
    const [u0w, v0w] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, 0, 0.5, 0.5);
    uvs[uvOff + 0] = u0w; uvs[uvOff + 1] = v0w;
    uvs[uvOff + 2] = u0w; uvs[uvOff + 3] = v0w;
    uvs[uvOff + 4] = u0w; uvs[uvOff + 5] = v0w;

    colors[coff + 0] = litR; colors[coff + 1] = litG; colors[coff + 2] = litB; colors[coff + 3] = vertexAlpha;
    colors[coff + 4] = litR; colors[coff + 5] = litG; colors[coff + 6] = litB; colors[coff + 7] = vertexAlpha;
    colors[coff + 8] = litR; colors[coff + 9] = litG; colors[coff + 10] = litB; colors[coff + 11] = vertexAlpha;
  }

  if (!Number.isFinite(min[0])) {
    return { positions, colors, uvs, bbox: { min: [0, 0, 0], max: [0, 0, 0] } };
  }
  return { positions, colors, uvs, bbox: { min, max } };
}

/**
 * Padding ring in tiles around the center region in `sceneHeights`. Must
 * match `SCENE_PAD` in `region/terrain.ts`. Gives contoured-loc vertices up
 * to 5 tiles of headroom past each region edge before they fall back to
 * edge clamping.
 */
const SCENE_PAD = 5;
const SCENE_SIZE = TILES_PER_SIDE + 2 * SCENE_PAD;

/**
 * Bilinear terrain-height sample at an arbitrary client-space (x, z) against
 * the 74×74 *padded* scene-heights grid built in `terrain.ts`. The grid's
 * px,pz ∈ [0..73] with the center region at px,pz ∈ [5..69], so we offset
 * tile indices by `SCENE_PAD` before lookup.
 *
 * `clientX/Z` may fall outside the center region (contoured locs whose
 * geometry reaches into a neighbor) — that's exactly what the 5-tile
 * padding is for. Past the padded ring we clamp to the edge, matching the
 * client's behavior at the scene boundary.
 */
function sampleTerrainHeight(
  sceneHeights: number[][][],
  plane: number,
  clientX: number,
  clientZ: number,
): number {
  const txUnclamped = Math.floor(clientX / TILE_SIZE);
  const tzUnclamped = Math.floor(clientZ / TILE_SIZE);
  const px = Math.max(0, Math.min(SCENE_SIZE - 1, txUnclamped + SCENE_PAD));
  const pz = Math.max(0, Math.min(SCENE_SIZE - 1, tzUnclamped + SCENE_PAD));
  const fx = Math.max(0, Math.min(1, (clientX - txUnclamped * TILE_SIZE) / TILE_SIZE));
  const fz = Math.max(0, Math.min(1, (clientZ - tzUnclamped * TILE_SIZE) / TILE_SIZE));
  const plane0 = sceneHeights[plane] ?? sceneHeights[0]!;
  const sw = plane0[px]?.[pz] ?? 0;
  const se = plane0[px + 1]?.[pz] ?? sw;
  const nw = plane0[px]?.[pz + 1] ?? sw;
  const ne = plane0[px + 1]?.[pz + 1] ?? sw;
  return sw * (1 - fx) * (1 - fz) + se * fx * (1 - fz) + nw * (1 - fx) * fz + ne * fx * fz;
}

/**
 * Deform a model's vertices so its base follows the terrain under each
 * vertex's XZ. Port of `ModelData.contourGround` (type 1 + type 2) from
 * `dennisdev/rs-map-viewer`, which itself follows the OSRS client.
 *
 * - **Opcode 21 (param = 0):** every vertex gets the full terrain delta.
 *   Used by fences / short ground scenery — the entire model follows the
 *   slope.
 * - **Opcode 81 (param = byte × 256):** linear falloff in ratio-space.
 *   `yRatio = (vy << 16) / -modelHeight` runs from 0 at the ground to
 *   65536 at the highest vertex. Vertices with `yRatio < param` receive
 *   `deltaH × (param - yRatio) / param`; vertices above stay rigid. This
 *   lets tree canopies sit still while the trunk base tracks the ground.
 *
 * Sign note: after the Y/Z flip in flattenModel, a vertex lands at world Y
 * `wy_placement - vy`. Since `wy_placement = terrain_at_origin`, we want
 * `vy_new = vy_old − deltaH × scale`. Client Y is negative-up, so
 * "the ground rises by deltaH" means we *subtract* in client Y.
 *
 * Returns a shallow clone with only `vertexPositionsY` replaced. Everything
 * else (faces, UVs, colors, textures) keeps pointing at the original
 * arrays. Each contoured placement emits its own block geometry — instancing
 * would be a lie because the deformation is per-placement.
 */
function deformContouredModel(
  model: ModelDefinition,
  clientOriginX: number,
  clientOriginZ: number,
  plane: number,
  threshold: number,
  terrainHeights: number[][][],
): ModelDefinition {
  const vertexCount = model.vertexCount;
  const originH = sampleTerrainHeight(terrainHeights, plane, clientOriginX, clientOriginZ);

  // modelHeight = max of `-vy` across all vertices — i.e., the model's
  // highest point above its local origin. Matches rs-map-viewer's
  // `ModelData.height` (see `method822` in reference/Model.java line 1767).
  let modelHeight = 0;
  for (let v = 0; v < vertexCount; v++) {
    const vy = model.vertexPositionsY[v] as number;
    if (-vy > modelHeight) modelHeight = -vy;
  }

  const newY = new Int32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const vx = model.vertexPositionsX[v] as number;
    const vy = model.vertexPositionsY[v] as number;
    const vz = model.vertexPositionsZ[v] as number;

    let scale: number;
    if (threshold <= 0) {
      scale = 1; // opcode 21: deform every vertex fully
    } else if (modelHeight <= 0) {
      scale = 0; // degenerate model; nothing to deform
    } else {
      // Fixed-point ratio in [0, 65536]. A vertex at the top of the model
      // (vy = -modelHeight) has yRatio = 65536; a vertex at the ground
      // (vy = 0) has yRatio = 0.
      const yRatio = ((vy * 65536) / -modelHeight) | 0;
      if (yRatio >= threshold) {
        scale = 0;
      } else {
        scale = (threshold - yRatio) / threshold;
      }
    }

    if (scale === 0) {
      newY[v] = vy;
      continue;
    }

    const hereH = sampleTerrainHeight(terrainHeights, plane, clientOriginX + vx, clientOriginZ + vz);
    const deltaH = hereH - originH;
    newY[v] = Math.round(vy - deltaH * scale);
  }
  return { ...model, vertexPositionsY: newY };
}

/**
 * Client-space XZ of a placement's world origin — i.e. the point in the
 * cache's coordinate system that the model's local (0,0,0) gets mapped to
 * before per-vertex transforms. Mirrors the logic in `placeLocs.ts`
 * (`isBoundingBoxed` NORMAL/NORMAL_DIAGIONAL centers on the object's
 * bounding box; everything else on the tile center). We don't apply the
 * wall-decoration displacement here because wall decos aren't contoured.
 */
function clientOriginForPlacement(
  tileX: number,
  tileZ: number,
  origType: number,
  origRotation: number,
  blockSizeX: number,
  blockSizeY: number,
): { x: number; z: number } {
  const isBoundingBoxed = origType === 10 || origType === 11;
  let sx = blockSizeX;
  let sy = blockSizeY;
  if (isBoundingBoxed && (origRotation === 1 || origRotation === 3)) {
    const t = sx;
    sx = sy;
    sy = t;
  }
  const cellsX = isBoundingBoxed ? sx : 1;
  const cellsZ = isBoundingBoxed ? sy : 1;
  return {
    x: tileX * TILE_SIZE + (cellsX * TILE_SIZE) / 2,
    z: tileZ * TILE_SIZE + (cellsZ * TILE_SIZE) / 2,
  };
}

/**
 * Re-run `flattenModel`'s position-only stage using alternate vertex arrays.
 * Writes per-face positions in the same layout as `flattenModel.positions`
 * (non-indexed triangle soup, `faceCount × 3 × 3` floats, with the Y/Z
 * client-space flip baked in). Used to emit each animation frame's positions
 * for runtime swap — colors and UVs stay from frame 0.
 */
function flattenPositionsFor(
  model: ModelDefinition,
  vx: ArrayLike<number>,
  vy: ArrayLike<number>,
  vz: ArrayLike<number>,
): Float32Array {
  const faceCount = model.faceVertexIndices1.length;
  const positions = new Float32Array(faceCount * 9);
  for (let i = 0; i < faceCount; i++) {
    const a = model.faceVertexIndices1[i] as number;
    const b = model.faceVertexIndices2[i] as number;
    const c = model.faceVertexIndices3[i] as number;
    const off = i * 9;
    positions[off + 0] = vx[a] as number;
    positions[off + 1] = -(vy[a] as number);
    positions[off + 2] = -(vz[a] as number);
    positions[off + 3] = vx[b] as number;
    positions[off + 4] = -(vy[b] as number);
    positions[off + 5] = -(vz[b] as number);
    positions[off + 6] = vx[c] as number;
    positions[off + 7] = -(vy[c] as number);
    positions[off + 8] = -(vz[c] as number);
  }
  return positions;
}

/** Phase 2: serialize resolved blocks + placements into a bundle. */
export function emitLocs(
  plan: LocsPlan,
  atlas: BakedAtlas,
  terrainHeights: number[][][],
): BakedLocs {
  const blocks: LocBlock[] = [];
  const positionsChunks: Float32Array[] = [];
  const colorsChunks: Uint8Array[] = [];
  const uvsChunks: Float32Array[] = [];
  const framesChunks: Float32Array[] = [];
  let posByteCursor = 0;
  let colByteCursor = 0;
  let uvByteCursor = 0;
  let framesByteCursor = 0;

  const debugBlocks: LocDebugBlock[] = [];
  const pushBlock = (
    rb: ResolvedBlock,
    flat: ReturnType<typeof flattenModel>,
  ): number => {
    const vertexCount = flat.positions.length / 3;
    const blockIndex = blocks.length;
    let animation: LocBlock["animation"] | undefined;
    // Animated blocks: every frame gets flattened into the frames blob
    // (including frame 0, which is redundant with the main positions blob
    // but lets the viewer index frames uniformly). Each frame is `flat
    // .positions.byteLength` bytes; cost is ~0.5 MB per region in
    // practice. Contoured-+-animated is rare enough that we don't worry
    // about compounding their bundle costs.
    if (rb.animationFrames && rb.animationFrames.length >= 2) {
      const framesByteOffset = framesByteCursor;
      for (const frame of rb.animationFrames) {
        const framePositions = flattenPositionsFor(rb.model, frame.vx, frame.vy, frame.vz);
        framesChunks.push(framePositions);
        framesByteCursor += framePositions.byteLength;
      }
      animation = {
        frameCount: rb.animationFrames.length,
        frameTicks: rb.animationFrames.map((f) => f.ticks),
        framesByteOffset,
        frameStep: rb.animationFrameStep ?? -1,
        randomizePhase: rb.defFields.randomizeAnimStart === true,
      };
    }
    blocks.push({
      locId: rb.locId,
      modelType: rb.modelType,
      bakedRotation: rb.bakedRotation,
      sizeX: rb.sizeX,
      sizeY: rb.sizeY,
      contoured: rb.contoured,
      vertexCount,
      positionsByteOffset: posByteCursor,
      colorsByteOffset: colByteCursor,
      uvsByteOffset: uvByteCursor,
      bboxMin: flat.bbox.min,
      bboxMax: flat.bbox.max,
      interactType: rb.defFields.interactType,
      ...(rb.defFields.blockingMask !== undefined
        ? { blockingMask: rb.defFields.blockingMask }
        : {}),
      animation,
    });
    const m = rb.model;
    const faceCount = m.faceVertexIndices1.length;
    let texturedFaceCount = 0;
    const distinct = new Set<number>();
    for (let i = 0; i < faceCount; i++) {
      if (m.faceTextures && (m.faceTextures[i] as number) >= 0) texturedFaceCount++;
      if (m.faceColors) distinct.add(m.faceColors[i] as number);
    }
    const df = rb.defFields;
    debugBlocks.push({
      locId: rb.locId,
      modelType: rb.modelType,
      bakedRotation: rb.bakedRotation,
      faceCount,
      texturedFaceCount,
      distinctFaceColors: distinct.size,
      interactType: df.interactType,
      ...(df.name !== undefined ? { name: df.name } : {}),
      ...(df.obstructsGround ? { obstructsGround: true } : {}),
      ...(df.shadow === false ? { shadow: false as const } : {}),
      ...(df.hollow ? { hollow: true } : {}),
      ...(df.supportsItems !== undefined ? { supportsItems: df.supportsItems } : {}),
      ...(df.decorDisplacement !== undefined ? { decorDisplacement: df.decorDisplacement } : {}),
      ...(df.wallOrDoor !== undefined ? { wallOrDoor: df.wallOrDoor } : {}),
      ...(df.mapSceneID !== undefined ? { mapSceneID: df.mapSceneID } : {}),
      ...(df.mapAreaId !== undefined ? { mapAreaId: df.mapAreaId } : {}),
      ...(df.randomizeAnimStart ? { randomizeAnimStart: true } : {}),
    });
    positionsChunks.push(flat.positions);
    colorsChunks.push(flat.colors);
    uvsChunks.push(flat.uvs);
    posByteCursor += flat.positions.byteLength;
    colByteCursor += flat.colors.byteLength;
    uvByteCursor += flat.uvs.byteLength;
    return blockIndex;
  };

  // Non-contoured blocks: one geometry shared by every placement that uses
  // this (locId, modelType, rotation) combo. Emit up-front so the shared
  // index lookup is cheap.
  const sharedBlockByKey = new Map<string, number>();
  const resolvedByKey = new Map<string, ResolvedBlock>();
  for (const rb of plan.blocks) {
    resolvedByKey.set(rb.key, rb);
    if (rb.contoured) continue;
    const flat = flattenModel(rb.model, atlas, rb.ambient, rb.contrast);
    sharedBlockByKey.set(rb.key, pushBlock(rb, flat));
  }

  // One-time census of model-level fields we could support but don't — tells
  // us whether cylindrical/cube/spherical UV projections actually appear in
  // the region before we invest in implementing them. Logged at the end of
  // emitLocs; quietly skipped when all non-zero counts are 0. The
  // def-level census (obstructsGround, animationID, varbitID) lives on
  // `plan.skipReasons`-adjacent counters captured in `prepareLocs`.
  const textureTypeCounts = { type0: 0, type1: 0, type2: 0, type3: 0, other: 0 };
  for (const rb of plan.blocks) {
    const trt = (rb.model as unknown as { textureRenderTypes?: ArrayLike<number> }).textureRenderTypes;
    if (!trt) continue;
    for (let i = 0; i < trt.length; i++) {
      const t = (trt[i] as number) & 0xff;
      if (t === 0) textureTypeCounts.type0++;
      else if (t === 1) textureTypeCounts.type1++;
      else if (t === 2) textureTypeCounts.type2++;
      else if (t === 3) textureTypeCounts.type3++;
      else textureTypeCounts.other++;
    }
  }

  // Placements. Contoured placements each get their own deformed-geometry
  // block (instance count 1). Non-contoured placements reuse the shared
  // block by key.
  const placements: LocPlacement[] = [];
  let contouredPlacementCount = 0;
  if (plan.locDef) {
    for (const p of plan.locDef.locations) {
      for (const draw of expandPlacement(p.type, p.orientation)) {
        const key = `${p.id}:${draw.modelType}:${draw.bakedRotation}`;
        const rb = resolvedByKey.get(key);
        if (!rb) continue;

        let blockIndex: number;
        if (rb.contoured) {
          const origin = clientOriginForPlacement(
            p.position.localX,
            p.position.localY,
            p.type,
            p.orientation,
            rb.sizeX,
            rb.sizeY,
          );
          const deformed = deformContouredModel(
            rb.model,
            origin.x,
            origin.z,
            p.position.height,
            rb.contouredThreshold,
            terrainHeights,
          );
          const flat = flattenModel(deformed, atlas, rb.ambient, rb.contrast);
          blockIndex = pushBlock(rb, flat);
          contouredPlacementCount++;
        } else {
          const sharedIndex = sharedBlockByKey.get(key);
          if (sharedIndex === undefined) continue;
          blockIndex = sharedIndex;
        }

        // Phase 2: derived per-placement edge/corner block bits.
        // `expandPlacement` may have emitted multiple draws per cache
        // record (e.g. WALL_CORNER → two halves), but each draw is one
        // LocPlacement and should report the same blockedEdges since
        // collision is per-cache-record, not per-half. The reference
        // client does this in `Landscape.java:1017`: it calls `addWall`
        // once per cache record with both orientations OR'd in.
        //
        // `blockingMask` (cache opcode 79) overrides the type-derived
        // table when set — applies to every draw of the same record.
        const mask = rb.defFields.blockingMask;
        const blockedEdges =
          mask !== undefined && mask !== 0
            ? mask & 0xff
            : deriveBlockedEdges(p.type, p.orientation);

        placements.push({
          locId: p.id,
          origType: p.type,
          origRotation: p.orientation,
          x: p.position.localX,
          z: p.position.localY,
          plane: p.position.height,
          blockIndex,
          blockedEdges,
        });
      }
    }
  }

  const positions = new Float32Array(posByteCursor / 4);
  const colors = new Uint8Array(colByteCursor);
  const uvs = new Float32Array(uvByteCursor / 4);
  const framesPositions = new Float32Array(framesByteCursor / 4);
  let posOff = 0;
  let colOff = 0;
  let uvOff = 0;
  let framesOff = 0;
  for (let i = 0; i < positionsChunks.length; i++) {
    positions.set(positionsChunks[i]!, posOff);
    colors.set(colorsChunks[i]!, colOff);
    uvs.set(uvsChunks[i]!, uvOff);
    posOff += positionsChunks[i]!.length;
    colOff += colorsChunks[i]!.length;
    uvOff += uvsChunks[i]!.length;
  }
  for (let i = 0; i < framesChunks.length; i++) {
    framesPositions.set(framesChunks[i]!, framesOff);
    framesOff += framesChunks[i]!.length;
  }

  const hasFrames = framesPositions.byteLength > 0;
  // Phase 5: serialise morphs map → JSON-friendly object. Skipped when
  // empty (most regions; Lumbridge had 0 morph defs in earlier census).
  let morphsJson: Record<number, LocMorphSpec> | undefined;
  if (plan.morphs.size > 0) {
    morphsJson = {};
    for (const [sourceLocId, spec] of plan.morphs) {
      morphsJson[sourceLocId] = {
        varKind: spec.varKind,
        varId: spec.varId,
        alternates: spec.alternates.slice(),
      };
    }
  }
  const manifest: LocsManifest = {
    schemaVersion: LOCS_MANIFEST_SCHEMA,
    blocks,
    placements,
    positionsByteLength: positions.byteLength,
    colorsByteLength: colors.byteLength,
    uvsByteLength: uvs.byteLength,
    positionsFile: "locs.pos.bin",
    colorsFile: "locs.col.bin",
    uvsFile: "locs.uv.bin",
    framesFile: hasFrames ? "locs.frames.pos.bin" : undefined,
    framesByteLength: hasFrames ? framesPositions.byteLength : undefined,
    skippedLocIds: Array.from(plan.skippedLocIds).sort((a, b) => a - b),
    ...(morphsJson ? { morphs: morphsJson } : {}),
  };

  // debugBlocks is built up in parallel with `blocks` inside `pushBlock`,
  // so the two arrays share indices — contoured placements each get their
  // own per-placement debug entry.
  const debug: LocsDebug = { schemaVersion: LOCS_DEBUG_SCHEMA, blocks: debugBlocks };

  const r = plan.skipReasons;
  console.log(
    `[locs] ${blocks.length} blocks (${contouredPlacementCount} per-placement contoured, ` +
      `${plan.animatedBlockCount} with frame-0 pose baked), ` +
      `${placements.length} placements, ${plan.skippedLocIds.size} locIds skipped ` +
      `(noDef=${r.noDef} noModel=${r.noModel} empty=${r.emptyModel} err=${r.error})`,
  );
  const t = textureTypeCounts;
  if (t.type1 > 0 || t.type2 > 0 || t.type3 > 0 || t.other > 0) {
    console.log(
      `[locs] textureRenderTypes census: t0=${t.type0} t1=${t.type1} t2=${t.type2} t3=${t.type3} other=${t.other}`,
    );
  }
  const d = plan.defCensus;
  console.log(
    `[locs] defCensus: uniqueDefs=${d.uniqueDefs} ` +
      `obstructsGround=${d.obstructsGround} mergeNormals=${d.mergeNormals} ` +
      `shadowSuppressed=${d.shadowSuppressed} animationId=${d.animationId} ` +
      `varbit=${d.varbit} customDecorDisp=${d.customDecorDisplacement} ` +
      `contoured=${d.contoured} (thresholded=${d.contouredThresholded})`,
  );
  return { manifest, positions, colors, uvs, framesPositions, debug };
}

export async function writeLocsBundle(baked: BakedLocs, outDir: string): Promise<void> {
  await writeFile(join(outDir, baked.manifest.positionsFile), Buffer.from(baked.positions.buffer));
  await writeFile(join(outDir, baked.manifest.colorsFile), Buffer.from(baked.colors.buffer));
  await writeFile(join(outDir, baked.manifest.uvsFile), Buffer.from(baked.uvs.buffer));
  if (baked.manifest.framesFile) {
    await writeFile(
      join(outDir, baked.manifest.framesFile),
      Buffer.from(baked.framesPositions.buffer),
    );
  }
  await writeFile(join(outDir, "locs.json"), JSON.stringify(baked.manifest));
  await writeFile(join(outDir, "locs.debug.json"), JSON.stringify(baked.debug));
  const framesKb = baked.manifest.framesByteLength
    ? ` + ${(baked.manifest.framesByteLength / 1024).toFixed(1)} KB anim-frames`
    : "";
  console.log(
    `[locs] wrote locs bundle: ${(baked.manifest.positionsByteLength / 1024).toFixed(1)} KB pos, ` +
      `${(baked.manifest.colorsByteLength / 1024).toFixed(1)} KB col, ` +
      `${(baked.manifest.uvsByteLength / 1024).toFixed(1)} KB uv${framesKb}`,
  );
}
