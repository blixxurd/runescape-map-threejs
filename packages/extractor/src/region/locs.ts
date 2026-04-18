import type { RSCache, LocationDefinition, ObjectDefinition, ModelDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hsl16ToRgb } from "../color/hsl.js";
import { computeFaceUv, cellUV } from "../texture/locFaceUv.js";
import type { BakedAtlas } from "../texture/atlas.js";
import type { LocsManifest, LocBlock, LocPlacement } from "@rsmap/shared";

/**
 * Client-authentic per-face lighting, ported from `Model.applyLighting` +
 * `Model.method816` in runejs/refactored-client-435's `Model.java`.
 *
 * The client bakes per-vertex lighting at model-load time and at render time
 * just multiplies texture × vertex color. We mirror that so the viewer can
 * use `MeshBasicMaterial` (no scene lights, no double-darken).
 *
 * Formula:
 *   magnitude    = |lightDir|
 *   contrastScale = contrast × magnitude / 256
 *   per-face:
 *     normal     = cross(edge1, edge2), scaled to |n| ≈ 256
 *     lightness  = ambient + dot(lightDir, normal) / (contrastScale × 1.5)
 *                  // SIGNED — back-facing faces get very low lightness
 *   per-vertex-color:
 *     newLum     = clamp(lightness × (faceHsl & 0x7f) / 128, 2, 126)
 *     litHsl     = (faceHsl & 0xff80) | newLum
 *     rgb        = hsl16ToRgb(litHsl)
 *
 * Critical: `method816` scales the HSL's luminance bits, preserving hue +
 * saturation unchanged. A naive RGB multiply (c × factor) would wash out
 * saturated colors (tree trunks, dyed cloth, etc).
 *
 * Normals are computed in CLIENT-space (pre-Y/Z-flip) so client constants
 * apply unchanged.
 */
const LIGHT_AMBIENT = 64;
const LIGHT_CONTRAST = 768;
const LIGHT_DIR_X = -50;
const LIGHT_DIR_Y = -10;
const LIGHT_DIR_Z = -50;
const LIGHT_MAG = Math.sqrt(
  LIGHT_DIR_X * LIGHT_DIR_X + LIGHT_DIR_Y * LIGHT_DIR_Y + LIGHT_DIR_Z * LIGHT_DIR_Z,
) | 0;
const CONTRAST_SCALE = (LIGHT_CONTRAST * LIGHT_MAG) >> 8;
const LIGHT_DIVISOR = CONTRAST_SCALE + (CONTRAST_SCALE >> 1);

/** Per-face lightness integer (signed; roughly [-57, +121] around ambient 64). */
function faceLightness(nxRaw: number, nyRaw: number, nzRaw: number): number {
  const len = Math.sqrt(nxRaw * nxRaw + nyRaw * nyRaw + nzRaw * nzRaw);
  if (len === 0) return LIGHT_AMBIENT;
  const nx = ((nxRaw * 256) / len) | 0;
  const ny = ((nyRaw * 256) / len) | 0;
  const nz = ((nzRaw * 256) / len) | 0;
  const dot = LIGHT_DIR_X * nx + LIGHT_DIR_Y * ny + LIGHT_DIR_Z * nz;
  return LIGHT_AMBIENT + ((dot / LIGHT_DIVISOR) | 0);
}

/** Client-authentic HSL luminance adjustment — port of `method816`. */
function applyLightToHsl(hsl: number, lightness: number): number {
  let newLum = (lightness * (hsl & 0x7f)) >> 7;
  if (newLum < 2) newLum = 2;
  else if (newLum > 126) newLum = 126;
  return (hsl & 0xff80) | newLum;
}

/**
 * OSRS applies per-loc face recolors/retextures via the `recolorToFind →
 * recolorToReplace` arrays on the object def. The library's `getModel` tries
 * but reads the wrong field names (`recolorFrom`/`retextureFrom`) and
 * silently no-ops. We do it ourselves after `getModel` returns.
 */
function applyRecolor(model: ModelDefinition, def: ObjectDefinition): void {
  const from = def.recolorToFind;
  const to = def.recolorToReplace;
  if (!from || !to || from.length === 0) return;
  const faceColors = model.faceColors;
  if (!faceColors) return;
  const map = new Map<number, number>();
  for (let i = 0; i < from.length; i++) map.set(from[i]!, to[i]!);
  for (let i = 0; i < faceColors.length; i++) {
    const dst = map.get(faceColors[i] as number);
    if (dst !== undefined) (faceColors as number[])[i] = dst;
  }
}

function applyRetexture(model: ModelDefinition, def: ObjectDefinition): void {
  const from = def.retextureToFind;
  const to = def.textureToReplace;
  if (!from || !to || from.length === 0) return;
  const faceTextures = model.faceTextures;
  if (!faceTextures) return;
  const map = new Map<number, number>();
  for (let i = 0; i < from.length; i++) map.set(from[i]!, to[i]!);
  for (let i = 0; i < faceTextures.length; i++) {
    const dst = map.get(faceTextures[i] as number);
    if (dst !== undefined) (faceTextures as number[])[i] = dst;
  }
}

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
    case 11: // NORMAL_DIAGIONAL
      return [{ modelType: 10, bakedRotation: rotation + 4 }];
    default:
      return [{ modelType: type, bakedRotation: rotation }];
  }
}

// ---------- Phase 1: resolve ----------

interface ResolvedBlock {
  key: string;
  locId: number;
  modelType: number;
  bakedRotation: number;
  model: ModelDefinition;
}

export interface LocsPlan {
  regionX: number;
  regionZ: number;
  locDef: LocationDefinition | undefined;
  blocks: ResolvedBlock[];
  blockIndexByKey: Map<string, number>;
  skippedLocIds: Set<number>;
  skipReasons: { noDef: number; noModel: number; emptyModel: number; error: number };
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

  for (const [key, draw] of uniqueDraws) {
    const objDef = await getObjDef(draw.locId);
    if (!objDef) {
      skippedLocIds.add(draw.locId);
      skipReasons.noDef++;
      continue;
    }
    let model: ModelDefinition | null = null;
    try {
      model = await objDef.getModel(cache, draw.modelType, draw.bakedRotation);
    } catch (e) {
      console.warn(
        `[locs] getModel(${draw.locId}, mt=${draw.modelType}, rot=${draw.bakedRotation}) threw: ${(e as Error).message}`,
      );
      skipReasons.error++;
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
    applyRecolor(model, objDef);
    applyRetexture(model, objDef);
    blockIndexByKey.set(key, blocks.length);
    blocks.push({ key, locId: draw.locId, modelType: draw.modelType, bakedRotation: draw.bakedRotation, model });
  }

  return { regionX, regionZ, locDef, blocks, blockIndexByKey, skippedLocIds, skipReasons };
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
    const lightness = faceLightness(nx, ny, nz);

    // Color + texture selection per face.
    const faceTexId = (model.faceTextures?.[i] as number | undefined) ?? -1;
    const faceHsl = (model.faceColors?.[i] as number) ?? 0;
    const uvOff = i * 6;
    const coff = i * 12;

    // Lit HSL = method816 on the face's stored HSL. For textured faces,
    // this is the tint that multiplies the sampled texel; for untextured
    // faces, this IS the final color (texture is white cell 0).
    const litHsl = applyLightToHsl(faceHsl, lightness);
    const [litR, litG, litB] = hsl16ToRgb(litHsl);

    if (faceTexId >= 0) {
      const cell = atlas.manifest.cellByTextureId[faceTexId];
      if (cell !== undefined) {
        const [tu0, tv0, tu1, tv1, tu2, tv2] = computeFaceUv(model, i);
        const [u0, v0] = cellUV(atlasSize, cellsPerRow, cell, tu0, tv0);
        const [u1, v1] = cellUV(atlasSize, cellsPerRow, cell, tu1, tv1);
        const [u2, v2] = cellUV(atlasSize, cellsPerRow, cell, tu2, tv2);
        uvs[uvOff + 0] = u0; uvs[uvOff + 1] = v0;
        uvs[uvOff + 2] = u1; uvs[uvOff + 3] = v1;
        uvs[uvOff + 4] = u2; uvs[uvOff + 5] = v2;

        for (let k = 0; k < 3; k++) {
          colors[coff + k * 4 + 0] = litR;
          colors[coff + k * 4 + 1] = litG;
          colors[coff + k * 4 + 2] = litB;
          colors[coff + k * 4 + 3] = 255;
        }
        continue;
      }
      // Texture not in atlas — fall through to color path.
    }

    // Untextured face: sample atlas cell 0 (white), vertex color drives appearance.
    const [u0w, v0w] = cellUV(atlasSize, cellsPerRow, 0, 0.5, 0.5);
    uvs[uvOff + 0] = u0w; uvs[uvOff + 1] = v0w;
    uvs[uvOff + 2] = u0w; uvs[uvOff + 3] = v0w;
    uvs[uvOff + 4] = u0w; uvs[uvOff + 5] = v0w;

    colors[coff + 0] = litR; colors[coff + 1] = litG; colors[coff + 2] = litB; colors[coff + 3] = 255;
    colors[coff + 4] = litR; colors[coff + 5] = litG; colors[coff + 6] = litB; colors[coff + 7] = 255;
    colors[coff + 8] = litR; colors[coff + 9] = litG; colors[coff + 10] = litB; colors[coff + 11] = 255;
  }

  if (!Number.isFinite(min[0])) {
    return { positions, colors, uvs, bbox: { min: [0, 0, 0], max: [0, 0, 0] } };
  }
  return { positions, colors, uvs, bbox: { min, max } };
}

/** Phase 2: serialize resolved blocks + placements into a bundle. */
export function emitLocs(plan: LocsPlan, atlas: BakedAtlas): BakedLocs {
  const blocks: LocBlock[] = [];
  const positionsChunks: Float32Array[] = [];
  const colorsChunks: Uint8Array[] = [];
  const uvsChunks: Float32Array[] = [];
  let posByteCursor = 0;
  let colByteCursor = 0;
  let uvByteCursor = 0;

  for (const rb of plan.blocks) {
    const flat = flattenModel(rb.model, atlas);
    const vertexCount = flat.positions.length / 3;
    blocks.push({
      locId: rb.locId,
      modelType: rb.modelType,
      bakedRotation: rb.bakedRotation,
      vertexCount,
      positionsByteOffset: posByteCursor,
      colorsByteOffset: colByteCursor,
      uvsByteOffset: uvByteCursor,
      bboxMin: flat.bbox.min,
      bboxMax: flat.bbox.max,
    });
    positionsChunks.push(flat.positions);
    colorsChunks.push(flat.colors);
    uvsChunks.push(flat.uvs);
    posByteCursor += flat.positions.byteLength;
    colByteCursor += flat.colors.byteLength;
    uvByteCursor += flat.uvs.byteLength;
  }

  const positions = new Float32Array(posByteCursor / 4);
  const colors = new Uint8Array(colByteCursor);
  const uvs = new Float32Array(uvByteCursor / 4);
  let posOff = 0;
  let colOff = 0;
  let uvOff = 0;
  for (let i = 0; i < positionsChunks.length; i++) {
    positions.set(positionsChunks[i]!, posOff);
    colors.set(colorsChunks[i]!, colOff);
    uvs.set(uvsChunks[i]!, uvOff);
    posOff += positionsChunks[i]!.length;
    colOff += colorsChunks[i]!.length;
    uvOff += uvsChunks[i]!.length;
  }

  const placements: LocPlacement[] = [];
  if (plan.locDef) {
    for (const p of plan.locDef.locations) {
      for (const draw of expandPlacement(p.type, p.orientation)) {
        const key = `${p.id}:${draw.modelType}:${draw.bakedRotation}`;
        const idx = plan.blockIndexByKey.get(key);
        if (idx === undefined) continue;
        placements.push({
          locId: p.id,
          origType: p.type,
          origRotation: p.orientation,
          x: p.position.localX,
          z: p.position.localY,
          plane: p.position.height,
          blockIndex: idx,
        });
      }
    }
  }

  const manifest: LocsManifest = {
    schemaVersion: 2,
    blocks,
    placements,
    positionsByteLength: positions.byteLength,
    colorsByteLength: colors.byteLength,
    uvsByteLength: uvs.byteLength,
    positionsFile: "locs.pos.bin",
    colorsFile: "locs.col.bin",
    uvsFile: "locs.uv.bin",
    skippedLocIds: Array.from(plan.skippedLocIds).sort((a, b) => a - b),
  };

  const r = plan.skipReasons;
  console.log(
    `[locs] ${blocks.length} blocks, ${placements.length} placements, ` +
      `${plan.skippedLocIds.size} locIds skipped (noDef=${r.noDef} noModel=${r.noModel} empty=${r.emptyModel} err=${r.error})`,
  );
  return { manifest, positions, colors, uvs };
}

export async function writeLocsBundle(baked: BakedLocs, outDir: string): Promise<void> {
  await writeFile(join(outDir, baked.manifest.positionsFile), Buffer.from(baked.positions.buffer));
  await writeFile(join(outDir, baked.manifest.colorsFile), Buffer.from(baked.colors.buffer));
  await writeFile(join(outDir, baked.manifest.uvsFile), Buffer.from(baked.uvs.buffer));
  await writeFile(join(outDir, "locs.json"), JSON.stringify(baked.manifest));
  console.log(
    `[locs] wrote locs bundle: ${(baked.manifest.positionsByteLength / 1024).toFixed(1)} KB pos, ` +
      `${(baked.manifest.colorsByteLength / 1024).toFixed(1)} KB col, ` +
      `${(baked.manifest.uvsByteLength / 1024).toFixed(1)} KB uv`,
  );
}
