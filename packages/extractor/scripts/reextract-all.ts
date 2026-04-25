/**
 * One-off bulk re-extractor.
 *
 * Lists every region directory under `packages/viewer/public/regions/`,
 * deletes them all, then re-extracts each through a single shared
 * `ExtractorSession` (one cache open, one XTEA bundle, one library
 * init — rather than spawning a new node process per region).
 *
 * Usage:
 *   pnpm --filter @rsmap/extractor exec tsx scripts/reextract-all.ts
 *
 * Reports progress every 10 regions with an ETA. Failures (off-map ids,
 * extractor errors) are logged but don't abort the run.
 */

import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { openExtractorSession, extractRegion, VIEWER_REGIONS } from "../src/index.js";

async function main(): Promise<void> {
  const ids = readdirSync(VIEWER_REGIONS)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  console.log(`re-extracting ${ids.length} regions`);

  // Wipe the regions tree before re-extraction so half-written bundles
  // from a prior aborted run don't shadow the fresh output.
  rmSync(VIEWER_REGIONS, { recursive: true, force: true });
  mkdirSync(VIEWER_REGIONS, { recursive: true });

  const session = await openExtractorSession();
  let done = 0;
  let failed = 0;
  const start = Date.now();
  for (const id of ids) {
    try {
      await extractRegion(id, session);
      done++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`skip ${id}: ${msg}`);
    }
    const total = done + failed;
    if (total % 10 === 0 || total === ids.length) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = total / elapsed;
      const eta = (ids.length - total) / Math.max(rate, 0.01);
      console.log(
        `${total}/${ids.length}  ok=${done}  fail=${failed}  ` +
          `${rate.toFixed(2)}/s  eta=${(eta / 60).toFixed(1)}m`,
      );
    }
  }
  console.log(`done. ok=${done} fail=${failed} total=${ids.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
