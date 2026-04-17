import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { writeFile, rm, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

const OPENRS2 = "https://archive.openrs2.org";

export interface CacheMeta {
  id: number;
  build: number;
  timestamp: string;
  validKeys: number;
}

interface OpenRS2CacheEntry {
  id: number;
  scope: string;
  game: string;
  environment: string;
  builds: Array<{ major: number; minor: number | null }>;
  timestamp: string | null;
  valid_keys: number | null;
}

/**
 * Resolves an OSRS live cache with valid XTEA keys. Without `build`, picks the
 * newest; with `build`, picks the newest cache for that build (OSRS releases
 * multiple cache snapshots per weekly patch, so "newest per build" gets us
 * the one openrs2 has most complete keys for).
 *
 * We prefer valid_keys > 0 because keyless caches can't decode location
 * groups, which makes the extractor useless for locs.
 */
export async function resolveCache(opts?: { build?: number }): Promise<CacheMeta> {
  const res = await fetch(`${OPENRS2}/caches.json`);
  if (!res.ok) throw new Error(`caches.json fetch failed: ${res.status}`);
  const caches = (await res.json()) as OpenRS2CacheEntry[];

  const candidates = caches.filter(
    (c) =>
      c.game === "oldschool" &&
      c.environment === "live" &&
      c.builds.length > 0 &&
      (c.valid_keys ?? 0) > 0 &&
      c.timestamp &&
      (opts?.build === undefined || c.builds[0]!.major === opts.build),
  );
  candidates.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  const pick = candidates[0];
  if (!pick) {
    const msg = opts?.build !== undefined
      ? `no OSRS cache found for build ${opts.build} on openrs2`
      : "no eligible OSRS cache found on openrs2";
    throw new Error(msg);
  }

  return {
    id: pick.id,
    build: pick.builds[0]!.major,
    timestamp: pick.timestamp!,
    validKeys: pick.valid_keys!,
  };
}

/** Backwards-compatible shortcut for callers that want whatever is newest. */
export async function resolveLatestCache(): Promise<CacheMeta> {
  return resolveCache();
}

/**
 * Downloads (and unzips) the cache + XTEA keys for an openrs2 cache id into
 * `<baseDir>/cache/`. The library expects:
 *   - main_file_cache.dat2, main_file_cache.idx{0..22,255}
 *   - xteas.json  (we just rename keys.json — openrs2's format matches exactly)
 *
 * Idempotent: skips download when the target dir already has dat2.
 */
export async function ensureCache(cacheMeta: CacheMeta, baseDir: string): Promise<string> {
  const cacheDir = join(baseDir, "cache");
  mkdirSync(cacheDir, { recursive: true });

  const datPath = join(cacheDir, "main_file_cache.dat2");
  const xteasPath = join(cacheDir, "xteas.json");

  if (existsSync(datPath) && existsSync(xteasPath)) {
    console.log(`[download] cache already present at ${cacheDir}, skipping`);
    return cacheDir;
  }

  console.log(`[download] fetching disk.zip for cache id=${cacheMeta.id} build=${cacheMeta.build}`);
  const zipRes = await fetch(`${OPENRS2}/caches/runescape/${cacheMeta.id}/disk.zip`);
  if (!zipRes.ok) throw new Error(`disk.zip fetch failed: ${zipRes.status}`);
  const zipBuf = new Uint8Array(await zipRes.arrayBuffer());
  console.log(`[download] disk.zip: ${(zipBuf.byteLength / 1024 / 1024).toFixed(1)} MB`);

  const entries = unzipSync(zipBuf);
  let wrote = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    // entries look like "cache/main_file_cache.dat2" etc.
    const basename = name.split("/").pop()!;
    if (!basename) continue;
    await writeFile(join(cacheDir, basename), bytes);
    wrote++;
  }
  console.log(`[download] unzipped ${wrote} files into ${cacheDir}`);

  console.log(`[download] fetching keys.json`);
  const keysRes = await fetch(`${OPENRS2}/caches/runescape/${cacheMeta.id}/keys.json`);
  if (!keysRes.ok) throw new Error(`keys.json fetch failed: ${keysRes.status}`);
  const keysText = await keysRes.text();
  await writeFile(xteasPath, keysText);
  console.log(`[download] wrote xteas.json (${(keysText.length / 1024).toFixed(1)} KB)`);

  return cacheDir;
}
