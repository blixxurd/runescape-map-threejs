/**
 * Texture atlas builder.
 *
 * OSRS stores textures as 64×64 or 128×128 palette-indexed sprites. For the
 * Three.js viewer we want a single GL texture so the terrain (and later locs)
 * can render in one draw call. We pack every texture referenced by the region
 * into a square atlas, keyed by OSRS texture id.
 *
 * Cell 0 is always a solid white 1×1 texel expanded to the atlas cell size.
 * Vertices that don't reference any texture map to cell 0, so the sampled
 * color is `(1, 1, 1, 1)` and the vertex color passes through unchanged.
 */

import type { RSCache } from "osrscachereader";
import { IndexType } from "osrscachereader";
// @ts-ignore - canvas is a transitive dep of osrscachereader, no types package
import { createCanvas } from "canvas";
import type { TextureAtlas } from "@rsmap/shared";

/** Target cell size; most OSRS ground textures are 128×128. */
const CELL_SIZE = 128;

interface TextureDef {
  id: number;
  fileIds: number[];
  sprites?: Sprite[];
}

interface Sprite {
  width: number;
  height: number;
  maxWidth?: number;
  maxHeight?: number;
  offsetX?: number;
  offsetY?: number;
  /** Each pixel is ARGB int32 as produced by osrscachereader's SpriteLoader. */
  pixels: number[];
}

/**
 * Resolve one texture id → its primary sprite's RGBA pixels, resized to
 * CELL_SIZE × CELL_SIZE. Returns null if the texture or sprite can't be
 * decoded (swallowed so one bad texture doesn't fail the whole atlas).
 */
async function fetchTexturePixels(cache: RSCache, textureId: number): Promise<Uint8ClampedArray | null> {
  let def: TextureDef | undefined;
  try {
    // TEXTURES index has a single archive (0) whose files are the texture
    // definitions keyed by texture id.
    def = (await cache.getDef(IndexType.TEXTURES, 0, textureId, {
      loadSprites: true,
    })) as TextureDef | undefined;
  } catch (e) {
    console.warn(`[tex] getDef(TEXTURES, ${textureId}) failed: ${(e as Error).message}`);
    return null;
  }
  if (!def) return null;

  // Sprite def wraps an array of sprites (for animated textures). M1.5 just
  // uses the first frame.
  const spriteFile = def.sprites?.[0];
  // SpriteLoader returns a SpriteDefinition with .sprites[] inside; the
  // library wraps them so the shape is `def.sprites[0]` = sprite definition
  // (frame container). Walk another level if needed.
  const sprite: Sprite | undefined =
    (spriteFile as unknown as { def?: { sprites?: Sprite[] } })?.def?.sprites?.[0] ??
    (spriteFile as unknown as { sprites?: Sprite[] })?.sprites?.[0] ??
    (spriteFile as Sprite | undefined);
  if (!sprite || !sprite.pixels || sprite.pixels.length === 0) {
    console.warn(`[tex] texture ${textureId} has no sprite pixels`);
    return null;
  }

  const w = sprite.width;
  const h = sprite.height;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const argb = sprite.pixels[i]!;
    src[i * 4 + 0] = (argb >> 16) & 0xff; // R
    src[i * 4 + 1] = (argb >> 8) & 0xff; // G
    src[i * 4 + 2] = argb & 0xff; // B
    // SpriteLoader encodes alpha as 254 - ((argb>>24)&0xff) in its canvas
    // output, but the stored pixels have 0xFF for opaque and 0x00 for
    // transparent after the palette lookup. Pass through as-is.
    const a = (argb >> 24) & 0xff;
    src[i * 4 + 3] = a === 0 ? 0 : 255;
  }

  // Resize to CELL_SIZE using nearest-neighbor for that crisp OSRS look.
  if (w === CELL_SIZE && h === CELL_SIZE) return src;
  const dst = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4);
  for (let y = 0; y < CELL_SIZE; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / CELL_SIZE));
    for (let x = 0; x < CELL_SIZE; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / CELL_SIZE));
      const si = (sy * w + sx) * 4;
      const di = (y * CELL_SIZE + x) * 4;
      dst[di + 0] = src[si + 0]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
  return dst;
}

export interface BakedAtlas {
  manifest: TextureAtlas;
  pngBytes: Buffer;
}

/** Write the atlas PNG + manifest JSON alongside other region bundle files. */
export async function writeAtlas(atlas: BakedAtlas, outDir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await writeFile(join(outDir, atlas.manifest.atlasFile), atlas.pngBytes);
  await writeFile(join(outDir, "atlas.json"), JSON.stringify(atlas.manifest, null, 2));
}

/**
 * Build an atlas covering the provided texture ids. Returns the manifest
 * and the PNG file bytes to write to disk.
 */
export async function buildAtlas(cache: RSCache, textureIds: Iterable<number>): Promise<BakedAtlas> {
  const ids = [...new Set(textureIds)].sort((a, b) => a - b);
  // +1 for the solid white cell at index 0.
  const cellCount = ids.length + 1;
  const cellsPerRow = Math.max(1, Math.ceil(Math.sqrt(cellCount)));
  const atlasSize = cellsPerRow * CELL_SIZE;

  console.log(`[tex] atlas: ${cellCount} cells (${cellsPerRow}×${cellsPerRow} grid, ${atlasSize}×${atlasSize}px)`);

  const canvas = createCanvas(atlasSize, atlasSize);
  const ctx = canvas.getContext("2d");

  // Cell 0: solid white.
  const white = new Uint8ClampedArray(CELL_SIZE * CELL_SIZE * 4).fill(255);
  const whiteImg = ctx.createImageData(CELL_SIZE, CELL_SIZE);
  whiteImg.data.set(white);
  ctx.putImageData(whiteImg, 0, 0);

  const cellByTextureId: Record<number, number> = {};
  const textureIdByCell: number[] = new Array(cellsPerRow * cellsPerRow).fill(-1);
  textureIdByCell[0] = -1;

  let nextCell = 1;
  for (const id of ids) {
    const rgba = await fetchTexturePixels(cache, id);
    if (!rgba) continue;
    const cx = (nextCell % cellsPerRow) * CELL_SIZE;
    const cy = Math.floor(nextCell / cellsPerRow) * CELL_SIZE;
    const img = ctx.createImageData(CELL_SIZE, CELL_SIZE);
    img.data.set(rgba);
    ctx.putImageData(img, cx, cy);
    cellByTextureId[id] = nextCell;
    textureIdByCell[nextCell] = id;
    nextCell++;
  }

  const pngBytes = canvas.toBuffer("image/png");
  console.log(`[tex] atlas PNG: ${(pngBytes.byteLength / 1024).toFixed(1)} KB`);

  return {
    manifest: {
      schemaVersion: 1,
      atlasFile: "atlas.png",
      atlasSize,
      cellSize: CELL_SIZE,
      cellsPerRow,
      cellByTextureId,
      textureIdByCell,
    },
    pngBytes,
  };
}

/**
 * Helper to turn a cell index + (u, v) within-cell into absolute atlas UVs.
 * u, v are both in [0, 1] for "within this texture".
 */
export function cellUV(
  atlas: TextureAtlas,
  cell: number,
  u: number,
  v: number,
): [number, number] {
  const cellU = cell % atlas.cellsPerRow;
  const cellV = Math.floor(cell / atlas.cellsPerRow);
  const cellFrac = 1 / atlas.cellsPerRow;
  // Inset by half a texel so linear filtering doesn't bleed adjacent cells.
  const inset = 0.5 / atlas.atlasSize;
  const uu = cellU * cellFrac + inset + (cellFrac - 2 * inset) * Math.max(0, Math.min(1, u));
  const vv = cellV * cellFrac + inset + (cellFrac - 2 * inset) * Math.max(0, Math.min(1, v));
  return [uu, vv];
}
