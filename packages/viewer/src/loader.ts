import type { TerrainMeta, LocsManifest, TextureAtlas } from "@rsmap/shared";
import {
  TERRAIN_META_SCHEMA,
  LOCS_MANIFEST_SCHEMA,
  TEXTURE_ATLAS_SCHEMA,
} from "@rsmap/shared";

/**
 * Thrown when an on-disk bundle has a different schemaVersion than the
 * loader expects. In dev the loader catches this and triggers a re-extract;
 * in static-deploy mode it propagates so the UI can tell the user to rerun
 * `pnpm extract`. Different artifacts on the same region can mismatch
 * independently — `artifact` says which.
 */
export class StaleBundleError extends Error {
  constructor(
    public readonly regionId: number,
    public readonly artifact: "terrain.meta" | "locs" | "atlas",
    public readonly found: number,
    public readonly expected: number,
  ) {
    super(
      `region ${regionId} ${artifact}.json has schemaVersion ${found}, ` +
        `expected ${expected}. Re-run \`pnpm extract -- --region ${regionId}\`.`,
    );
    this.name = "StaleBundleError";
  }
}

/**
 * Fetches a region bundle written by the extractor:
 *   packages/viewer/public/regions/<id>/
 *     terrain.meta.json, terrain.pos.bin, terrain.col.bin, terrain.heights.bin
 *     locs.json, locs.pos.bin, locs.col.bin
 *
 * Everything is served as static assets by Vite (no processing in the
 * viewer — the extractor already baked them into Three-ready shapes).
 *
 * When a bundle is missing, we fall back to the dev server's auto-extract
 * middleware (see `vite.config.ts`) and retry. In `vite build` output the
 * middleware is absent, so a 404 stays a 404.
 */

export interface RegionData {
  terrainMeta: TerrainMeta;
  terrainPositions: Float32Array;
  terrainColors: Uint8Array;
  terrainUvs: Float32Array;
  terrainHeights: Int16Array;
  /** Plane-major Uint8 (4 × 64 × 64). 1 = blocked tile per
   *  `tile.settings & 0x1` (gameplay-blocked, not render). */
  terrainBlocked: Uint8Array;

  atlas: TextureAtlas;
  atlasUrl: string;

  locs: LocsManifest;
  locsPositions: Float32Array;
  locsColors: Uint8Array;
  locsUvs: Float32Array;
  /** Per-frame positions for animated blocks. Frame N of block B lives at
   *  `block.animation.framesByteOffset / 4 + N × vertexCount × 3`. Empty
   *  when no animated blocks exist in the region. */
  locsFramesPositions: Float32Array;
  /** Per-placement stable ID, parallel to `locs.placements` by index.
   *  Uint32 hash from the extractor; the viewer converts it to the hex form
   *  used as a "remove" entry in the active save when a baked loc is
   *  deleted. Empty when the region has no placements. */
  locsPlacementIds: Uint32Array;
}

export type LoadPhase =
  | { phase: "fetching" }
  | { phase: "extracting" }
  | { phase: "ready" };

export interface LoadRegionOptions {
  /** Called when the loader changes state (fetching → extracting → fetching). */
  onPhaseChange?: (phase: LoadPhase) => void;
  /** If false, skip the auto-extract fallback on 404 — behaves like a pure
   *  static fetch. Used by `vite build` output and tests. */
  autoExtract?: boolean;
}

class MissingBundleError extends Error {}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (r.status === 404) throw new MissingBundleError(`GET ${url} → 404`);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.arrayBuffer();
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 404) throw new MissingBundleError(`GET ${url} → 404`);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Asks the dev server to extract this region. Resolves when the bundle is
 * on disk; throws when the region has no map data (404) or the extractor
 * fails (500). The middleware serializes requests, so many concurrent
 * callers for the same region will share one extraction.
 */
async function requestExtraction(regionId: number): Promise<void> {
  const r = await fetch(`/api/extract/${regionId}`, { method: "POST" });
  if (r.ok) return;
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  throw new Error(
    r.status === 404
      ? `region ${regionId} has no map data`
      : `extract ${regionId} failed (${r.status}): ${body.error ?? "unknown"}`,
  );
}

async function fetchBundle(regionId: number): Promise<RegionData> {
  const base = `/regions/${regionId}`;
  const [terrainMeta, locs, atlas] = await Promise.all([
    fetchJson<TerrainMeta>(`${base}/terrain.meta.json`),
    fetchJson<LocsManifest>(`${base}/locs.json`),
    fetchJson<TextureAtlas>(`${base}/atlas.json`),
  ]);

  // Schema-version guard. Older bundles silently dropping new fields was
  // a Phase 1 concern — explicit failure forces a re-extract instead.
  if (terrainMeta.schemaVersion !== TERRAIN_META_SCHEMA) {
    throw new StaleBundleError(
      regionId,
      "terrain.meta",
      terrainMeta.schemaVersion,
      TERRAIN_META_SCHEMA,
    );
  }
  if (locs.schemaVersion !== LOCS_MANIFEST_SCHEMA) {
    throw new StaleBundleError(
      regionId,
      "locs",
      locs.schemaVersion,
      LOCS_MANIFEST_SCHEMA,
    );
  }
  if (atlas.schemaVersion !== TEXTURE_ATLAS_SCHEMA) {
    throw new StaleBundleError(
      regionId,
      "atlas",
      atlas.schemaVersion,
      TEXTURE_ATLAS_SCHEMA,
    );
  }

  const [
    terrainPosBuf,
    terrainColBuf,
    terrainUvBuf,
    terrainHtsBuf,
    terrainBlockedBuf,
    locsPosBuf,
    locsColBuf,
    locsUvBuf,
    locsFramesBuf,
    locsPlacementIdsBuf,
  ] = await Promise.all([
    fetchBinary(`${base}/${terrainMeta.positionsFile}`),
    fetchBinary(`${base}/${terrainMeta.colorsFile}`),
    fetchBinary(`${base}/${terrainMeta.uvsFile}`),
    fetchBinary(`${base}/${terrainMeta.heightsFile}`),
    fetchBinary(`${base}/${terrainMeta.blockedFile}`),
    locs.positionsByteLength > 0
      ? fetchBinary(`${base}/${locs.positionsFile}`)
      : Promise.resolve(new ArrayBuffer(0)),
    locs.colorsByteLength > 0
      ? fetchBinary(`${base}/${locs.colorsFile}`)
      : Promise.resolve(new ArrayBuffer(0)),
    locs.uvsByteLength > 0
      ? fetchBinary(`${base}/${locs.uvsFile}`)
      : Promise.resolve(new ArrayBuffer(0)),
    locs.framesFile
      ? fetchBinary(`${base}/${locs.framesFile}`)
      : Promise.resolve(new ArrayBuffer(0)),
    locs.placementIdsByteLength > 0
      ? fetchBinary(`${base}/${locs.placementIdsFile}`)
      : Promise.resolve(new ArrayBuffer(0)),
  ]);

  return {
    terrainMeta,
    terrainPositions: new Float32Array(terrainPosBuf),
    terrainColors: new Uint8Array(terrainColBuf),
    terrainUvs: new Float32Array(terrainUvBuf),
    terrainHeights: new Int16Array(terrainHtsBuf),
    terrainBlocked: new Uint8Array(terrainBlockedBuf),
    atlas,
    atlasUrl: `${base}/${atlas.atlasFile}`,
    locs,
    locsPositions: new Float32Array(locsPosBuf),
    locsColors: new Uint8Array(locsColBuf),
    locsUvs: new Float32Array(locsUvBuf),
    locsFramesPositions: new Float32Array(locsFramesBuf),
    locsPlacementIds: new Uint32Array(locsPlacementIdsBuf),
  };
}

export async function loadRegion(
  regionId: number,
  opts: LoadRegionOptions = {},
): Promise<RegionData> {
  const { onPhaseChange, autoExtract = true } = opts;
  onPhaseChange?.({ phase: "fetching" });
  try {
    const data = await fetchBundle(regionId);
    onPhaseChange?.({ phase: "ready" });
    return data;
  } catch (err) {
    // Two conditions trigger a re-extract in dev: bundle missing entirely,
    // or bundle present but schema is older than the loader expects (e.g.
    // schema bumped since last extract). Both are caller-friendly.
    const recoverable =
      err instanceof MissingBundleError || err instanceof StaleBundleError;
    if (!autoExtract || !recoverable) throw err;
    if (err instanceof StaleBundleError) {
      console.warn(`[loader] ${err.message} — auto re-extracting.`);
    }
    onPhaseChange?.({ phase: "extracting" });
    await requestExtraction(regionId);
    onPhaseChange?.({ phase: "fetching" });
    const data = await fetchBundle(regionId);
    onPhaseChange?.({ phase: "ready" });
    return data;
  }
}
