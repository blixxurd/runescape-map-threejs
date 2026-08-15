/**
 * On-disk schema for named map saves.
 *
 * A save is a directory: `packages/extractor/saves/<slug>/` holding
 * `manifest.json` plus one `<regionId>.json` per region it touches. The
 * export/import format (`SaveBundle`) is the same data with every region
 * inlined into a single file.
 *
 * Unlike the region bundle, a save is authored by the editor and read back
 * by the editor — it never feeds the extractor. Bundles under
 * `packages/viewer/public/regions/` are always vanilla cache output.
 */

/** Bump when the shape below changes incompatibly. Loaders refuse to read
 *  a file whose `schemaVersion` differs — there is no migration path in
 *  v1, by design: a save is cheap to rebuild and silent half-application
 *  would be worse than a clear error. */
export const SAVE_SCHEMA = 1;

export type SavedPlacementKind = "npc" | "object" | "item" | "spotanim";

export interface SavedPlacement {
  kind: SavedPlacementKind;
  /** Entity id in its own namespace (NPC id, loc id, item id, spotanim id). */
  id: number;
  /** OSRS plane 0..3. */
  plane: number;
  /** Region-local world units — world position minus the region's own
   *  origin offset. Independent of which region is the streaming centre,
   *  so a save loads identically no matter where the camera started. */
  x: number;
  y: number;
  z: number;
  /** Free-angle Y rotation in radians. The runtime spawn path takes an
   *  angle directly, so no cardinal/residual decomposition is stored. */
  rotationY: number;
  /** Objects only: the OSRS placement type (0..22) the bake chose. */
  type?: number;
  /** NPCs today: per-placement sequence override. */
  animationOverride?: number | null;
}

export interface SaveRegionFile {
  schemaVersion: number;
  regionId: number;
  /** 8-char hex placement ids of baked locs to hide. */
  removes: string[];
  placements: SavedPlacement[];
}

export interface SaveManifest {
  schemaVersion: number;
  /** Display name exactly as the user typed it. */
  name: string;
  /** Directory name; `slugify(name)`, unique within the saves directory. */
  slug: string;
  createdAt: string;
  updatedAt: string;
  /** Region ids with a file in this save. */
  regions: number[];
}

/** Single-file form used by export/import and by the GET-one endpoint. */
export interface SaveBundle {
  manifest: SaveManifest;
  regions: SaveRegionFile[];
}

/** Summary row for the save list endpoint. */
export interface SaveSummary {
  slug: string;
  name: string;
  regions: number[];
  updatedAt: string;
}

export class SaveSchemaError extends Error {
  constructor(found: unknown) {
    super(
      `save schemaVersion mismatch: expected ${SAVE_SCHEMA}, found ${String(found)}`,
    );
    this.name = "SaveSchemaError";
  }
}

const PLACEMENT_ID_RE = /^[0-9a-f]{8}$/;
const KINDS: readonly string[] = ["npc", "object", "item", "spotanim"];

/** Directory-safe name. Non-alphanumerics collapse to single hyphens;
 *  leading/trailing hyphens are trimmed. Never returns an empty string. */
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "untitled";
}

export function emptyRegionFile(regionId: number): SaveRegionFile {
  return { schemaVersion: SAVE_SCHEMA, regionId, removes: [], placements: [] };
}

export function isRegionFileEmpty(f: SaveRegionFile): boolean {
  return f.removes.length === 0 && f.placements.length === 0;
}

function fail(msg: string): never {
  throw new Error(`invalid save file: ${msg}`);
}

function int(v: unknown, lo: number, hi: number, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) {
    fail(`${what} must be an integer in [${lo}, ${hi}], got ${String(v)}`);
  }
  return v;
}

function finite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${what} must be a finite number, got ${String(v)}`);
  }
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) {
    fail(`${what} must be a non-empty string`);
  }
  return v;
}

export function parsePlacement(raw: unknown): SavedPlacement {
  if (!raw || typeof raw !== "object") fail("placement must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.includes(r.kind)) {
    fail(`placement kind must be one of ${KINDS.join(", ")}, got ${String(r.kind)}`);
  }
  const p: SavedPlacement = {
    kind: r.kind as SavedPlacementKind,
    id: int(r.id, 0, 0xfffff, "placement id"),
    plane: int(r.plane, 0, 3, "plane"),
    x: finite(r.x, "x"),
    y: finite(r.y, "y"),
    z: finite(r.z, "z"),
    rotationY: finite(r.rotationY, "rotationY"),
  };
  if (r.type !== undefined) p.type = int(r.type, 0, 22, "type");
  if (r.animationOverride !== undefined && r.animationOverride !== null) {
    p.animationOverride = int(r.animationOverride, 0, 0xffffff, "animationOverride");
  } else if (r.animationOverride === null) {
    p.animationOverride = null;
  }
  return p;
}

export function parseRegionFile(raw: unknown): SaveRegionFile {
  if (!raw || typeof raw !== "object") fail("region file must be an object");
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SAVE_SCHEMA) throw new SaveSchemaError(r.schemaVersion);
  const removes = Array.isArray(r.removes) ? r.removes : fail("removes must be an array");
  for (const h of removes) {
    if (typeof h !== "string" || !PLACEMENT_ID_RE.test(h)) {
      fail(`placement id must be 8 hex chars, got ${String(h)}`);
    }
  }
  const placements = Array.isArray(r.placements)
    ? r.placements
    : fail("placements must be an array");
  return {
    schemaVersion: SAVE_SCHEMA,
    regionId: int(r.regionId, 0, 0xffff, "regionId"),
    removes: removes as string[],
    placements: placements.map(parsePlacement),
  };
}

export function parseManifest(raw: unknown): SaveManifest {
  if (!raw || typeof raw !== "object") fail("manifest must be an object");
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== SAVE_SCHEMA) throw new SaveSchemaError(r.schemaVersion);
  const regions = Array.isArray(r.regions) ? r.regions : fail("regions must be an array");
  return {
    schemaVersion: SAVE_SCHEMA,
    name: str(r.name, "name"),
    slug: str(r.slug, "slug"),
    createdAt: str(r.createdAt, "createdAt"),
    updatedAt: str(r.updatedAt, "updatedAt"),
    regions: regions.map((v) => int(v, 0, 0xffff, "regionId")),
  };
}

export function parseSaveBundle(raw: unknown): SaveBundle {
  if (!raw || typeof raw !== "object") fail("bundle must be an object");
  const r = raw as Record<string, unknown>;
  const regions = Array.isArray(r.regions) ? r.regions : fail("regions must be an array");
  return {
    manifest: parseManifest(r.manifest),
    regions: regions.map(parseRegionFile),
  };
}
