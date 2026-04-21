/**
 * Monkey-patch `osrscachereader`'s `UnderlayLoader` and `OverlayLoader` so
 * they read the full opcode set used by modern OSRS caches — most
 * importantly **`textureId`**, which is what the client uses to render
 * grass/dirt/stone patterns on the ground.
 *
 * Without these patches:
 *   - `UnderlayLoader` knows only opcode 1 (flat RGB). Opcode 2 (textureId
 *     uint16) and 3–5 are silently dropped. Every ground tile renders as a
 *     flat pastel from the blended HSL — the "Lumbridge in the desert" look.
 *   - `OverlayLoader` knows opcodes 1, 2 (uint8 textureId), 5, 7. Modern
 *     caches use opcode 3 (uint16 textureId for textures > 255). Also
 *     misses 6, 8–16. Opcode 3 in particular causes most overlay textures
 *     to go undetected.
 *
 * Canonical opcode set cribbed from `dennisdev/rs-map-viewer`'s
 * `UnderlayFloorType.ts` and `OverlayFloorType.ts` (both of which track the
 * live OSRS client).
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);

interface RsDataView {
  readUint8(): number;
  readUint16(): number;
  readInt24(): number;
  readString(): string;
  getPosition(): number;
  setPosition(pos: number): void;
}

/**
 * Reads an unsigned 24-bit RGB value (hi→lo). The library's `readInt24`
 * composes three bytes via `(getInt16 << 8) | getInt8`, but `getInt8`
 * sign-extends a 0xFF low byte to 0xFFFFFFFF, clobbering the high bytes in
 * the OR. That makes e.g. 0xFF00FF (magenta, the invisible-overlay
 * sentinel) indistinguishable from 0xFFFFFF (white) — both come back as
 * `-1`. Reading three unsigned bytes directly gives a clean uint24.
 */
function readUint24(dv: RsDataView): number {
  const b0 = dv.readUint8();
  const b1 = dv.readUint8();
  const b2 = dv.readUint8();
  return ((b0 << 16) | (b1 << 8) | b2) >>> 0;
}

interface UnderlayDef {
  id: number;
  color?: number;
  /** Raw 0xRRGGBB from opcode 1, captured before the library's HSL pack
   *  overwrites `.color`. */
  rawRgb?: number;
  textureId?: number;
  textureSize?: number;
  blockShadow?: boolean;
  /** The hue-multiplier from `loadHsl` — needed to correctly pack a blended
   *  hue via `avgHue = (sumHue * 256) / sumMul`. Not saved by the library. */
  hueMultiplier?: number;
}

interface OverlayDef {
  id: number;
  color?: number;
  texture?: number;
  secondaryTextureId?: number;
  hideUnderlay?: boolean;
  secondaryColor?: number;
  textureSize?: number;
  blockShadow?: boolean;
  name?: string;
  /** Raw 0xRRGGBB captured before the library's `convertToHsl` overwrites
   *  `def.color` with the HSL16 pack. Used to detect the magenta (0xFF00FF)
   *  "invisible overlay" sentinel that the OSRS client honors. */
  rawPrimaryRgb?: number;
}

let patched = false;

export async function patchFloorLoaders(): Promise<void> {
  if (patched) return;
  const mainPath = require_.resolve("osrscachereader");
  const toUrl = (file: string): string =>
    pathToFileURL(mainPath.replace(/index\.js$/, file)).href;

  // See objectLoader.ts for why we wrap `import()` in `new Function`: it
  // hides the call from Vite's SSR transform so a plain `file://` URL
  // reaches Node's native ESM loader intact.
  const nativeImport = new Function("url", "return import(url)") as (u: string) => Promise<unknown>;
  const underlayMod = (await nativeImport(toUrl("cacheReader/loaders/UnderlayLoader.js"))) as {
    default: new () => {
      handleOpcode: (def: UnderlayDef, opcode: number, dv: RsDataView) => void;
      loadHsl: (def: UnderlayDef) => void;
      packHsl: (def: UnderlayDef) => void;
      load: (bytes: Uint8Array, id: number) => UnderlayDef;
    };
  };
  const overlayMod = (await nativeImport(toUrl("cacheReader/loaders/OverlayLoader.js"))) as {
    default: new () => {
      handleOpcode: (def: OverlayDef, opcode: number, dv: RsDataView) => void;
    };
  };

  // Replace handleOpcode with the modern opcode table.
  underlayMod.default.prototype.handleOpcode = function (
    def: UnderlayDef,
    opcode: number,
    dv: RsDataView,
  ): void {
    if (opcode === 0) return;
    if (opcode === 1) {
      const rgb = readUint24(dv);
      def.color = rgb;
      def.rawRgb = rgb;
    } else if (opcode === 2) {
      const t = dv.readUint16();
      def.textureId = t === 0xffff ? -1 : t;
    } else if (opcode === 3) {
      def.textureSize = dv.readUint16();
    } else if (opcode === 4) {
      def.blockShadow = false;
    } else if (opcode === 5) {
      // intentional no-op in the client
    }
  };

  // Replace `loadHsl` to ALSO persist hueMultiplier on the def. The stock
  // library computes it and then discards it — but it's what the client
  // uses to correctly blend and pack neighbor underlay colors. Without it,
  // our packed HSL gets the hue bits from a pre-weighted value, which
  // collapses dark greens into the red-orange bucket.
  // Formula is the exact client-authentic HSL derivation, ported from
  // `UnderlayFloorType.setHsl` in dennisdev/rs-map-viewer.
  underlayMod.default.prototype.loadHsl = function (def: UnderlayDef): void {
    const rgb = def.color ?? 0;
    const r = ((rgb >> 16) & 0xff) / 256.0;
    const g = ((rgb >> 8) & 0xff) / 256.0;
    const b = (rgb & 0xff) / 256.0;

    const minRgb = Math.min(r, g, b);
    const maxRgb = Math.max(r, g, b);

    let hueWheel = 0.0;
    let sat = 0.0;
    const light = (maxRgb + minRgb) / 2.0;

    if (maxRgb !== minRgb) {
      if (light < 0.5) sat = (maxRgb - minRgb) / (maxRgb + minRgb);
      else sat = (maxRgb - minRgb) / (2.0 - maxRgb - minRgb);

      if (maxRgb === r) hueWheel = (g - b) / (maxRgb - minRgb);
      else if (maxRgb === g) hueWheel = 2.0 + (b - r) / (maxRgb - minRgb);
      else hueWheel = 4.0 + (r - g) / (maxRgb - minRgb);
    }
    hueWheel /= 6.0;

    let saturation = Math.trunc(sat * 256);
    let lightness = Math.trunc(light * 256);
    if (saturation < 0) saturation = 0;
    else if (saturation > 255) saturation = 255;
    if (lightness < 0) lightness = 0;
    else if (lightness > 255) lightness = 255;

    let hueMultiplier: number;
    if (light > 0.5) hueMultiplier = Math.trunc(512.0 * sat * (1.0 - light));
    else hueMultiplier = Math.trunc(512.0 * sat * light);
    if (hueMultiplier < 1) hueMultiplier = 1;

    (def as UnderlayDef & { hue: number; saturation: number; lightness: number }).hue =
      Math.trunc(hueMultiplier * hueWheel);
    (def as UnderlayDef & { hue: number; saturation: number; lightness: number }).saturation =
      saturation;
    (def as UnderlayDef & { hue: number; saturation: number; lightness: number }).lightness =
      lightness;
    def.hueMultiplier = hueMultiplier;
  };

  overlayMod.default.prototype.handleOpcode = function (
    def: OverlayDef,
    opcode: number,
    dv: RsDataView,
  ): void {
    if (opcode === 0) return;
    if (opcode === 1) {
      const rgb = readUint24(dv);
      def.color = rgb;
      // Library's `load()` will overwrite `def.color` with a 16-bit HSL pack
      // via `convertToHsl`, which loses the raw RGB. Save the raw value now
      // so terrain.ts can detect the magenta (0xFF00FF) invisible-overlay
      // sentinel the OSRS client uses.
      def.rawPrimaryRgb = rgb;
    } else if (opcode === 2) {
      // legacy 1-byte texture id (caches before textures > 255 existed)
      def.texture = dv.readUint8();
    } else if (opcode === 3) {
      // modern 2-byte texture id — MOST overlay textures in build 234+ use this
      const t = dv.readUint16();
      def.texture = t === 0xffff ? -1 : t;
    } else if (opcode === 5) {
      def.hideUnderlay = false;
    } else if (opcode === 6) {
      def.name = dv.readString();
    } else if (opcode === 7) {
      def.secondaryColor = readUint24(dv);
    } else if (opcode === 8) {
      // nothing (flag-only opcode in current client)
    } else if (opcode === 9) {
      def.textureSize = dv.readUint16();
    } else if (opcode === 10) {
      def.blockShadow = false;
    } else if (opcode === 11) {
      dv.readUint8(); // textureBrightness
    } else if (opcode === 12) {
      // blendTexture = true (no value)
    } else if (opcode === 13) {
      readUint24(dv); // underwaterColor (advance stream without storing)
    } else if (opcode === 14) {
      dv.readUint8(); // waterOpacity
    } else if (opcode === 15) {
      const t = dv.readUint16();
      def.secondaryTextureId = t === 0xffff ? -1 : t;
    } else if (opcode === 16) {
      dv.readUint8(); // unknown flag
    }
  };

  patched = true;
}
