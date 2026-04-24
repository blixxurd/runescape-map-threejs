import type { ModelDefinition } from "osrscachereader";

/**
 * Client-authentic per-face lighting, ported from `Model.applyLighting` +
 * `Model.method816` in runejs/refactored-client-435's `Model.java`.
 *
 * The client bakes per-vertex lighting at model-load time and at render time
 * just multiplies texture × vertex color. We mirror that so the viewer can
 * use `MeshBasicMaterial` (no scene lights, no double-darken).
 *
 * Both the loc pipeline (`region/locs.ts`) and the NPC pipeline
 * (`npc/npcModel.ts`) call these helpers, so they live here. The only
 * inputs are the per-face normal (client-space, pre-Y/Z-flip) and the
 * ambient/contrast to use — either the base values or per-def overrides.
 *
 * Formula:
 *   magnitude     = |lightDir|
 *   contrastScale = contrast × magnitude / 256
 *   per-face:
 *     normal    = cross(edge1, edge2), scaled to |n| ≈ 256
 *     lightness = ambient + dot(lightDir, normal) / (contrastScale × 1.5)
 *                 // SIGNED — back-facing faces get very low lightness
 *   per-vertex:
 *     newLum    = clamp(lightness × (faceHsl & 0x7f) / 128, 2, 126)
 *     litHsl    = (faceHsl & 0xff80) | newLum
 *
 * `method816` scales the HSL luminance bits, preserving hue + saturation.
 * A naive RGB multiply would wash out saturated colors.
 */

export const BASE_AMBIENT = 64;
export const BASE_CONTRAST = 768;
const LIGHT_DIR_X = -50;
const LIGHT_DIR_Y = -10;
const LIGHT_DIR_Z = -50;
const LIGHT_MAG =
  Math.sqrt(
    LIGHT_DIR_X * LIGHT_DIR_X + LIGHT_DIR_Y * LIGHT_DIR_Y + LIGHT_DIR_Z * LIGHT_DIR_Z,
  ) | 0;

/**
 * Per-face lightness integer. `ambient` / `contrast` can be overridden per
 * object via the cache def's opcodes (29 / 39 on locs, 60 / 61 on NPCs).
 * Port of `Model.applyLighting` — `arg0`/`arg1` in the reference are
 * exactly the ambient/contrast the caller supplies.
 */
export function faceLightness(
  nxRaw: number,
  nyRaw: number,
  nzRaw: number,
  ambient: number,
  contrast: number,
): number {
  const len = Math.sqrt(nxRaw * nxRaw + nyRaw * nyRaw + nzRaw * nzRaw);
  if (len === 0) return ambient;
  const nx = ((nxRaw * 256) / len) | 0;
  const ny = ((nyRaw * 256) / len) | 0;
  const nz = ((nzRaw * 256) / len) | 0;
  const dot = LIGHT_DIR_X * nx + LIGHT_DIR_Y * ny + LIGHT_DIR_Z * nz;
  const contrastScale = (contrast * LIGHT_MAG) >> 8;
  const divisor = contrastScale + (contrastScale >> 1);
  return ambient + ((dot / divisor) | 0);
}

/** HSL luminance-only adjustment — port of `method816`. Preserves H and S. */
export function applyLightToHsl(hsl: number, lightness: number): number {
  let newLum = (lightness * (hsl & 0x7f)) >> 7;
  if (newLum < 2) newLum = 2;
  else if (newLum > 126) newLum = 126;
  return (hsl & 0xff80) | newLum;
}

/**
 * OSRS applies per-object face recolors via `recolorToFind → recolorToReplace`.
 * The osrscachereader `getModel` path reads the wrong field names
 * (`recolorFrom` / `retextureFrom`) and silently no-ops, so both locs and
 * NPCs apply these substitutions themselves after the library returns.
 */
export function applyFaceColorSubstitution(
  model: ModelDefinition,
  from: number[] | undefined,
  to: number[] | undefined,
): void {
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

/** Texture-id substitution twin of `applyFaceColorSubstitution`. */
export function applyFaceTextureSubstitution(
  model: ModelDefinition,
  from: number[] | undefined,
  to: number[] | undefined,
): void {
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
