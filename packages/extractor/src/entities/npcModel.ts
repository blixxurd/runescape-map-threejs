import type { ModelDefinition, NpcDefinition, RSCache } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { hsl16ToRgb } from "../color/hsl.js";
import {
  BASE_AMBIENT,
  BASE_CONTRAST,
  faceLightness,
  applyLightToHsl,
  applyFaceColorSubstitution,
  applyFaceTextureSubstitution,
} from "../color/modelLight.js";
import type { BakedAtlas } from "../texture/atlas.js";
import { computeFaceUv, cellUV } from "../texture/locFaceUv.js";
import {
  bakeEntityAnimationFrames,
  flattenAnimationFramePositions,
} from "./animationBake.js";

/**
 * NPC extractor.
 *
 * Mirrors the loc model pipeline (see `region/locs.ts`) with two scope
 * cuts relative to the full world pipeline:
 *   - No animation — just the base (standing) pose. `standingAnimation`
 *     frame playback is a future-us problem.
 *   - Multiple-model NPCs (armoured characters, creatures with separate
 *     head/body/weapon models) are merged by concatenating vertices and
 *     re-indexing faces. OSRS does the same at render time.
 *
 * Textures: callers pass the cache-wide atlas built by `buildGlobalAtlas`.
 * Textured faces emit atlas-indexed UVs using the same face-UV math as
 * locs (Gramian-inverse affine projection onto the model's texture
 * triangle). Untextured faces map into the atlas's cell 0 (solid white) so
 * vertex color passes through unchanged.
 *
 * Output is non-indexed triangle soup with per-vertex (pos, color, uv) —
 * ready to drop into a `MeshBasicMaterial` backed by the atlas texture.
 */

/** Warm-grey used when a textured face references a texture id that isn't
 *  in the atlas (shouldn't happen with the global atlas, but defensive so
 *  a missing-texture case doesn't show up as white). */
const TEXTURED_FACE_FALLBACK: [number, number, number] = [140, 118, 95];

async function fetchModel(rs: RSCache, modelId: number): Promise<ModelDefinition | null> {
  try {
    const m = await rs.getDef<ModelDefinition>(IndexType.MODELS, modelId);
    return m ?? null;
  } catch (e) {
    console.warn(`[npc] getModel(${modelId}) threw: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Merge several models into a single composite. Each source model contributes
 * its vertices unmodified; face arrays are concatenated with the vertex
 * indices of later models shifted by the running vertex offset.
 *
 * OSRS does this for every multi-part NPC (helm + body + legs + weapon). We
 * only replicate what the extractor's lighting step needs — positions, face
 * triangles, faceColors, faceAlphas, faceTextures. Anything else the
 * ModelDefinition carries (texture-tri arrays, vertex skins) is dropped
 * because the flattened output doesn't use it.
 */
function mergeModels(parts: ModelDefinition[]): ModelDefinition {
  let totalVerts = 0;
  let totalFaces = 0;
  for (const p of parts) {
    totalVerts += p.vertexCount;
    totalFaces += p.faceCount;
  }

  const vx = new Int32Array(totalVerts);
  const vy = new Int32Array(totalVerts);
  const vz = new Int32Array(totalVerts);
  const fi1 = new Int32Array(totalFaces);
  const fi2 = new Int32Array(totalFaces);
  const fi3 = new Int32Array(totalFaces);
  const faceColors = new Int32Array(totalFaces);
  const faceAlphas = new Int32Array(totalFaces);
  const faceTextures = new Int32Array(totalFaces);
  // Merge vertexGroups so animation works on the composite. OSRS multi-part
  // NPCs share skeleton labels across parts (a "head" and a "body" both
  // use label 0 for the neck bone, etc.). We index by label and concatenate
  // the per-part vertex indices, shifting each part's indices by its own
  // vertex offset into the merged buffer. Without this, `applyFramePose`
  // only sees the first part's verts and the rest stays rigid.
  const mergedGroups: number[][] = [];

  let vOff = 0;
  let fOff = 0;
  for (const p of parts) {
    for (let v = 0; v < p.vertexCount; v++) {
      vx[vOff + v] = p.vertexPositionsX[v] as number;
      vy[vOff + v] = p.vertexPositionsY[v] as number;
      vz[vOff + v] = p.vertexPositionsZ[v] as number;
    }
    for (let f = 0; f < p.faceCount; f++) {
      fi1[fOff + f] = (p.faceVertexIndices1[f] as number) + vOff;
      fi2[fOff + f] = (p.faceVertexIndices2[f] as number) + vOff;
      fi3[fOff + f] = (p.faceVertexIndices3[f] as number) + vOff;
      faceColors[fOff + f] = (p.faceColors?.[f] as number | undefined) ?? 0;
      // faceAlphas: osrscachereader leaves this as an empty array when the
      // cache entry has no opcode for it — treat "missing" as fully opaque.
      faceAlphas[fOff + f] = (p.faceAlphas?.[f] as number | undefined) ?? 0;
      faceTextures[fOff + f] = (p.faceTextures?.[f] as number | undefined) ?? -1;
    }
    const groups = p.vertexGroups;
    if (groups) {
      for (let label = 0; label < groups.length; label++) {
        const srcIdxs = groups[label];
        if (!srcIdxs || srcIdxs.length === 0) continue;
        let dst = mergedGroups[label];
        if (!dst) {
          dst = [];
          mergedGroups[label] = dst;
        }
        for (const idx of srcIdxs) dst.push(idx + vOff);
      }
    }
    vOff += p.vertexCount;
    fOff += p.faceCount;
  }

  const merged: ModelDefinition = {
    vertexCount: totalVerts,
    faceCount: totalFaces,
    vertexPositionsX: vx,
    vertexPositionsY: vy,
    vertexPositionsZ: vz,
    faceVertexIndices1: fi1,
    faceVertexIndices2: fi2,
    faceVertexIndices3: fi3,
    faceColors,
    faceAlphas,
    faceTextures,
    vertexGroups: mergedGroups.length > 0 ? mergedGroups : undefined,
  };
  return merged;
}

/**
 * Flatten a single lit model into a non-indexed triangle soup. Port of the
 * loc emission loop in `region/locs.ts`, minus animation frames and
 * contoured ground.
 */
function flattenEntityModel(
  model: ModelDefinition,
  ambient: number,
  contrast: number,
  atlas: BakedAtlas,
): { positions: Float32Array; colors: Uint8Array; uvs: Float32Array } {
  const faceCount = model.faceCount;
  const vertCount = faceCount * 3;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Uint8Array(vertCount * 4);
  const uvs = new Float32Array(vertCount * 2);

  const atlasSize = atlas.manifest.atlasSize;
  const cellsPerRow = atlas.manifest.cellsPerRow;
  const cellSize = atlas.manifest.cellSize;
  const gutter = atlas.manifest.gutter ?? 0;
  // Atlas cell 0 is solid white — untextured faces sample its centre so the
  // vertex color passes through as the final pixel.
  const [whiteU, whiteV] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, 0, 0.5, 0.5);

  for (let i = 0; i < faceCount; i++) {
    const a = model.faceVertexIndices1[i] as number;
    const b = model.faceVertexIndices2[i] as number;
    const c = model.faceVertexIndices3[i] as number;

    // OSRS client-space → our world-space: flip Y and Z so +Y = up, +Z = south.
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

    // Lighting stays in client-space (pre-flip), matching the loc pipeline.
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

    // Alpha sentinels: -1 hides the face, -2 = textured-flat (treat opaque).
    // Values 0..254 are regular alpha (0 = opaque, 255 = invisible).
    const faceAlpha = (model.faceAlphas?.[i] as number | undefined) ?? 0;
    if (faceAlpha === -1) continue;
    const effectiveAlpha = faceAlpha < 0 ? 0 : faceAlpha;
    if (effectiveAlpha >= 255) continue;
    const vertexAlpha = 255 - effectiveAlpha;

    const faceTexId = (model.faceTextures?.[i] as number | undefined) ?? -1;
    const faceHsl = (model.faceColors?.[i] as number) ?? 0;
    const litHsl = applyLightToHsl(faceHsl, lightness);
    const [litR, litG, litB] = hsl16ToRgb(litHsl);

    const coff = i * 12;
    const uvOff = i * 6;

    if (faceTexId >= 0) {
      const cell = atlas.manifest.cellByTextureId[faceTexId];
      if (cell !== undefined) {
        // Project the face's vertices onto its texture triangle (identity
        // projection when the texture-triangle == face-triangle). Map the
        // resulting per-vertex [0..1] into the face's atlas cell.
        const [tu0, tv0, tu1, tv1, tu2, tv2] = computeFaceUv(model, i);
        const [u0, v0] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu0, tv0);
        const [u1, v1] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu1, tv1);
        const [u2, v2] = cellUV(atlasSize, cellsPerRow, cellSize, gutter, cell, tu2, tv2);
        uvs[uvOff + 0] = u0; uvs[uvOff + 1] = v0;
        uvs[uvOff + 2] = u1; uvs[uvOff + 3] = v1;
        uvs[uvOff + 4] = u2; uvs[uvOff + 5] = v2;
        // Vertex color is the lit HSL tint — multiplied by the sampled
        // texel at render time to produce the final color.
        for (let k = 0; k < 3; k++) {
          colors[coff + k * 4 + 0] = litR;
          colors[coff + k * 4 + 1] = litG;
          colors[coff + k * 4 + 2] = litB;
          colors[coff + k * 4 + 3] = vertexAlpha;
        }
        continue;
      }
      // Texture missing from the atlas — use the warm-grey fallback
      // (same as the loc pipeline's missing-texture fallback).
      uvs[uvOff + 0] = whiteU; uvs[uvOff + 1] = whiteV;
      uvs[uvOff + 2] = whiteU; uvs[uvOff + 3] = whiteV;
      uvs[uvOff + 4] = whiteU; uvs[uvOff + 5] = whiteV;
      const [r, g, b3] = TEXTURED_FACE_FALLBACK;
      for (let k = 0; k < 3; k++) {
        colors[coff + k * 4 + 0] = r;
        colors[coff + k * 4 + 1] = g;
        colors[coff + k * 4 + 2] = b3;
        colors[coff + k * 4 + 3] = vertexAlpha;
      }
      continue;
    }

    // Untextured face: sample atlas cell 0 (white), vertex color carries
    // the full lit color.
    uvs[uvOff + 0] = whiteU; uvs[uvOff + 1] = whiteV;
    uvs[uvOff + 2] = whiteU; uvs[uvOff + 3] = whiteV;
    uvs[uvOff + 4] = whiteU; uvs[uvOff + 5] = whiteV;
    for (let k = 0; k < 3; k++) {
      colors[coff + k * 4 + 0] = litR;
      colors[coff + k * 4 + 1] = litG;
      colors[coff + k * 4 + 2] = litB;
      colors[coff + k * 4 + 3] = vertexAlpha;
    }
  }

  return { positions, colors, uvs };
}

export interface BakedNpc {
  id: number;
  name: string;
  size: number;
  /** Non-indexed triangle soup, `positions.length / 3` vertices. */
  positions: Float32Array;
  /** RGBA8 per vertex, normalized on upload. */
  colors: Uint8Array;
  /** Per-vertex atlas UVs. */
  uvs: Float32Array;
  /** AABB in world-local space (NPC centered at origin). */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Per-frame position soup for the baked sequence (standingAnimation by
   *  default, or whatever the caller overrode via the `animationId` arg).
   *  Frame 0 matches `positions` so a placed mesh starts in sync. */
  animation?: BakedNpcAnimation;
  /** Sequence id actually baked into `animation` — echoes whichever
   *  animation we ended up using (the override, or the NPC's default). */
  activeAnimationId?: number;
  /** The NPC def's declared animation-field menu (rotate, walk, run, etc.)
   *  filtered to entries that reference a real sequence id. Lets the
   *  viewer show a "change animation" picker without a second round-trip.
   *  IDs are OSRS sequence ids — re-request the bake with `?anim=<id>`
   *  to swap. */
  availableAnimations: Array<{ id: number; label: string }>;
}

export interface BakedNpcAnimation {
  /** Total frame count, including frame 0. */
  frameCount: number;
  /** Per-frame duration in 20-ms client-ticks. Viewer multiplies by 20. */
  frameTicks: number[];
  /** Frame-major positions: frame × (vertexCount × 3) floats. */
  framesPositions: Float32Array;
  /** Mirrors `SequenceDefinition.frameStep` — loop semantics (−1 → freeze,
   *  < frameCount → tail loop, ≥ frameCount → full loop). Same regime
   *  table as loc animation. */
  frameStep: number;
}

/** Internal helper — also used by objectModel.ts. Exported for composition
 *  only, not intended as part of the public extractor API. */
export { flattenEntityModel, fetchModel };

/**
 * Load, merge, light, and flatten one NPC into a render-ready triangle soup.
 * Throws if the NPC has no models or every referenced model is missing from
 * the cache — the caller (dev middleware) treats that as 404.
 */
/** Fields on NpcDefinition that reference a sequence id. The label is what
 *  we show to the user in the picker. Order here is the menu order.
 *
 *  Run + crawl rotation variants come straight from the cache opcodes —
 *  per `osrscachereader/loaders/NpcLoader.js:356-368` (run anims) and
 *  363-368 (crawl anims). The cache only stores state-machine anims
 *  (idle / walk / rotate / run / crawl); attack/emote anims live in
 *  game scripts and aren't reachable from cache (see
 *  `memory/npc_animation_semantics.md`). */
const NPC_ANIMATION_FIELDS: Array<{
  key: keyof NpcDefinition;
  label: string;
}> = [
  { key: "standingAnimation", label: "standing" },
  { key: "walkingAnimation", label: "walking" },
  { key: "runAnimation", label: "running" },
  { key: "crawlAnimation", label: "crawl" },
  { key: "rotateLeftAnimation", label: "rotate left" },
  { key: "rotateRightAnimation", label: "rotate right" },
  { key: "rotate90LeftAnimation", label: "turn left 90°" },
  { key: "rotate90RightAnimation", label: "turn right 90°" },
  { key: "rotate180Animation", label: "turn 180°" },
  { key: "runRotateLeftAnimation", label: "run rotate left" },
  { key: "runRotateRightAnimation", label: "run rotate right" },
  { key: "runRotate180Animation", label: "run turn 180°" },
  { key: "crawlRotateLeftAnimation", label: "crawl rotate left" },
  { key: "crawlRotateRightAnimation", label: "crawl rotate right" },
  { key: "crawlRotate180Animation", label: "crawl turn 180°" },
];

function collectAnimationMenu(def: NpcDefinition): Array<{ id: number; label: string }> {
  const seen = new Set<number>();
  const out: Array<{ id: number; label: string }> = [];
  for (const entry of NPC_ANIMATION_FIELDS) {
    const id = (def as unknown as Record<string, number | undefined>)[entry.key as string];
    if (id === undefined || id < 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: entry.label });
  }
  return out;
}

export async function bakeNpc(
  rs: RSCache,
  npcId: number,
  atlas: BakedAtlas,
  animationOverride?: number,
): Promise<BakedNpc> {
  const def = (await rs.getNPC(npcId).catch(() => null)) as NpcDefinition | null;
  if (!def) throw new Error(`NPC ${npcId} not in cache`);
  const modelIds = def.models ?? [];
  if (modelIds.length === 0) throw new Error(`NPC ${npcId} has no models`);

  const parts: ModelDefinition[] = [];
  for (const mid of modelIds) {
    const m = await fetchModel(rs, mid);
    if (m && m.vertexCount > 0 && m.faceCount > 0) parts.push(m);
  }
  if (parts.length === 0) throw new Error(`NPC ${npcId}: no usable models`);

  const merged = parts.length === 1 ? parts[0]! : mergeModels(parts);
  applyFaceColorSubstitution(merged, def.recolorToFind, def.recolorToReplace);
  applyFaceTextureSubstitution(merged, def.retextureToFind, def.retextureToReplace);

  // Animation selection: use the caller's override if given, else fall back
  // to the NPC's standingAnimation. Single-frame idle sequences pose the
  // base model in-place (no per-tick cycling); multi-frame sequences go
  // into `animation` and the viewer cycles positions per tick.
  const targetAnimId = animationOverride !== undefined && animationOverride >= 0
    ? animationOverride
    : (def.standingAnimation ?? -1);
  const animResult = targetAnimId >= 0
    ? await bakeEntityAnimationFrames(rs, merged, targetAnimId, {
        alwaysLoop: true,
        logTag: "npc",
      })
    : { singleFramePose: null, animation: null };
  if (animResult.singleFramePose) {
    (merged.vertexPositionsX as number[]) = animResult.singleFramePose.vx;
    (merged.vertexPositionsY as number[]) = animResult.singleFramePose.vy;
    (merged.vertexPositionsZ as number[]) = animResult.singleFramePose.vz;
  }

  const ambient = BASE_AMBIENT + (def.ambient ?? 0);
  const contrast = BASE_CONTRAST + (def.contrast ?? 0);
  const { positions, colors, uvs } = flattenEntityModel(merged, ambient, contrast, atlas);

  // For multi-frame animations, flatten each frame's positions with the
  // same face indexing flattenEntityModel just used, producing one big
  // frame-major Float32Array the viewer can slice into per-frame views.
  let animation: BakedNpcAnimation | undefined;
  if (animResult.animation) {
    const posed = animResult.animation.posedFrames;
    const perFrameFloats = positions.length;
    const framesPositions = new Float32Array(perFrameFloats * posed.length);
    for (let f = 0; f < posed.length; f++) {
      const flat = flattenAnimationFramePositions(
        merged,
        posed[f]!.vx,
        posed[f]!.vy,
        posed[f]!.vz,
      );
      framesPositions.set(flat, f * perFrameFloats);
    }
    // Main `positions` should match frame 0 so a placed mesh starts in
    // sync with the cycle. Overwrite in-place.
    positions.set(framesPositions.subarray(0, perFrameFloats));
    animation = {
      frameCount: animResult.animation.frameCount,
      frameTicks: animResult.animation.frameTicks,
      framesPositions,
      frameStep: animResult.animation.frameStep,
    };
  }

  // AABB scan over the flattened positions. Used by the viewer to pick a
  // sensible raycast hit-box and to center the NPC on its tile.
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
  const bbox: BakedNpc["bbox"] = Number.isFinite(minX)
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : { min: [0, 0, 0], max: [0, 0, 0] };

  return {
    id: npcId,
    name: def.name ?? `npc_${npcId}`,
    size: def.size ?? 1,
    positions,
    colors,
    uvs,
    bbox,
    animation,
    activeAnimationId: animation ? targetAnimId : undefined,
    availableAnimations: collectAnimationMenu(def),
  };
}

export interface NpcCatalogEntry {
  id: number;
  name: string;
  combatLevel: number;
  size: number;
  /** Phase 4 picker metadata. */
  category?: number;
  /** Default true; only persisted when explicitly disabled. */
  isMinimapVisible?: false;
  renderPriority?: number;
  rotationSpeed?: number;
  /** Length of `headIconArchiveIds` if present (skull/protect-prayer/boss
   *  icons). The actual archive+index is per-NPC scenery; we surface the
   *  count so pickers can label "has head icons". Full data fetch via
   *  `/api/npc/:id` if needed. */
  headIconCount?: number;
}

/**
 * Iterate every NPC def in the cache and return the subset that has at least
 * one model id. ~11k entries on build 234 — cheap enough to build on first
 * request and keep in memory for the session.
 */
export async function buildNpcCatalog(rs: RSCache): Promise<NpcCatalogEntry[]> {
  const defs = (await rs.getAllDefs<NpcDefinition>(IndexType.CONFIGS, ConfigType.NPC)) ?? [];
  const out: NpcCatalogEntry[] = [];
  for (const d of defs) {
    if (!d) continue;
    if (!d.models || d.models.length === 0) continue;
    if (!d.name || d.name.toLowerCase() === "null") continue;
    const entry: NpcCatalogEntry = {
      id: d.id,
      name: d.name,
      combatLevel: d.combatLevel ?? -1,
      size: d.size ?? 1,
    };
    if (d.category !== undefined) entry.category = d.category;
    if (d.isMinimapVisible === false) entry.isMinimapVisible = false;
    if (d.renderPriority !== undefined && d.renderPriority !== 0 && d.renderPriority !== 1) {
      entry.renderPriority = d.renderPriority;
    }
    if (d.rotationSpeed !== undefined) entry.rotationSpeed = d.rotationSpeed;
    if (d.headIconArchiveIds && d.headIconArchiveIds.length > 0) {
      entry.headIconCount = d.headIconArchiveIds.length;
    }
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
