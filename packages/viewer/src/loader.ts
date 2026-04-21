import type { TerrainMeta, LocsManifest, TextureAtlas } from "@rsmap/shared";

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

  const [
    terrainPosBuf,
    terrainColBuf,
    terrainUvBuf,
    terrainHtsBuf,
    locsPosBuf,
    locsColBuf,
    locsUvBuf,
    locsFramesBuf,
  ] = await Promise.all([
    fetchBinary(`${base}/${terrainMeta.positionsFile}`),
    fetchBinary(`${base}/${terrainMeta.colorsFile}`),
    fetchBinary(`${base}/${terrainMeta.uvsFile}`),
    fetchBinary(`${base}/${terrainMeta.heightsFile}`),
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
  ]);

  return {
    terrainMeta,
    terrainPositions: new Float32Array(terrainPosBuf),
    terrainColors: new Uint8Array(terrainColBuf),
    terrainUvs: new Float32Array(terrainUvBuf),
    terrainHeights: new Int16Array(terrainHtsBuf),
    atlas,
    atlasUrl: `${base}/${atlas.atlasFile}`,
    locs,
    locsPositions: new Float32Array(locsPosBuf),
    locsColors: new Uint8Array(locsColBuf),
    locsUvs: new Float32Array(locsUvBuf),
    locsFramesPositions: new Float32Array(locsFramesBuf),
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
    if (!autoExtract || !(err instanceof MissingBundleError)) throw err;
    onPhaseChange?.({ phase: "extracting" });
    await requestExtraction(regionId);
    onPhaseChange?.({ phase: "fetching" });
    const data = await fetchBundle(regionId);
    onPhaseChange?.({ phase: "ready" });
    return data;
  }
}
