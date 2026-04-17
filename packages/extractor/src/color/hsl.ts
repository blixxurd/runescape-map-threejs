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
 */
export function hsl16ToRgb(hsl16: number, brightness = 0.6): [number, number, number] {
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
 * Underlay corner blending.
 *
 * At every tile-grid vertex we average HSL of the 4 surrounding tiles'
 * underlays (with saturation×lightness as weight), skipping tiles whose
 * underlayId is 0. This is the well-known "smooth ground" technique from
 * the RS2 client — distilled here from RuneLite's ProceduralGenerator.
 *
 * Input arrays are plane-major: underlayIdGrid[z * 64 + x]. For vertices on
 * the north/east border of the region we sample only the in-region tiles;
 * cross-region blending is deliberately skipped for M1 (TODO later).
 */
export interface UnderlayHsl {
  hue: number;
  saturation: number;
  lightness: number;
}

export function blendUnderlayCorner(
  tileVx: number,
  tileVz: number,
  underlaysByTile: (UnderlayHsl | null)[],
  gridSize: number, // 64
): [number, number, number] | null {
  // 4 tiles meet at (tileVx, tileVz): [vx-1, vz-1], [vx, vz-1], [vx-1, vz], [vx, vz]
  let hue = 0;
  let sat = 0;
  let lum = 0;
  let hueWeight = 0;
  let count = 0;
  for (let dz = -1; dz <= 0; dz++) {
    for (let dx = -1; dx <= 0; dx++) {
      const tx = tileVx + dx;
      const tz = tileVz + dz;
      if (tx < 0 || tz < 0 || tx >= gridSize || tz >= gridSize) continue;
      const u = underlaysByTile[tz * gridSize + tx];
      if (!u) continue;
      // Jagex weights hue by (saturation * lightness) so very grey/dark
      // neighbors don't pull the hue. See RuneLite's TerrainGenerator.
      hue += u.hue * u.saturation * u.lightness;
      hueWeight += u.saturation * u.lightness;
      sat += u.saturation;
      lum += u.lightness;
      count++;
    }
  }
  if (count === 0) return null;

  const h = hueWeight > 0 ? Math.trunc(hue / hueWeight) : 0;
  const s = Math.trunc(sat / count);
  const l = Math.trunc(lum / count);
  return hsl16ToRgb(packHsl16(h, s, l));
}
