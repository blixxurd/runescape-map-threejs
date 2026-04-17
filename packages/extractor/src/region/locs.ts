import type { RSCache, LocationDefinition, ObjectDefinition, ModelDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hsl16ToRgb } from "../color/hsl.js";
import type { LocsManifest, LocBlock, LocPlacement } from "@rsmap/shared";

/**
 * Per-loc recolor remap, as written by `ObjectLoader` on the definition.
 * `objDef.recolorToFind[i]` should be replaced with `objDef.recolorToReplace[i]`.
 * Same shape for retexture.
 *
 * Context: osrscachereader's `ObjectDefinition.getModel` *tries* to apply
 * these, but reads `recolorFrom`/`recolorTo` (fields that don't exist) so
 * it's a silent no-op. We patch it ourselves here.
 */
function applyRecolor(model: ModelDefinition, def: ObjectDefinition): void {
  const from = def.recolorToFind;
  const to = def.recolorToReplace;
  if (!from || !to || from.length === 0) return;
  const faceColors = model.faceColors;
  if (!faceColors) return;
  // Build a lookup. Recolor arrays are tiny (1–6 entries), so a linear scan
  // per face would also be fine — use a Map for clarity.
  const map = new Map<number, number>();
  for (let i = 0; i < from.length; i++) {
    map.set(from[i]!, to[i]!);
  }
  for (let i = 0; i < faceColors.length; i++) {
    const src = faceColors[i] as number;
    const dst = map.get(src);
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
  for (let i = 0; i < from.length; i++) {
    map.set(from[i]!, to[i]!);
  }
  for (let i = 0; i < faceTextures.length; i++) {
    const src = faceTextures[i] as number;
    const dst = map.get(src);
    if (dst !== undefined) (faceTextures as number[])[i] = dst;
  }
}

/**
 * Convert one OSRS model to a non-indexed triangle soup with flat per-face
 * colors (duplicated to all 3 corners). Applies the client's Y/Z sign flip
 * to match Three.js's right-handed convention.
 *
 * We don't try to preserve textures or alpha transparency yet — everything
 * becomes opaque, flat-colored RGB. Textures/alpha are a later milestone.
 */
function flattenModel(model: ModelDefinition): { positions: Float32Array; colors: Uint8Array; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const faceCount = model.faceVertexIndices1.length;
  const vertCount = faceCount * 3;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Uint8Array(vertCount * 4);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < faceCount; i++) {
    const a = model.faceVertexIndices1[i] as number;
    const b = model.faceVertexIndices2[i] as number;
    const c = model.faceVertexIndices3[i] as number;

    // Convert OSRS (left-handed, +X east, +Y down, +Z north) to our
    // Three.js convention (right-handed, +X east, +Y up, +Z south).
    // Both Y and Z are negated: Y because our Y points up, Z because
    // our north is −Z. Double negation preserves handedness so triangle
    // winding carries over.
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
    positions[off + 0] = ax;
    positions[off + 1] = ay;
    positions[off + 2] = az;
    positions[off + 3] = bx;
    positions[off + 4] = by;
    positions[off + 5] = bz;
    positions[off + 6] = cx;
    positions[off + 7] = cy;
    positions[off + 8] = cz;

    for (const [px, py, pz] of [
      [ax, ay, az],
      [bx, by, bz],
      [cx, cy, cz],
    ] as [number, number, number][]) {
      if (px < min[0]) min[0] = px;
      if (py < min[1]) min[1] = py;
      if (pz < min[2]) min[2] = pz;
      if (px > max[0]) max[0] = px;
      if (py > max[1]) max[1] = py;
      if (pz > max[2]) max[2] = pz;
    }

    // Face color → RGB. faceColors is HSL16-packed.
    // Textured faces in OSRS store a "tint" HSL meant to be multiplied with
    // the sampled texture — often near-white/low-saturation. Interpreted as
    // a flat color it produces glaring white walls/doors/floors. Until we
    // actually sample textures, substitute a muted warm-grey so those
    // surfaces don't visually overpower the untextured geometry.
    const faceTexId = (model.faceTextures?.[i] as number | undefined) ?? -1;
    const faceHsl = (model.faceColors?.[i] as number) ?? 0;
    let r: number, g: number, bch: number;
    if (faceTexId !== -1) {
      r = 140; g = 118; bch = 95;
    } else {
      [r, g, bch] = hsl16ToRgb(faceHsl);
    }
    const coff = i * 12;
    colors[coff + 0] = r; colors[coff + 1] = g; colors[coff + 2] = bch; colors[coff + 3] = 255;
    colors[coff + 4] = r; colors[coff + 5] = g; colors[coff + 6] = bch; colors[coff + 7] = 255;
    colors[coff + 8] = r; colors[coff + 9] = g; colors[coff + 10] = bch; colors[coff + 11] = 255;
  }

  if (!Number.isFinite(min[0])) {
    return { positions, colors, bbox: { min: [0, 0, 0], max: [0, 0, 0] } };
  }
  return { positions, colors, bbox: { min, max } };
}

export interface BakedLocs {
  manifest: LocsManifest;
  positions: Float32Array;
  colors: Uint8Array;
}

/**
 * Loc-type → (modelType, rotationOffset) expansion.
 *
 * Most placements are a single draw: modelType = placement.type, rotation =
 * placement.rotation. A few types expand to multiple or rewrite the model
 * type, matching `SceneBuilder.addLoc` in rs-map-viewer:
 *
 *   - Type 2 (WALL_CORNER) → two models, one with rotation+4 (diagonal
 *     variant, triggers method1194) and one with (rotation+1)&3.
 *   - Type 11 (NORMAL_DIAGIONAL) → single model, modelType=10, rotation+4.
 *
 * `rotation > 3` asks `ObjectDefinition.getModel` for extra transforms
 * (mirror via method1194, type-4 offset via method1206/changeOffset). Those
 * bake into the vertex positions, which is why we can't cache a single
 * rotation=0 geometry and spin it at instance time for these types.
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

export async function bakeLocs(cache: RSCache, regionX: number, regionZ: number): Promise<BakedLocs> {
  console.log(`[locs] getLoc(${regionX}, ${regionZ})`);
  let locDef: LocationDefinition | undefined;
  try {
    locDef = await cache.getLoc(regionX, regionZ);
  } catch (e) {
    console.warn(`[locs] getLoc failed: ${(e as Error).message}`);
  }

  if (!locDef || !locDef.locations || locDef.locations.length === 0) {
    console.warn(`[locs] no location data for region (${regionX}, ${regionZ})`);
    return emptyLocs();
  }
  console.log(`[locs] ${locDef.locations.length} placements`);

  // Expand each placement to its (locId, modelType, bakedRotation) draws, dedup
  // across placements.
  const drawKey = (locId: number, modelType: number, bakedRotation: number): string =>
    `${locId}:${modelType}:${bakedRotation}`;
  const uniqueDraws = new Map<string, { locId: number } & BlockDraw>();
  for (const p of locDef.locations) {
    for (const draw of expandPlacement(p.type, p.orientation)) {
      uniqueDraws.set(drawKey(p.id, draw.modelType, draw.bakedRotation), {
        locId: p.id,
        ...draw,
      });
    }
  }
  console.log(`[locs] ${uniqueDraws.size} unique (locId, modelType, rotation) blocks`);

  // Bake each unique block.
  const blocks: LocBlock[] = [];
  const blockIndexByKey = new Map<string, number>();
  const positionsChunks: Float32Array[] = [];
  const colorsChunks: Uint8Array[] = [];
  let posByteCursor = 0;
  let colByteCursor = 0;
  const skipped = new Set<number>();
  const skipReasons = { noDef: 0, noModel: 0, emptyModel: 0, error: 0 };

  // ObjectDefinitions are fetched per locId; cache so repeated (locId, *, *)
  // lookups don't hit the library repeatedly.
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
      skipped.add(draw.locId);
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
      skipped.add(draw.locId);
      skipReasons.noModel++;
      continue;
    }
    if (model.faceVertexIndices1.length === 0) {
      skipped.add(draw.locId);
      skipReasons.emptyModel++;
      continue;
    }

    // Patch around the library's broken recolor/retexture pass.
    applyRecolor(model, objDef);
    applyRetexture(model, objDef);

    const flat = flattenModel(model);
    const vertexCount = flat.positions.length / 3;
    const block: LocBlock = {
      locId: draw.locId,
      modelType: draw.modelType,
      bakedRotation: draw.bakedRotation,
      vertexCount,
      positionsByteOffset: posByteCursor,
      colorsByteOffset: colByteCursor,
      bboxMin: flat.bbox.min,
      bboxMax: flat.bbox.max,
    };
    blocks.push(block);
    blockIndexByKey.set(key, blocks.length - 1);
    positionsChunks.push(flat.positions);
    colorsChunks.push(flat.colors);
    posByteCursor += flat.positions.byteLength;
    colByteCursor += flat.colors.byteLength;
  }

  const positions = new Float32Array(posByteCursor / 4);
  const colors = new Uint8Array(colByteCursor);
  let posOff = 0;
  let colOff = 0;
  for (let i = 0; i < positionsChunks.length; i++) {
    positions.set(positionsChunks[i]!, posOff);
    colors.set(colorsChunks[i]!, colOff);
    posOff += positionsChunks[i]!.length;
    colOff += colorsChunks[i]!.length;
  }

  // Expand each placement into one-or-more instances, each referencing a block.
  const placements: LocPlacement[] = [];
  for (const p of locDef.locations) {
    for (const draw of expandPlacement(p.type, p.orientation)) {
      const idx = blockIndexByKey.get(drawKey(p.id, draw.modelType, draw.bakedRotation));
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

  const manifest: LocsManifest = {
    schemaVersion: 1,
    blocks,
    placements,
    positionsByteLength: positions.byteLength,
    colorsByteLength: colors.byteLength,
    positionsFile: "locs.pos.bin",
    colorsFile: "locs.col.bin",
    skippedLocIds: Array.from(skipped).sort((a, b) => a - b),
  };

  console.log(
    `[locs] ${blocks.length} blocks, ${placements.length} placements, ` +
      `${skipped.size} locIds skipped (noDef=${skipReasons.noDef} noModel=${skipReasons.noModel} empty=${skipReasons.emptyModel} err=${skipReasons.error})`,
  );
  return { manifest, positions, colors };
}

function emptyLocs(): BakedLocs {
  return {
    manifest: {
      schemaVersion: 1,
      blocks: [],
      placements: [],
      positionsByteLength: 0,
      colorsByteLength: 0,
      positionsFile: "locs.pos.bin",
      colorsFile: "locs.col.bin",
      skippedLocIds: [],
    },
    positions: new Float32Array(0),
    colors: new Uint8Array(0),
  };
}

export async function writeLocsBundle(baked: BakedLocs, outDir: string): Promise<void> {
  await writeFile(join(outDir, baked.manifest.positionsFile), Buffer.from(baked.positions.buffer));
  await writeFile(join(outDir, baked.manifest.colorsFile), Buffer.from(baked.colors.buffer));
  await writeFile(join(outDir, "locs.json"), JSON.stringify(baked.manifest));
  console.log(
    `[locs] wrote locs bundle: ${(baked.manifest.positionsByteLength / 1024).toFixed(1)} KB pos, ` +
      `${(baked.manifest.colorsByteLength / 1024).toFixed(1)} KB col`,
  );
}
