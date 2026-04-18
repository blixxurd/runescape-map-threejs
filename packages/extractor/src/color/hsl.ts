/**
 * Jagex HSL ↔ RGB math, lifted from the 2004–2007 client and cross-checked
 * against osrscachereader's GLTFExporter.
 *
 * OSRS packs face colors and underlay/overlay colors as a 16-bit HSL:
 *   bits 10..15 = hue (0..63)
 *   bits  7..9  = saturation (0..7)
 *   bits  0..6  = luminance (0..127)
 *
 * This module exposes:
 *   - `hsl16ToRgb(hsl, brightness)` — the exact conversion the client uses
 *     when rendering face colors. `brightness` is the ambient-lighting
 *     gamma; the client uses 0.6 as "max brightness" in the options menu.
 *   - `blendUnderlayCorner(...)` — HSL-space neighbor averaging for terrain
 *     underlay vertex colors (the smooth-ground look).
 */

const HUE_OFFSET = 0.5 / 64;
const SATURATION_OFFSET = 0.5 / 8;

export function unpackHue(hsl16: number): number {
  return (hsl16 >> 10) & 63;
}
export function unpackSaturation(hsl16: number): number {
  return (hsl16 >> 7) & 7;
}
export function unpackLuminance(hsl16: number): number {
  return hsl16 & 127;
}

/** Re-pack hue/sat/lum into 16-bit HSL (hue 0..63, sat 0..7, lum 0..127). */
export function packHsl16(hue: number, sat: number, lum: number): number {
  return ((hue & 63) << 10) | ((sat & 7) << 7) | (lum & 127);
}

/**
 * Exact port of osrscachereader's HSLtoRGB + adjustForBrightness.
 * Output is [r, g, b] with 0..255 byte channels.
 *
 * `brightness` is the OSRS client's gamma exponent. Options in the client UI:
 *   1 (brightest): 0.6
 *   2:             0.7
 *   3 (normal):    0.8
 *   4 (dimmest):   0.9
 * We use 0.7 — noticeably punchier than "normal" but not the overblown
 * max-bright setting that washed out dark greens.
 */
export function hsl16ToRgb(hsl16: number, brightness = 0.75): [number, number, number] {
  const hue = unpackHue(hsl16) / 64 + HUE_OFFSET;
  const saturation = unpackSaturation(hsl16) / 8 + SATURATION_OFFSET;
  const luminance = unpackLuminance(hsl16) / 128;

  const chroma = (1 - Math.abs(2 * luminance - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue * 6) % 2) - 1));
  const lightness = luminance - chroma / 2;

  let r = lightness;
  let g = lightness;
  let b = lightness;

  switch (Math.trunc(hue * 6)) {
    case 0:
      r += chroma;
      g += x;
      break;
    case 1:
      g += chroma;
      r += x;
      break;
    case 2:
      g += chroma;
      b += x;
      break;
    case 3:
      b += chroma;
      g += x;
      break;
    case 4:
      b += chroma;
      r += x;
      break;
    default:
      r += chroma;
      b += x;
      break;
  }

  // gamma correction (brightness) — pow curves each channel
  r = Math.pow(r, brightness);
  g = Math.pow(g, brightness);
  b = Math.pow(b, brightness);

  const ri = Math.max(1, Math.min(255, Math.trunc(r * 256)));
  const gi = Math.max(0, Math.min(255, Math.trunc(g * 256)));
  const bi = Math.max(0, Math.min(255, Math.trunc(b * 256)));
  return [ri, gi, bi];
}

/**
 * Underlay blending, client-authentic.
 *
 * Each tile stores `hue` as a **pre-weighted** value (`hueMultiplier × hueWheel`)
 * plus `saturation`, `lightness`, and `hueMultiplier` separately. To get a
 * client-correct packed-HSL color at a tile you have to unweight the hue:
 *   avgHue = (sumOfHues * 256) / sumOfMultipliers
 * Failing to do this is what collapses Lumbridge's dark green grass into
 * the red-orange packed-HSL bucket.
 *
 * The client averages each tile with an 11×11 window (BLEND_RADIUS=5) of
 * its neighbors. We do the same so colors transition smoothly across
 * adjacent underlays.
 */
export interface UnderlayHsl {
  /** `hueMultiplier × hueWheel`. Keep pre-weighted; do not divide. */
  hue: number;
  saturation: number; // 0..255
  lightness: number; // 0..255
  hueMultiplier: number;
}

const BLEND_RADIUS = 5;

/**
 * Client-authentic HSL-luminance scaling — port of `Landscape.mixLightness`
 * (terrain) and `Model.method816` (locs). Scales ONLY the 7 luminance bits
 * of a packed HSL, preserving hue+saturation. A scalar RGB multiply would
 * desaturate colors on slopes / in shade; this doesn't.
 *
 *   newLum = clamp(lightness × (hsl & 0x7f) / 128, 2, 126)
 *   return (hsl & 0xff80) | newLum
 */
export function mixLightness(hsl16: number, lightness: number): number {
  let newLum = (lightness * (hsl16 & 0x7f)) >> 7;
  if (newLum < 2) newLum = 2;
  else if (newLum > 126) newLum = 126;
  return (hsl16 & 0xff80) | newLum;
}

/**
 * Pack 0..255 `(hue, saturation, lightness)` into a 16-bit palette index.
 * Client-authentic saturation halving: for bright lightness values the
 * saturation is halved repeatedly so that saturation=256 doesn't overflow
 * the 3 bits reserved for it in the packed format. Port of
 * `Landscape.generateHslBitset`.
 */
export function packHsl16Client(h: number, s: number, l: number): number {
  if (l > 179) s = s >> 1;
  if (l > 192) s = s >> 1;
  if (l > 217) s = s >> 1;
  if (l > 243) s = s >> 1;
  // Not masked — client doesn't mask either; bits can overflow.
  return ((h >> 2) << 10) | ((s >> 5) << 7) | (l >> 1);
}

/**
 * Given a grid of per-tile `UnderlayHsl` (or null for "no underlay"), return
 * a grid of per-tile packed HSL colors (or -1 for "no underlay at this tile").
 * Tiles with no underlay don't contribute to the sum.
 *
 * Output is indexed `[z * size + x]` where `size` = number of tiles on a side
 * (not vertices). The emitTileTriangles consumer samples this grid at the
 * corner positions it needs.
 */
export function blendUnderlayTiles(
  tiles: (UnderlayHsl | null)[],
  size: number,
): Int32Array {
  const out = new Int32Array(size * size).fill(-1);

  for (let xi = 0; xi < size; xi++) {
    for (let zi = 0; zi < size; zi++) {
      if (!tiles[zi * size + xi]) continue; // no underlay here → skip

      let hueSum = 0;
      let satSum = 0;
      let lumSum = 0;
      let mulSum = 0;
      let count = 0;

      const x0 = Math.max(0, xi - BLEND_RADIUS);
      const x1 = Math.min(size - 1, xi + BLEND_RADIUS);
      const z0 = Math.max(0, zi - BLEND_RADIUS);
      const z1 = Math.min(size - 1, zi + BLEND_RADIUS);

      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const u = tiles[z * size + x];
          if (!u) continue;
          hueSum += u.hue;
          satSum += u.saturation;
          lumSum += u.lightness;
          mulSum += u.hueMultiplier;
          count++;
        }
      }

      if (count === 0 || mulSum === 0) continue;

      const avgHue = Math.trunc((hueSum * 256) / mulSum); // 0..256 normalized hue
      const avgSat = Math.trunc(satSum / count); // 0..255
      const avgLum = Math.trunc(lumSum / count); // 0..255

      out[zi * size + xi] = packHsl16Client(avgHue, avgSat, avgLum);
    }
  }
  return out;
}
