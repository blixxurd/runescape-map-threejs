/**
 * 32-bit FNV-1a hash → 8-char lowercase hex. Stable per-placement identity
 * derived purely from cache-record fields — no I/O, no repo-relative paths.
 *
 * Written into `locs.placementIds.bin` by `emitLocs` (`./locs.js`) and read
 * back by the viewer's save system (`packages/viewer/src/saves/`), which
 * keys baked-loc "removes" (tombstones) by this hash so a deleted baked loc
 * stays hidden across a re-extract. Don't change the algorithm without
 * bumping `LOCS_MANIFEST_SCHEMA` — existing saves reference hashes by this
 * exact value and would silently stop matching.
 *
 * Collision: at ~10k placements per region the birthday bound puts the
 * chance of any two distinct placements colliding at ~10⁻⁵; across the
 * ~50k regions in OSRS that's a few collisions. When two distinct cache
 * records collide, one tombstone deletes both — acceptable for v1; widen
 * to 64-bit if it bites in practice.
 */
export function placementHash(
  plane: number,
  localX: number,
  localZ: number,
  locId: number,
  type: number,
  rotation: number,
): string {
  let h = 0x811c9dc5;
  // Mix each input byte-by-byte so small numeric changes yield far-apart
  // hashes (FNV's design intent). Four bytes is plenty of width for every
  // input — locId tops out at ~40k, plane 0..3, tile coords 0..63.
  const inputs = [plane, localX, localZ, locId, type, rotation];
  for (const v of inputs) {
    h ^= v & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
