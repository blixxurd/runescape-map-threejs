import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type SaveBundle,
  type SaveSummary,
  isRegionFileEmpty,
  parseManifest,
  parseSaveBundle,
} from "@rsmap/shared/save-file";

// Resolve the repo root from this file's location rather than importing
// REPO_ROOT from `../index.js`. `region/edits.ts` does the same thing for
// the same reason: index imports region/locs.js, so pulling REPO_ROOT
// through that path risks a circular import.
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * Disk layout for named map saves:
 *
 *   packages/extractor/saves/<slug>/manifest.json
 *   packages/extractor/saves/<slug>/<regionId>.json
 *
 * Saves are source data — checked into git, hand-editable, and never read
 * by the extractor itself. Writes go through a temp file + rename so a
 * crash mid-write can't leave a half-parsed save behind.
 */
export const SAVES_DIR = join(REPO_ROOT, "packages/extractor/saves");

function saveDir(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`invalid save slug: ${slug}`);
  return join(SAVES_DIR, slug);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function listSaves(): Promise<SaveSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(SAVES_DIR);
  } catch {
    return []; // directory doesn't exist yet — no saves
  }
  const out: SaveSummary[] = [];
  for (const slug of entries) {
    try {
      const raw = await readFile(join(saveDir(slug), "manifest.json"), "utf8");
      const m = parseManifest(JSON.parse(raw));
      out.push({ slug: m.slug, name: m.name, regions: m.regions, updatedAt: m.updatedAt });
    } catch {
      // Not a save directory, or unreadable/stale schema — skip it rather
      // than failing the whole listing.
    }
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

export async function readSave(slug: string): Promise<SaveBundle | null> {
  const dir = saveDir(slug);
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(dir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  const manifest = parseManifest(JSON.parse(manifestRaw));
  const regions = [];
  for (const regionId of manifest.regions) {
    const raw = await readFile(join(dir, `${regionId}.json`), "utf8");
    regions.push(JSON.parse(raw));
  }
  return parseSaveBundle({ manifest, regions });
}

/** Write a whole save. Region files with no content are pruned, and files
 *  for regions no longer in the bundle are deleted, so the directory always
 *  matches the manifest. */
export async function writeSave(bundle: SaveBundle): Promise<void> {
  const parsed = parseSaveBundle(bundle);
  const dir = saveDir(parsed.manifest.slug);
  await mkdir(dir, { recursive: true });

  const kept = parsed.regions.filter((r) => !isRegionFileEmpty(r));
  const manifest = {
    ...parsed.manifest,
    regions: kept.map((r) => r.regionId),
  };
  for (const region of kept) {
    await writeJsonAtomic(join(dir, `${region.regionId}.json`), region);
  }
  await writeJsonAtomic(join(dir, "manifest.json"), manifest);

  // Prune region files that are no longer part of the save.
  const keep = new Set(kept.map((r) => `${r.regionId}.json`));
  for (const name of await readdir(dir)) {
    if (name === "manifest.json" || keep.has(name) || name.endsWith(".tmp")) continue;
    if (/^\d+\.json$/.test(name)) await rm(join(dir, name));
  }
}

/** Returns `false` when the save doesn't exist. Any other failure (permission,
 *  disk I/O, etc.) is a real error and propagates — swallowing it would
 *  misreport a genuine failure as "not found" and send the caller chasing
 *  the wrong problem. */
export async function deleteSave(slug: string): Promise<boolean> {
  const dir = saveDir(slug);
  try {
    await rm(dir, { recursive: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
