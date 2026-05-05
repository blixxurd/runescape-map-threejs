import type { ModelDefinition, ObjectDefinition, RSCache } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import {
  BASE_AMBIENT,
  BASE_CONTRAST,
  applyFaceColorSubstitution,
  applyFaceTextureSubstitution,
} from "../color/modelLight.js";
import type { BakedAtlas } from "../texture/atlas.js";
import { flattenEntityModel } from "./npcModel.js";
import {
  bakeEntityAnimationFrames,
  flattenAnimationFramePositions,
} from "./animationBake.js";

/**
 * ObjectDefinition extractor — the viewer's "place an object" tool.
 *
 * Same shape as `bakeNpc`: returns a non-indexed triangle soup with baked
 * OSRS-style per-face lighting so the viewer can render with a plain
 * `MeshBasicMaterial`. The user rotates the mesh interactively at render
 * time, so we always bake the unrotated (`rotation = 0`) model.
 *
 * Model-type selection: OSRS objects hold geometry in typed slots (0–3 =
 * walls, 4–8 = wall decorations, 9 = diagonal wall, 10 = normal scenery,
 * 11 = normal diagonal, 12–21 = roof variants, 22 = floor decoration).
 * Most "objects" the user would want to plant are scenery (type 10), so
 * that's our default. When a def lists specific `objectTypes` we fall back
 * to the first one so wall-only / floor-only defs still resolve to a mesh.
 *
 * Textures: the dev server's shared global atlas is passed in and used to
 * resolve per-face UVs. Shares the flatten routine with `bakeNpc`.
 */

/** Pick the model-type slot to bake. Preference order:
 *   1. The def's first declared type if `objectTypes` is set — this is the
 *      only slot guaranteed to have geometry for typed defs.
 *   2. `10` (normal scenery) otherwise — the catch-all used for generic
 *      shrubs, crates, signs, props, etc.
 */
function pickDefaultModelType(def: ObjectDefinition): number {
  if (def.objectTypes && def.objectTypes.length > 0) {
    return def.objectTypes[0]!;
  }
  return 10;
}

export interface BakedObject {
  id: number;
  name: string;
  /** Model-type slot we baked — lets the viewer tell wall/floor/scenery
   *  apart for UI hints (e.g. showing "wall" on the armed banner). */
  modelType: number;
  sizeX: number;
  sizeY: number;
  /** ObjectDefinition.contouredGround. `undefined` = rigid model. `0` =
   *  opcode-21 full shift (every vertex follows the terrain; used by
   *  fences). Positive = opcode-81 ratio threshold in fixed-point (used
   *  by trees where the canopy stays rigid above the threshold). Shipped
   *  so the viewer can deform placements to match baked-loc behaviour on
   *  sloped terrain. */
  contouredGround?: number;
  /** Per-frame position soup for the loc's `animationID` sequence, if
   *  present and multi-frame. Single-frame sequences pose the base model
   *  in-place and leave this undefined. Respects the cache's `frameStep`
   *  so one-shot animations (chest opens and stays open) freeze, while
   *  looping animations (windmill vanes, fires) cycle. */
  animation?: BakedObjectAnimation;
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface BakedObjectAnimation {
  frameCount: number;
  frameTicks: number[];
  framesPositions: Float32Array;
  frameStep: number;
}

export async function bakeObject(
  rs: RSCache,
  objectId: number,
  atlas: BakedAtlas,
): Promise<BakedObject> {
  const def = (await rs
    .getDef<ObjectDefinition>(IndexType.CONFIGS, ConfigType.OBJECT, objectId)
    .catch(() => null)) as ObjectDefinition | null;
  if (!def) throw new Error(`object ${objectId} not in cache`);

  const modelType = pickDefaultModelType(def);
  let model: ModelDefinition | null = null;
  try {
    model = await def.getModel(rs, modelType, 0);
  } catch (e) {
    throw new Error(
      `object ${objectId}: getModel(${modelType}) threw: ${(e as Error).message}`,
    );
  }
  if (!model || model.vertexCount === 0 || model.faceCount === 0) {
    throw new Error(`object ${objectId}: no geometry for modelType ${modelType}`);
  }

  applyFaceColorSubstitution(model, def.recolorToFind, def.recolorToReplace);
  applyFaceTextureSubstitution(model, def.retextureToFind, def.textureToReplace);

  // Object animation — windmill vanes, fires, spinning wheels, banners.
  // Unlike NPC idle anims we respect the cache's `frameStep` literally so
  // one-shot loc animations (e.g. chests) don't accidentally loop.
  const animationId = def.animationID ?? -1;
  const animResult = animationId >= 0
    ? await bakeEntityAnimationFrames(rs, model, animationId, {
        alwaysLoop: false,
        logTag: "object",
      })
    : { singleFramePose: null, animation: null };
  if (animResult.singleFramePose) {
    (model.vertexPositionsX as number[]) = animResult.singleFramePose.vx;
    (model.vertexPositionsY as number[]) = animResult.singleFramePose.vy;
    (model.vertexPositionsZ as number[]) = animResult.singleFramePose.vz;
  }

  const ambient = BASE_AMBIENT + (def.ambient ?? 0);
  const contrast = BASE_CONTRAST + (def.contrast ?? 0);
  const { positions, colors, uvs } = flattenEntityModel(model, ambient, contrast, atlas);

  let animation: BakedObjectAnimation | undefined;
  if (animResult.animation) {
    const posed = animResult.animation.posedFrames;
    const perFrameFloats = positions.length;
    const framesPositions = new Float32Array(perFrameFloats * posed.length);
    for (let f = 0; f < posed.length; f++) {
      const flat = flattenAnimationFramePositions(
        model,
        posed[f]!.vx,
        posed[f]!.vy,
        posed[f]!.vz,
      );
      framesPositions.set(flat, f * perFrameFloats);
    }
    positions.set(framesPositions.subarray(0, perFrameFloats));
    animation = {
      frameCount: animResult.animation.frameCount,
      frameTicks: animResult.animation.frameTicks,
      framesPositions,
      frameStep: animResult.animation.frameStep,
    };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const bbox: BakedObject["bbox"] = Number.isFinite(minX)
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : { min: [0, 0, 0], max: [0, 0, 0] };

  return {
    id: objectId,
    name: def.name ?? `object_${objectId}`,
    modelType,
    sizeX: def.sizeX ?? 1,
    sizeY: def.sizeY ?? 1,
    contouredGround: def.contouredGround,
    animation,
    positions,
    colors,
    uvs,
    bbox,
  };
}

export interface ObjectCatalogEntry {
  id: number;
  name: string;
  /** First available model-type slot, for coarse UI grouping. */
  modelType: number;
  sizeX: number;
  sizeY: number;
  /** Phase 4 picker metadata. */
  category?: number;
  interactType?: number;
  /** Cache opcode 249 free-form key/value bag (teleport destinations,
   *  varbit thresholds, etc). Always raw — caller interprets. Elided
   *  when the cache opcode didn't fire. */
  params?: Record<string, string | number>;
}

/**
 * Iterate every ObjectDefinition in the cache and keep the subset that has
 * a usable name + at least one model. Skips the "null" entries that the
 * cache pads over unused ids. ~40k+ entries on build 234 — built on first
 * request and kept in memory.
 */
export async function buildObjectCatalog(rs: RSCache): Promise<ObjectCatalogEntry[]> {
  const defs =
    (await rs.getAllDefs<ObjectDefinition>(IndexType.CONFIGS, ConfigType.OBJECT)) ?? [];
  const out: ObjectCatalogEntry[] = [];
  for (const d of defs) {
    if (!d) continue;
    if (!d.name || d.name.toLowerCase() === "null") continue;
    const hasDefinedTypes = d.objectTypes && d.objectTypes.length > 0;
    const hasDefaultModels = d.objectModels && d.objectModels.length > 0;
    if (!hasDefinedTypes && !hasDefaultModels) continue;
    const entry: ObjectCatalogEntry = {
      id: d.id,
      name: d.name,
      modelType: hasDefinedTypes ? d.objectTypes![0]! : 10,
      sizeX: d.sizeX ?? 1,
      sizeY: d.sizeY ?? 1,
    };
    if (d.category !== undefined) entry.category = d.category;
    // Default 2 (blocks player+projectiles); only persist deviations to
    // keep the catalog JSON small.
    if (d.interactType !== undefined && d.interactType !== 2) {
      entry.interactType = d.interactType;
    }
    if (d.params && Object.keys(d.params).length > 0) {
      entry.params = { ...d.params };
    }
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
