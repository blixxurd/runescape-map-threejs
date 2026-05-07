import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { EDITS_SCHEMA, type EditsOverlay, type EditsOverlayAdd } from "@rsmap/shared";

// Resolve the repo root from this file's location rather than importing
// REPO_ROOT from `../index.js` — the index module imports `./region/locs.js`
// which transitively imports this file, so pulling REPO_ROOT through that
// path would form a circular import.
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * On-disk overlay support for the in-viewer "commit edits" feature.
 *
 * Source data, NOT a regenerated artifact: `edits/<regionId>.json` is checked
 * into git so user edits survive `rm -rf packages/viewer/public/regions/`
 * and `pnpm extract`. The extractor reads the overlay every region build via
 * `loadEdits` and applies its `removes` / `adds` inside `emitLocs`.
 *
 * Cache discipline: `loadEdits` opens and parses the file on every call.
 * The dev-server `commit-edits` endpoint writes via `saveEdits` and
 * immediately re-runs `extractRegion`, so we MUST NOT memoize the parsed
 * result anywhere — a cached overlay would let a commit fire while the
 * extractor still saw the previous state.
 */

export const EDITS_DIR = join(REPO_ROOT, "packages/extractor/edits");

/**
 * Read the overlay for a region from disk. Returns `null` when no overlay
 * exists (the common case — most regions have never been edited). Throws on
 * any other error: unexpected JSON shape, schema mismatch, IO failure. We
 * deliberately don't fall back to "ignore unreadable overlay" — silently
 * swallowing that would let a botched edit corrupt the bake without warning.
 */
export async function loadEdits(regionId: number): Promise<EditsOverlay | null> {
  const path = join(EDITS_DIR, `${regionId}.json`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<EditsOverlay>;
  if (parsed.schemaVersion !== EDITS_SCHEMA) {
    throw new Error(
      `[edits] ${path}: schemaVersion ${parsed.schemaVersion} != expected ${EDITS_SCHEMA}`,
    );
  }
  if (parsed.regionId !== regionId) {
    throw new Error(
      `[edits] ${path}: regionId ${parsed.regionId} != filename region ${regionId}`,
    );
  }
  if (!Array.isArray(parsed.removes) || !Array.isArray(parsed.adds)) {
    throw new Error(`[edits] ${path}: malformed overlay (removes/adds not arrays)`);
  }
  return parsed as EditsOverlay;
}

/**
 * Atomic write: stage to `<id>.json.tmp`, then rename. A crash mid-write
 * leaves either the old file or no file — never a half-written one. Source
 * data corruption would mean lost user edits, hence the belt+braces.
 */
export async function saveEdits(overlay: EditsOverlay): Promise<void> {
  const path = join(EDITS_DIR, `${overlay.regionId}.json`);
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  // Pretty-print so a human can diff the file in code review — overlays are
  // small (kilobytes at most) and version-controlled, so legibility wins
  // over byte count.
  await writeFile(tmpPath, JSON.stringify(overlay, null, 2));
  await rename(tmpPath, path);
}

/**
 * Merge a diff into the on-disk overlay for a region and save atomically.
 * `removes` are unioned (sets); `adds` are appended (no dedupe — duplicate
 * tile-add ops would each become an extra placement, which is correct: a
 * user dropping two of the same loc on one tile is a real intent, not an
 * accident).
 *
 * The dev-server `commit-edits` endpoint owns ordering: it MUST await any
 * in-flight extract for the region before calling this, so the bundle the
 * extract writes doesn't read a stale overlay.
 */
export async function mergeAndSaveEdits(
  regionId: number,
  diff: { removes?: string[]; adds?: EditsOverlayAdd[] },
): Promise<EditsOverlay> {
  const existing = (await loadEdits(regionId)) ?? {
    schemaVersion: EDITS_SCHEMA,
    regionId,
    removes: [],
    adds: [],
  };
  const merged: EditsOverlay = {
    schemaVersion: EDITS_SCHEMA,
    regionId,
    removes: Array.from(new Set([...existing.removes, ...(diff.removes ?? [])])).sort(),
    adds: [...existing.adds, ...(diff.adds ?? [])],
  };
  await saveEdits(merged);
  return merged;
}

/**
 * 32-bit FNV-1a hash → 8-char lowercase hex. Stable across the extractor
 * (where placement IDs are written into `locs.placementIds.bin`) and the
 * dev-server commit endpoint (which receives hex IDs from the viewer to
 * tombstone). Don't change the algorithm without bumping the bundle schema —
 * existing overlays would silently stop matching.
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
