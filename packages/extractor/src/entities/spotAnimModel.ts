import type { ModelDefinition, RSCache, SpotAnimDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import {
  BASE_AMBIENT,
  BASE_CONTRAST,
  applyFaceColorSubstitution,
  applyFaceTextureSubstitution,
} from "../color/modelLight.js";
import type { BakedAtlas } from "../texture/atlas.js";
import { flattenEntityModel, fetchModel } from "./npcModel.js";
import {
  bakeEntityAnimationFrames,
  flattenAnimationFramePositions,
} from "./animationBake.js";

/**
 * SpotAnim baker — Phase 9.
 *
 * SpotAnims are the geometry behind spell effects, projectiles,
 * gfx-on-NPC, and hitsplats. Single model + optional animation. Cache
 * source: ConfigType.SPOTANIM (id 13). Loader at
 * `osrscachereader/loaders/SpotAnimLoader.js`.
 *
 * Mostly mirrors `bakeObject`: fetch the model, apply recolor/retexture,
 * optionally bake animation frames, flatten through the shared atlas, ship
 * a triangle-soup. We don't apply the def's `rotation` field (initial
 * yaw); the viewer's transform gizmo handles user-applied rotations the
 * same way it does for objects.
 */

export interface BakedSpotAnim {
  id: number;
  name: string;
  /** SpotAnim's `resizeX/Y` divided by 128 — viewer can re-apply if it
   *  wants to honour the def's authored scale. Default 1. */
  scale: { x: number; y: number };
  /** Initial yaw from the def in OSRS units (0..2047). Viewer is free
   *  to apply or ignore — most placement use-cases leave the user-set
   *  rotation in charge. */
  rotation: number;
  animation?: BakedSpotAnimAnimation;
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface BakedSpotAnimAnimation {
  frameCount: number;
  frameTicks: number[];
  framesPositions: Float32Array;
  frameStep: number;
}

export async function bakeSpotAnim(
  rs: RSCache,
  spotAnimId: number,
  atlas: BakedAtlas,
): Promise<BakedSpotAnim> {
  const def = (await rs
    .getDef<SpotAnimDefinition>(IndexType.CONFIGS, ConfigType.SPOTANIM, spotAnimId)
    .catch(() => null)) as SpotAnimDefinition | null;
  if (!def) throw new Error(`spotanim ${spotAnimId} not in cache`);
  if (def.modelId === undefined) {
    throw new Error(`spotanim ${spotAnimId} has no model`);
  }

  const model = await fetchModel(rs, def.modelId);
  if (!model || model.vertexCount === 0 || model.faceCount === 0) {
    throw new Error(`spotanim ${spotAnimId}: no geometry for model ${def.modelId}`);
  }

  applyFaceColorSubstitution(
    model,
    def.recolorToFind,
    def.recolorToReplace,
  );
  applyFaceTextureSubstitution(
    model,
    def.textureToFind,
    def.textureToReplace,
  );

  // SpotAnim animations are typically one-shot effects (cast → played
  // once → freeze on last frame), reflected in cache `frameStep === -1`.
  // For the editor placer that's the wrong default — the user places a
  // SpotAnim to *see* its animation, and a frozen mesh after the first
  // play looks broken. Force-loop instead, same trick we use for NPC
  // standing animations (see `memory/npc_animation_semantics.md`).
  const animationId = def.animationId ?? -1;
  const animResult =
    animationId >= 0
      ? await bakeEntityAnimationFrames(rs, model, animationId, {
          alwaysLoop: true,
          logTag: "spotanim",
        })
      : { singleFramePose: null, animation: null };
  if (animResult.singleFramePose) {
    (model.vertexPositionsX as number[]) = animResult.singleFramePose.vx;
    (model.vertexPositionsY as number[]) = animResult.singleFramePose.vy;
    (model.vertexPositionsZ as number[]) = animResult.singleFramePose.vz;
  }

  const ambient = BASE_AMBIENT + (def.ambient ?? 0);
  const contrast = BASE_CONTRAST + (def.contrast ?? 0);
  const { positions, colors, uvs } = flattenEntityModel(
    model,
    ambient,
    contrast,
    atlas,
  );

  let animation: BakedSpotAnimAnimation | undefined;
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
  const bbox: BakedSpotAnim["bbox"] = Number.isFinite(minX)
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : { min: [0, 0, 0], max: [0, 0, 0] };

  return {
    id: spotAnimId,
    name: def.name ?? `spotanim_${spotAnimId}`,
    // Cache stores the resize as `× 128`; convert to a plain ratio. 0
    // means "unset" → default 1 (the OSRS client treats unset resize as
    // 128 = 1×).
    scale: {
      x: (def.resizeX ?? 128) / 128,
      y: (def.resizeY ?? 128) / 128,
    },
    rotation: def.rotation ?? 0,
    animation,
    positions,
    colors,
    uvs,
    bbox,
  };
}

export interface SpotAnimCatalogEntry {
  id: number;
  name: string;
  /** Whether the def has an animation reference. Pickers can show this. */
  hasAnimation?: boolean;
}

/**
 * Build a name+id list of every spot anim with a usable model.
 *
 * SpotAnim defs frequently lack `name` (opcode 4) in OSRS caches —
 * the engine references them by id, not by name, so most entries are
 * unnamed. We keep them anyway with a synthesized `spotanim_<id>`
 * label so the picker isn't empty; sorting falls back to id when
 * names tie.
 */
export async function buildSpotAnimCatalog(
  rs: RSCache,
): Promise<SpotAnimCatalogEntry[]> {
  const defs =
    (await rs.getAllDefs<SpotAnimDefinition>(
      IndexType.CONFIGS,
      ConfigType.SPOTANIM,
    )) ?? [];
  const out: SpotAnimCatalogEntry[] = [];
  for (const d of defs) {
    if (!d) continue;
    if (d.modelId === undefined) continue;
    const name =
      d.name && d.name.toLowerCase() !== "null" ? d.name : `spotanim_${d.id}`;
    const entry: SpotAnimCatalogEntry = { id: d.id, name };
    if (d.animationId !== undefined && d.animationId >= 0) {
      entry.hasAnimation = true;
    }
    out.push(entry);
  }
  out.sort((a, b) => {
    const cmp = a.name.localeCompare(b.name);
    return cmp !== 0 ? cmp : a.id - b.id;
  });
  return out;
}
