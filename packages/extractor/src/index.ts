import sade from "sade";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { buildAtlas, writeAtlas } from "./texture/atlas.js";
import { patchObjectLoader, getObjectLoaderFailureCount } from "./patches/objectLoader.js";
import { patchFloorLoaders } from "./patches/floorLoaders.js";

/**
 * CLI: `pnpm extract -- --region <id>`
 *
 * Fetches the latest OSRS cache from openrs2 (unless --build is specified),
 * then extracts a single 64×64 map square into a triangle-soup bundle that
 * the viewer loads as-is.
 *
 * Region IDs: `(regionX << 8) | regionZ`. Default = 12850 (Lumbridge).
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CACHE_DIR = join(REPO_ROOT, ".cache");
const VIEWER_REGIONS = join(REPO_ROOT, "packages/viewer/public/regions");

/**
 * Project default: build 234 (Oct 2025). Picked because it's the most recent
 * OSRS cache that osrscachereader 1.1.3 (released 2025-11-08) was updated
 * against — the library's ObjectLoader opcode table aligns with this build
 * so we don't lose locs to parse failures. Override with --build to experiment.
 * See memory/osrs_cache_decoding.md for the reasoning.
 */
const DEFAULT_BUILD = 234;

async function extractRegion(regionId: number, requestedBuild?: number): Promise<void> {
  await patchObjectLoader();
  await patchFloorLoaders();
  const regionX = (regionId >> 8) & 0xff;
  const regionZ = regionId & 0xff;
  console.log(`[extract] region ${regionId} = (${regionX}, ${regionZ})`);

  const build = requestedBuild ?? DEFAULT_BUILD;
  const cacheMeta: CacheMeta = await resolveCache({ build });
  console.log(
    `[extract] resolved OSRS cache: id=${cacheMeta.id} build=${cacheMeta.build} ts=${cacheMeta.timestamp} keys=${cacheMeta.validKeys}`,
  );

  const buildDir = join(CACHE_DIR, String(cacheMeta.id));
  const cacheDir = await ensureCache(cacheMeta, buildDir);

  console.log(`[extract] opening cache at ${cacheDir}`);
  const rs = new RSCache(cacheDir);
  try {
    await rs.onload;

    const outDir = join(VIEWER_REGIONS, String(regionId));
    mkdirSync(outDir, { recursive: true });

    // Phase 1: resolve both pipelines in parallel (they don't yet know atlas).
    const [terrainPlan, locsPlan] = await Promise.all([
      prepareTerrain(rs, regionX, regionZ, {
        buildId: cacheMeta.build,
        sourceCacheId: cacheMeta.id,
      }),
      prepareLocs(rs, regionX, regionZ),
    ]);

    // Phase 2: build one atlas over every textureId referenced anywhere.
    const textureIds = new Set<number>([
      ...collectTerrainTextureIds(terrainPlan),
      ...collectLocsTextureIds(locsPlan),
    ]);
    console.log(`[atlas] ${textureIds.size} unique textures (terrain + locs)`);
    const atlas = await buildAtlas(rs, textureIds);
    await writeAtlas(atlas, outDir);

    // Phase 3: emit both geometries with UVs keyed to the final atlas.
    // Locs emission consumes `terrainPlan.sceneHeights` — a 74×74 padded
    // grid that includes a 5-tile ring from each neighbor — so contoured
    // locs (fences, trees, rocks) sample terrain correctly even when their
    // geometry extends past the region edge into a neighbor.
    const terrain = emitTerrain(terrainPlan, atlas);
    await writeTerrainBundle(terrain, outDir);
    const locs = emitLocs(locsPlan, atlas, terrainPlan.sceneHeights);
    await writeLocsBundle(locs, outDir);

    const failures = getObjectLoaderFailureCount();
    console.log(
      `[extract] done → ${outDir}` +
        (failures > 0 ? `  (⚠ ${failures} ObjectLoader parse failures — older cache build may be cleaner)` : `  (✓ 0 parse failures)`),
    );
  } finally {
    rs.close();
  }
}

sade("extract", true)
  .describe("Extract one OSRS region into a Three.js-ready bundle.")
  .option("-r, --region", "Region id (regionX<<8 | regionZ). Default 12850 (Lumbridge).", 12850)
  .option("-b, --build", `OSRS build number. Default ${DEFAULT_BUILD} (library-compatible).`)
  .action((opts: { region: number | string; build?: number | string }) => {
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
    extractRegion(regionId, build).catch((e: unknown) => {
      console.error("[extract] failed:", e);
      process.exit(1);
    });
  })
  // pnpm forwards a literal `--` separator when you run `pnpm extract -- --region N`,
  // and sade treats `--` as "stop parsing options", silently falling back to
  // the default region. Drop any bare `--` so both invocation styles work.
  .parse(process.argv.filter((a) => a !== "--"));
