import type { TerrainMeta, LocsManifest, TextureAtlas } from "@rsmap/shared";

/**
 * Fetches a region bundle written by the extractor:
 *   packages/viewer/public/regions/<id>/
 *     terrain.meta.json, terrain.pos.bin, terrain.col.bin, terrain.heights.bin
 *     locs.json, locs.pos.bin, locs.col.bin
 *
 * Everything is served as static assets by Vite (no processing in the
 * viewer — the extractor already baked them into Three-ready shapes).
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
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.arrayBuffer();
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}

export async function loadRegion(regionId: number): Promise<RegionData> {
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
  };
}
