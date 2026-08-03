import sade from "sade";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RSCache } from "osrscachereader";
import { ensureCache, resolveCache, type CacheMeta } from "./download.js";
import {
  prepareTerrain,
  collectTerrainTextureIds,
  emitTerrain,
  writeTerrainBundle,
} from "./region/terrain.js";
import {
  prepareLocs,
  collectLocsTextureIds,
  emitLocs,
  writeLocsBundle,
} from "./region/locs.js";
import { loadEdits } from "./region/edits.js";
export {
  loadEdits,
  saveEdits,
  mergeAndSaveEdits,
  placementHash,
  EDITS_DIR,
} from "./region/edits.js";
export { listSaves, readSave, writeSave, deleteSave } from "./saves/store.js";
import { buildAtlas, writeAtlas } from "./texture/atlas.js";
import { patchObjectLoader, getObjectLoaderFailureCount } from "./patches/objectLoader.js";
import { patchFloorLoaders } from "./patches/floorLoaders.js";
import { unpackRegionId } from "@rsmap/shared";
export { bakeNpc, buildNpcCatalog } from "./entities/npcModel.js";
export type { BakedNpc, NpcCatalogEntry } from "./entities/npcModel.js";
export { bakeObject, buildObjectCatalog } from "./entities/objectModel.js";
export type { BakedObject, ObjectCatalogEntry } from "./entities/objectModel.js";
export { bakeItem, buildItemCatalog } from "./entities/itemModel.js";
export type { BakedItem, ItemCatalogEntry } from "./entities/itemModel.js";
export { bakeSpotAnim, buildSpotAnimCatalog } from "./entities/spotAnimModel.js";
export type { BakedSpotAnim, SpotAnimCatalogEntry } from "./entities/spotAnimModel.js";
export { buildSequenceCatalog } from "./entities/sequenceCatalog.js";
export type { SequenceCatalogEntry } from "./entities/sequenceCatalog.js";
export { buildGlobalAtlas } from "./texture/atlas.js";
export type { BakedAtlas } from "./texture/atlas.js";

/**
 * CLI: `pnpm extract -- --region <id>`
 *
 * Fetches the latest OSRS cache from openrs2 (unless --build is specified),
 * then extracts a single 64×64 map square into a triangle-soup bundle that
 * the viewer loads as-is.
 *
 * The extraction core is also exported (`openExtractorSession`,
 * `extractRegion`) so the Vite dev server can call it in-process when the
 * viewer hits a missing region bundle — same pipeline, just no child
 * process.
 *
 * Region IDs: `(regionX << 8) | regionZ`. Default = 12850 (Lumbridge).
 */

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const CACHE_DIR = join(REPO_ROOT, ".cache");
export const VIEWER_REGIONS = join(REPO_ROOT, "packages/viewer/public/regions");
/**
 * Static catalog dump dir consumed by the viewer's `entityCatalog` loader
 * when the dev server isn't running (i.e. `vite build` output). Cross-cutting
 * Phase-4 prerequisite — see `docs/extraction-roadmap.md`.
 */
export const VIEWER_CATALOGS = join(REPO_ROOT, "packages/viewer/public/catalog");

/**
 * Project default: build 234 (Oct 2025). Picked because it's the most recent
 * OSRS cache that osrscachereader 1.1.3 (released 2025-11-08) was updated
 * against — the library's ObjectLoader opcode table aligns with this build
 * so we don't lose locs to parse failures. Override with --build to experiment.
 * See memory/osrs_cache_decoding.md for the reasoning.
 */
export const DEFAULT_BUILD = 234;

/** Thrown when a region id has no map data in the cache (ocean / off-map). */
export class NoSuchRegionError extends Error {
  constructor(
    public readonly regionX: number,
    public readonly regionZ: number,
  ) {
    super(`No map data for region (${regionX}, ${regionZ})`);
    this.name = "NoSuchRegionError";
  }
}

/**
 * A loaded OSRS cache + its metadata. Opening the cache is expensive
 * (index load, XTEA setup), so callers that want to extract multiple
 * regions should open one session and pass it into `extractRegion`
 * repeatedly. The CLI opens a throwaway session per invocation.
 */
export interface ExtractorSession {
  readonly rs: RSCache;
  readonly cacheMeta: CacheMeta;
  close(): void;
}

/**
 * Boots the extractor: applies library patches, resolves the openrs2 cache
 * snapshot for `build`, downloads it if missing, opens an `RSCache`. The
 * returned session must be `close()`d when the caller is done.
 */
export async function openExtractorSession(requestedBuild?: number): Promise<ExtractorSession> {
  await patchObjectLoader();
  await patchFloorLoaders();

  const build = requestedBuild ?? DEFAULT_BUILD;
  const cacheMeta: CacheMeta = await resolveCache({ build });
  console.log(
    `[extract] resolved OSRS cache: id=${cacheMeta.id} build=${cacheMeta.build} ts=${cacheMeta.timestamp} keys=${cacheMeta.validKeys}`,
  );

  const buildDir = join(CACHE_DIR, String(cacheMeta.id));
  const cacheDir = await ensureCache(cacheMeta, buildDir);

  console.log(`[extract] opening cache at ${cacheDir}`);
  const rs = new RSCache(cacheDir);
  await rs.onload;

  return {
    rs,
    cacheMeta,
    close() {
      rs.close();
    },
  };
}

/**
 * Extracts one region into `packages/viewer/public/regions/<id>/` using an
 * already-open session. Throws `NoSuchRegionError` when the region has no
 * map data — callers (the viewer middleware) should treat that as 404 and
 * not a 500.
 */
export async function extractRegion(
  regionId: number,
  session: ExtractorSession,
): Promise<{ outDir: string }> {
  const { regionX, regionZ } = unpackRegionId(regionId);
  console.log(`[extract] region ${regionId} = (${regionX}, ${regionZ})`);

  const outDir = join(VIEWER_REGIONS, String(regionId));
  mkdirSync(outDir, { recursive: true });

  // Read the in-viewer commit-edits overlay, if any. Re-read on every call —
  // the dev-server's `/api/dev/commit-edits` endpoint writes the overlay
  // and immediately re-runs this function, so a memoized result would
  // silently stale-bake.
  const overlay = await loadEdits(regionId);
  if (overlay) {
    console.log(
      `[extract] applying overlay for region ${regionId}: ` +
        `${overlay.removes.length} removes, ${overlay.adds.length} adds`,
    );
  }

  // Phase 1: resolve both pipelines in parallel (they don't yet know atlas).
  // prepareTerrain is what reports a missing region; translate the generic
  // Error into the tagged class so the middleware can answer 404.
  let terrainPlan, locsPlan;
  try {
    [terrainPlan, locsPlan] = await Promise.all([
      prepareTerrain(session.rs, regionX, regionZ, {
        buildId: session.cacheMeta.build,
        sourceCacheId: session.cacheMeta.id,
      }),
      prepareLocs(session.rs, regionX, regionZ, overlay?.adds),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No map data for region")) {
      throw new NoSuchRegionError(regionX, regionZ);
    }
    throw err;
  }

  // Phase 2: build one atlas over every textureId referenced anywhere.
  const textureIds = new Set<number>([
    ...collectTerrainTextureIds(terrainPlan),
    ...collectLocsTextureIds(locsPlan),
  ]);
  console.log(`[atlas] ${textureIds.size} unique textures (terrain + locs)`);
  const atlas = await buildAtlas(session.rs, textureIds);
  await writeAtlas(atlas, outDir);

  // Phase 3: emit both geometries with UVs keyed to the final atlas.
  // Locs emission consumes `terrainPlan.sceneHeights` — a 74×74 padded
  // grid that includes a 5-tile ring from each neighbor — so contoured
  // locs (fences, trees, rocks) sample terrain correctly even when their
  // geometry extends past the region edge into a neighbor.
  const terrain = emitTerrain(terrainPlan, atlas);
  await writeTerrainBundle(terrain, outDir);
  const locs = emitLocs(locsPlan, atlas, terrainPlan.sceneHeights, overlay);
  await writeLocsBundle(locs, outDir);

  const failures = getObjectLoaderFailureCount();
  console.log(
    `[extract] done → ${outDir}` +
      (failures > 0
        ? `  (⚠ ${failures} ObjectLoader parse failures — older cache build may be cleaner)`
        : `  (✓ 0 parse failures)`),
  );

  return { outDir };
}

async function runCli(regionId: number, requestedBuild?: number): Promise<void> {
  const session = await openExtractorSession(requestedBuild);
  try {
    await extractRegion(regionId, session);
  } finally {
    session.close();
  }
}

/**
 * Bake all four entity catalogs (npc, object, item, sequence) into static
 * JSON files under `packages/viewer/public/catalog/`. The viewer's
 * `entityCatalog` loader checks this path before falling back to the dev
 * server's `/api/<name>-catalog` endpoint, so static deploys (`vite build`)
 * pick these up without needing a live extractor.
 *
 * Idempotent — safe to re-run after schema changes. Writes are atomic per
 * file (one `writeFile` each); intermediate state is fine.
 */
export async function dumpCatalogs(session: ExtractorSession): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const { mkdirSync } = await import("node:fs");
  const { buildNpcCatalog } = await import("./entities/npcModel.js");
  const { buildObjectCatalog } = await import("./entities/objectModel.js");
  const { buildItemCatalog } = await import("./entities/itemModel.js");
  const { buildSpotAnimCatalog } = await import("./entities/spotAnimModel.js");
  const { buildSequenceCatalog } = await import("./entities/sequenceCatalog.js");

  mkdirSync(VIEWER_CATALOGS, { recursive: true });

  console.log("[catalog] building npc / object / item / spotanim / sequence catalogs");
  // Sequential, not parallel — they share the cache reader's request
  // queue and racing them just thrashes that queue without speeding up.
  const npc = await buildNpcCatalog(session.rs);
  const obj = await buildObjectCatalog(session.rs);
  const item = await buildItemCatalog(session.rs);
  const spotAnim = await buildSpotAnimCatalog(session.rs);
  const seq = await buildSequenceCatalog(session.rs);

  // Dev server returns `{ entries: [...] }`; mirror the shape so the
  // viewer's loader can use the same parser path for both static and dev.
  await writeFile(
    join(VIEWER_CATALOGS, "npc.json"),
    JSON.stringify({ entries: npc }),
  );
  await writeFile(
    join(VIEWER_CATALOGS, "object.json"),
    JSON.stringify({ entries: obj }),
  );
  await writeFile(
    join(VIEWER_CATALOGS, "item.json"),
    JSON.stringify({ entries: item }),
  );
  await writeFile(
    join(VIEWER_CATALOGS, "spotanim.json"),
    JSON.stringify({ entries: spotAnim }),
  );
  await writeFile(
    join(VIEWER_CATALOGS, "sequence.json"),
    JSON.stringify({ entries: seq }),
  );
  console.log(
    `[catalog] wrote ${npc.length} npcs, ${obj.length} objects, ${item.length} items, ${spotAnim.length} spotanims, ${seq.length} sequences → ${VIEWER_CATALOGS}`,
  );
}

async function runCatalogCli(): Promise<void> {
  const session = await openExtractorSession();
  try {
    await dumpCatalogs(session);
  } finally {
    session.close();
  }
}

// Only run as a CLI when invoked directly (e.g. `tsx src/index.ts`). When
// imported by the Vite middleware we skip sade entirely.
const invokedAsCli =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  sade("extract", true)
    .describe("Extract one OSRS region into a Three.js-ready bundle.")
    .option("-r, --region", "Region id (regionX<<8 | regionZ). Default 12850 (Lumbridge).", 12850)
    .option("-b, --build", `OSRS build number. Default ${DEFAULT_BUILD} (library-compatible).`)
    .option("--catalogs", "Skip region extraction; dump entity catalogs to public/catalog/.", false)
    .action((opts: { region: number | string; build?: number | string; catalogs?: boolean }) => {
      if (opts.catalogs) {
        runCatalogCli().catch((e: unknown) => {
          console.error("[catalog] failed:", e);
          process.exit(1);
        });
        return;
      }
      const regionId = typeof opts.region === "string" ? parseInt(opts.region, 10) : opts.region;
      if (!Number.isInteger(regionId) || regionId < 0 || regionId > 0xffff) {
        console.error(`Invalid region id: ${opts.region}`);
        process.exit(1);
      }
      const build =
        opts.build === undefined
          ? undefined
          : typeof opts.build === "string"
            ? parseInt(opts.build, 10)
            : opts.build;
      if (build !== undefined && !Number.isInteger(build)) {
        console.error(`Invalid build: ${opts.build}`);
        process.exit(1);
      }
      runCli(regionId, build).catch((e: unknown) => {
        console.error("[extract] failed:", e);
        process.exit(1);
      });
    })
    // pnpm forwards a literal `--` separator when you run `pnpm extract -- --region N`,
    // and sade treats `--` as "stop parsing options", silently falling back to
    // the default region. Drop any bare `--` so both invocation styles work.
    .parse(process.argv.filter((a) => a !== "--"));
}
