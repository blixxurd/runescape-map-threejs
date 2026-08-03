# Named Map Saves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single bake-time `edits/<regionId>.json` overlay with named map saves that load as a runtime overlay, so bundles stay vanilla and the user can switch maps or start fresh without re-extracting.

**Architecture:** A save is a directory of JSON files on disk (`packages/extractor/saves/<slug>/`). The viewer holds one active save in a `SaveStore`; regions apply their slice of it as they stream in (hide tombstoned baked locs, spawn placements through the existing placers) and detach it when they unload. Dev-server endpoints do the file I/O. The old bake-time overlay path is deleted at the end.

**Tech Stack:** TypeScript (strict), Three.js r169, Vite 5 dev middleware, pnpm workspaces, vitest (new, viewer only).

**Spec:** `docs/superpowers/specs/2026-08-02-save-map-design.md`

## Global Constraints

- World convention is `+X = east`, `+Y = up`, `+Z = south`. Cache tile coords use `+Y = north`, so `tileZ = floor(-localZ / TILE_SIZE)`. Never "fix" this.
- `REGION_SPAN`, `TILE_SIZE`, `packRegionId`, `unpackRegionId` come from `@rsmap/shared`. Do not redefine them.
- Region-local coordinates in a save are measured from the region's own origin: `local = world - regionOffset`, where `offsetX = (regionX - centerRegionX) * REGION_SPAN` and `offsetZ = -(regionZ - centerRegionZ) * REGION_SPAN` (matches `setupRegion` in `packages/viewer/src/main.ts:84-85`).
- Placement id hex format is exactly `placementIds[placementIdx].toString(16).padStart(8, "0")` (see `packages/viewer/src/tools/locResolve.ts:71`). Server-side validation regex is `/^[0-9a-f]{8}$/`.
- `SAVE_SCHEMA = 1`. Every save file carries `schemaVersion`; a mismatch throws `SaveSchemaError` and refuses the load. No auto-migration.
- The editor (and therefore the whole save feature) is dev-server-only. In a static build the map menu renders disabled — never throw on a missing endpoint.
- No new runtime dependencies. `vitest` is a viewer devDependency only.
- `pnpm typecheck` must pass for both packages after every task.
- Commit messages: imperative subject, no trailing period, end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

**Created:**

| path | responsibility |
|---|---|
| `shared/src/save-file.ts` | On-disk save schema: types, `SAVE_SCHEMA`, `slugify`, validation/parsing. Imported by viewer, extractor, and dev middleware. |
| `packages/extractor/src/saves/store.ts` | Node-side file I/O for saves: list, read, write (tmp+rename), delete. |
| `packages/viewer/src/saves/saveModel.ts` | Pure coordinate + attribution helpers. No Three.js, no DOM — the unit-tested core. |
| `packages/viewer/src/saves/saveModel.test.ts` | Tests for the above. |
| `packages/viewer/src/saves/saveStore.ts` | Active-save state: tracks placements + removes, applies to / detaches from regions, serializes. |
| `packages/viewer/src/saves/saveStore.test.ts` | Tests for tracking, attribution-on-move, serialization round-trip. |
| `packages/viewer/src/saves/saveClient.ts` | `fetch` wrapper over the dev endpoints. |
| `packages/viewer/src/locs/hideLoc.ts` | `SUNK_Y`, `hideInstancedSlot`, `hideMergedTriangles`, `buildPlacementIndex` — moved out of `selection.ts` so save-apply can reuse them. |
| `packages/viewer/src/locs/hideLoc.test.ts` | Tests for `buildPlacementIndex`. |
| `packages/viewer/src/ui/mapMenu.ts` | Head-bar map control + dropdown. |
| `packages/viewer/vitest.config.ts` | Test runner config. |

**Modified:**

| path | change |
|---|---|
| `shared/package.json` | Add `"./save-file"` export entry. |
| `packages/viewer/package.json` | Add `vitest` devDependency + `test` script. |
| `packages/viewer/src/tools/modelPlacer.ts` | `spawnPlacement` takes an explicit plane; new public `spawnAt()`. |
| `packages/viewer/src/tools/selection.ts` | Import hide helpers from `hideLoc.ts`; host takes `saveStore` instead of `pendingEdits`. |
| `packages/viewer/src/tools/toolPanel.ts` | Replace `commit` button + `onCommit`/`setCommitState` with map-menu mount point. |
| `packages/viewer/src/main.ts` | Wire `SaveStore` into region load/unload, placer hooks, autoload, `beforeunload`. |
| `packages/viewer/vite.config.ts` | Add `/api/dev/saves*` routes; delete `/api/dev/commit-edits`. |
| `packages/extractor/src/index.ts` | Drop `loadEdits` and the overlay argument threading. |
| `packages/extractor/src/region/locs.ts` | Drop `overlayAdds` / `overlay` parameters; import `placementHash` from its new home. |
| `shared/src/region-bundle.ts` | Remove `EditsOverlay` / `EditsOverlayAdd` / `EDITS_SCHEMA`. |
| `CLAUDE.md` | Replace the commit-edits section with named saves. |

**Deleted:** `packages/extractor/edits/` (after migration), `packages/extractor/src/region/edits.ts` (renamed to `placementHash.ts`, keeping only that function), `packages/viewer/src/tools/pendingEdits.ts`.

---

### Task 1: Save schema in shared + test runner

**Files:**
- Create: `shared/src/save-file.ts`
- Create: `packages/viewer/vitest.config.ts`
- Modify: `shared/package.json`, `packages/viewer/package.json`
- Test: `packages/viewer/src/saves/saveModel.test.ts` (schema half only; coordinate tests land in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: `SAVE_SCHEMA`, `SavedPlacement`, `SaveRegionFile`, `SaveManifest`, `SaveBundle`, `SaveSchemaError`, `slugify(name: string): string`, `parseSaveBundle(raw: unknown): SaveBundle`, `emptyRegionFile(regionId: number): SaveRegionFile`, `isRegionFileEmpty(f: SaveRegionFile): boolean`. Importable as `@rsmap/shared/save-file`.

- [ ] **Step 1: Add the test runner**

`packages/viewer/package.json` — add to `devDependencies` and `scripts`:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

```json
    "vitest": "^2.1.0"
```

`packages/viewer/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/viewer/src/saves/saveModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SAVE_SCHEMA,
  SaveSchemaError,
  emptyRegionFile,
  isRegionFileEmpty,
  parseSaveBundle,
  slugify,
} from "@rsmap/shared/save-file";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Lumbridge Raid")).toBe("lumbridge-raid");
  });

  it("strips characters that are unsafe in a directory name", () => {
    expect(slugify("my/map: v2!")).toBe("my-map-v2");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("///")).toBe("untitled");
  });
});

describe("parseSaveBundle", () => {
  const valid = {
    manifest: {
      schemaVersion: SAVE_SCHEMA,
      name: "Lumbridge Raid",
      slug: "lumbridge-raid",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      regions: [12850],
    },
    regions: [
      {
        schemaVersion: SAVE_SCHEMA,
        regionId: 12850,
        removes: ["0000001a"],
        placements: [
          {
            kind: "object",
            id: 1278,
            plane: 0,
            x: 4480.5,
            y: 12,
            z: -4480.5,
            rotationY: 0.7853981633974483,
            type: 10,
          },
        ],
      },
    ],
  };

  it("round-trips a valid bundle", () => {
    const parsed = parseSaveBundle(JSON.parse(JSON.stringify(valid)));
    expect(parsed.regions[0]!.placements[0]!.id).toBe(1278);
    expect(parsed.manifest.slug).toBe("lumbridge-raid");
  });

  it("rejects a future schema version", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.manifest.schemaVersion = SAVE_SCHEMA + 1;
    expect(() => parseSaveBundle(bad)).toThrow(SaveSchemaError);
  });

  it("rejects a placement with an unknown kind", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.regions[0].placements[0].kind = "monster";
    expect(() => parseSaveBundle(bad)).toThrow(/kind/);
  });

  it("rejects a malformed placement id", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.regions[0].removes = ["nothex"];
    expect(() => parseSaveBundle(bad)).toThrow(/placement id/);
  });
});

describe("region file helpers", () => {
  it("reports an untouched region file as empty", () => {
    expect(isRegionFileEmpty(emptyRegionFile(12850))).toBe(true);
  });

  it("reports a file with a remove as non-empty", () => {
    const f = emptyRegionFile(12850);
    f.removes.push("0000001a");
    expect(isRegionFileEmpty(f)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @rsmap/viewer test`
Expected: FAIL — cannot resolve `@rsmap/shared/save-file`.

- [ ] **Step 4: Add the shared export entry**

`shared/package.json`:

```json
  "exports": {
    ".": "./src/region-bundle.ts",
    "./save-file": "./src/save-file.ts"
  }
```

- [ ] **Step 5: Write the schema module**

`shared/src/save-file.ts`:

```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @rsmap/viewer test`
Expected: PASS (9 tests)

Run: `pnpm typecheck`
Expected: both packages clean.

- [ ] **Step 7: Commit**

```bash
git add shared/src/save-file.ts shared/package.json packages/viewer/package.json \
        packages/viewer/vitest.config.ts packages/viewer/src/saves/saveModel.test.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
Add save-file schema and vitest to the viewer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pure coordinate + attribution helpers

**Files:**
- Create: `packages/viewer/src/saves/saveModel.ts`
- Modify: `packages/viewer/src/saves/saveModel.test.ts`

**Interfaces:**
- Consumes: `@rsmap/shared` (`REGION_SPAN`, `packRegionId`, `unpackRegionId`), `@rsmap/shared/save-file`.
- Produces: `regionOriginFor(regionId, centerRegionX, centerRegionZ): { offsetX: number; offsetZ: number }`, `worldToRegionId(worldX, worldZ, centerRegionX, centerRegionZ): number | null`, `worldToRegionLocal(world, origin): { x, y, z }`, `regionLocalToWorld(p, origin): { x, y, z }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/viewer/src/saves/saveModel.test.ts`:

```ts
import { REGION_SPAN } from "@rsmap/shared";
import {
  regionLocalToWorld,
  regionOriginFor,
  worldToRegionId,
  worldToRegionLocal,
} from "./saveModel.js";

// Lumbridge 12850 = (regionX 50, regionZ 50). Used as the streaming centre
// in every case below, so its own origin is the world origin.
const CX = 50;
const CZ = 50;

describe("regionOriginFor", () => {
  it("puts the centre region at the world origin", () => {
    expect(regionOriginFor(12850, CX, CZ)).toEqual({ offsetX: 0, offsetZ: 0 });
  });

  it("puts the region one step east at +X", () => {
    // regionX 51, regionZ 50 → (51 << 8) | 50
    expect(regionOriginFor((51 << 8) | 50, CX, CZ)).toEqual({
      offsetX: REGION_SPAN,
      offsetZ: 0,
    });
  });

  it("puts the region one step north at -Z (cache +Y is world -Z)", () => {
    expect(regionOriginFor((50 << 8) | 51, CX, CZ)).toEqual({
      offsetX: 0,
      offsetZ: -REGION_SPAN,
    });
  });
});

describe("worldToRegionId", () => {
  it("attributes a position inside the centre region", () => {
    expect(worldToRegionId(100, -100, CX, CZ)).toBe(12850);
  });

  it("attributes a position just across the east seam to the east region", () => {
    expect(worldToRegionId(REGION_SPAN + 1, -100, CX, CZ)).toBe((51 << 8) | 50);
  });

  it("attributes a position just across the north seam to the north region", () => {
    expect(worldToRegionId(100, -REGION_SPAN - 1, CX, CZ)).toBe((50 << 8) | 51);
  });

  it("returns null outside the addressable cache grid", () => {
    expect(worldToRegionId(-100 * REGION_SPAN, 0, CX, CZ)).toBeNull();
  });
});

describe("region-local round trip", () => {
  it("recovers the original world position", () => {
    const world = { x: REGION_SPAN + 250.5, y: 37.25, z: -REGION_SPAN - 900.75 };
    const regionId = worldToRegionId(world.x, world.z, CX, CZ)!;
    const origin = regionOriginFor(regionId, CX, CZ);
    const local = worldToRegionLocal(world, origin);
    expect(regionLocalToWorld(local, origin)).toEqual(world);
  });

  it("keeps local coordinates inside one region span", () => {
    const world = { x: REGION_SPAN + 250.5, y: 0, z: -REGION_SPAN - 900.75 };
    const regionId = worldToRegionId(world.x, world.z, CX, CZ)!;
    const local = worldToRegionLocal(world, regionOriginFor(regionId, CX, CZ));
    expect(local.x).toBeGreaterThanOrEqual(0);
    expect(local.x).toBeLessThan(REGION_SPAN);
    expect(local.z).toBeLessThanOrEqual(0);
    expect(local.z).toBeGreaterThan(-REGION_SPAN);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rsmap/viewer test`
Expected: FAIL — `./saveModel.js` does not exist.

- [ ] **Step 3: Write the implementation**

`packages/viewer/src/saves/saveModel.ts`:

```ts
import { REGION_SPAN, packRegionId, unpackRegionId } from "@rsmap/shared";

/**
 * Pure coordinate helpers shared by the save store and its tests. No
 * Three.js, no DOM, no fetch — everything here is a plain function over
 * numbers so the interesting math is unit-testable.
 *
 * Region-local coordinates are world coordinates minus the region's own
 * origin offset. Because that offset depends on which region the viewer
 * centred on, a save must store LOCAL coords: the same file then loads
 * identically whether you arrived from the north or the west.
 */

export interface RegionOrigin {
  offsetX: number;
  offsetZ: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** World-space offset applied to a region's groups. Mirrors `setupRegion`
 *  in `main.ts` exactly — cache +Y (north) maps to world −Z. */
export function regionOriginFor(
  regionId: number,
  centerRegionX: number,
  centerRegionZ: number,
): RegionOrigin {
  const { regionX, regionZ } = unpackRegionId(regionId);
  return {
    offsetX: (regionX - centerRegionX) * REGION_SPAN,
    offsetZ: -(regionZ - centerRegionZ) * REGION_SPAN,
  };
}

/** Which region owns this world position? Returns null outside the
 *  256×256 cache grid. Mirrors `worldToTile`'s region math in `main.ts`
 *  without the tile subdivision. */
export function worldToRegionId(
  worldX: number,
  worldZ: number,
  centerRegionX: number,
  centerRegionZ: number,
): number | null {
  const dRx = Math.floor(worldX / REGION_SPAN);
  const dRz = Math.floor(-worldZ / REGION_SPAN);
  const rx = centerRegionX + dRx;
  const rz = centerRegionZ + dRz;
  if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) return null;
  return packRegionId(rx, rz);
}

export function worldToRegionLocal(world: Vec3Like, origin: RegionOrigin): Vec3Like {
  return {
    x: world.x - origin.offsetX,
    y: world.y,
    z: world.z - origin.offsetZ,
  };
}

export function regionLocalToWorld(local: Vec3Like, origin: RegionOrigin): Vec3Like {
  return {
    x: local.x + origin.offsetX,
    y: local.y,
    z: local.z + origin.offsetZ,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rsmap/viewer test`
Expected: PASS (all Task 1 + Task 2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/viewer/src/saves/saveModel.ts packages/viewer/src/saves/saveModel.test.ts
git commit -m "$(cat <<'EOF'
Add pure region-attribution helpers for saves

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract loc-hiding helpers + placement index

**Files:**
- Create: `packages/viewer/src/locs/hideLoc.ts`, `packages/viewer/src/locs/hideLoc.test.ts`
- Modify: `packages/viewer/src/tools/selection.ts:702-733` (delete the two functions and the `SUNK_Y` constant, import them instead)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SUNK_Y`, `hideInstancedSlot(inst, instanceId)`, `hideMergedTriangles(mesh, placementIdx)`, `PlacementSlot`, `buildPlacementIndex(locsGroup): Map<string, PlacementSlot>`.

Note: `selection.ts` currently defines `SUNK_Y` near the top of the file — find its exact declaration with `grep -n "SUNK_Y" packages/viewer/src/tools/selection.ts` and move it, don't duplicate it.

- [ ] **Step 1: Write the failing test**

`packages/viewer/src/locs/hideLoc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildPlacementIndex } from "./hideLoc.js";

/** placeLocs stamps `placementIds` (whole-region, indexed by placementIdx)
 *  on every loc mesh, plus `placementIdxs` per instance on InstancedMesh
 *  and `placementByTri` per triangle on the merged Mesh. These fixtures
 *  reproduce that shape without needing a real bundle. */
function instanced(placementIds: Uint32Array, placementIdxs: number[]): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
    placementIdxs.length,
  );
  inst.userData.placementIds = placementIds;
  inst.userData.placementIdxs = placementIdxs;
  return inst;
}

function merged(placementIds: Uint32Array, placementByTri: Uint32Array): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.userData.isMergedLocs = true;
  mesh.userData.placementIds = placementIds;
  mesh.userData.placementByTri = placementByTri;
  return mesh;
}

describe("buildPlacementIndex", () => {
  it("indexes instanced slots by 8-char hex placement id", () => {
    const ids = new Uint32Array([0x1a, 0x2b, 0x3c]);
    const group = new THREE.Group();
    group.add(instanced(ids, [0, 2]));

    const index = buildPlacementIndex(group);

    expect(index.get("0000001a")).toMatchObject({ instanceId: 0 });
    expect(index.get("0000003c")).toMatchObject({ instanceId: 2 });
    // placementIdx 1 was not instanced here, so it must not appear.
    expect(index.has("0000002b")).toBe(false);
  });

  it("indexes merged triangles by placement id, one entry per placement", () => {
    const ids = new Uint32Array([0x1a, 0x2b]);
    const group = new THREE.Group();
    group.add(merged(ids, new Uint32Array([0, 0, 1, 1, 1])));

    const index = buildPlacementIndex(group);

    expect(index.get("0000001a")).toMatchObject({ placementIdx: 0, instanceId: null });
    expect(index.get("0000002b")).toMatchObject({ placementIdx: 1, instanceId: null });
  });

  it("walks nested plane groups", () => {
    const ids = new Uint32Array([0x1a]);
    const plane = new THREE.Group();
    plane.add(instanced(ids, [0]));
    const root = new THREE.Group();
    root.add(plane);

    expect(buildPlacementIndex(root).has("0000001a")).toBe(true);
  });

  it("returns an empty index when the bundle has no placementIds", () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.isMergedLocs = true;
    mesh.userData.placementByTri = new Uint32Array([0]);
    group.add(mesh);

    expect(buildPlacementIndex(group).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rsmap/viewer test hideLoc`
Expected: FAIL — `./hideLoc.js` does not exist.

- [ ] **Step 3: Write the implementation**

`packages/viewer/src/locs/hideLoc.ts`:

```ts
import * as THREE from "three";

/**
 * Hiding baked locs at runtime, plus the index that lets a save find them.
 *
 * Two mesh shapes come out of `placeLocs`: repeated locs live as slots in
 * an `InstancedMesh`, singleton locs are merged into one big `Mesh` per
 * plane. Hiding differs per shape, so both helpers live here and both
 * selection (interactive delete) and the save store (apply on load) use
 * them.
 *
 * Neither helper is reversible on its own — restoring a hidden loc means
 * reloading the region, which is cheap because bundles on disk are always
 * vanilla.
 */

/** Y depth to sink hidden geometry to. Far below any terrain, so a
 *  degenerate triangle can never poke back into view. */
export const SUNK_Y = -100000;

/** Zero-scale a single InstancedMesh slot and sink it underground. The
 *  slot stays allocated; the per-instance matrix is degenerate so the
 *  fragment shader produces no output and raycasts find no hit. */
export function hideInstancedSlot(inst: THREE.InstancedMesh, instanceId: number): void {
  const m = new THREE.Matrix4();
  m.makeScale(0, 0, 0);
  m.setPosition(0, SUNK_Y, 0);
  inst.setMatrixAt(instanceId, m);
  inst.instanceMatrix.needsUpdate = true;
}

/** Collapse every triangle owned by `placementIdx` in a merged-loc Mesh's
 *  position buffer to a single point at SUNK_Y. The merged buffer is
 *  owned by this mesh alone (`placeLocs` mints a fresh Float32Array) so
 *  in-place mutation doesn't affect any other placement. */
export function hideMergedTriangles(mesh: THREE.Mesh, placementIdx: number): void {
  const placementByTri = (mesh.userData as { placementByTri?: Uint32Array })
    .placementByTri;
  if (!placementByTri) return;
  const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const positions = posAttr.array as Float32Array;
  for (let t = 0; t < placementByTri.length; t++) {
    if (placementByTri[t] !== placementIdx) continue;
    // Each triangle = 3 vertices = 9 floats. Collapse all three vertices
    // to (0, SUNK_Y, 0) — degenerate zero-area, no rasterised fragments.
    const off = t * 9;
    positions[off + 0] = 0; positions[off + 1] = SUNK_Y; positions[off + 2] = 0;
    positions[off + 3] = 0; positions[off + 4] = SUNK_Y; positions[off + 5] = 0;
    positions[off + 6] = 0; positions[off + 7] = SUNK_Y; positions[off + 8] = 0;
  }
  posAttr.needsUpdate = true;
}

/** Where a given baked placement lives in the scene. `instanceId` is null
 *  for merged (singleton) placements. */
export interface PlacementSlot {
  mesh: THREE.Mesh;
  instanceId: number | null;
  placementIdx: number;
}

/** Map every baked placement in a region's locs group by its 8-char hex
 *  placement id, so a save's `removes` list can be applied without
 *  raycasting. Built once per region load.
 *
 *  Bundles predating the `placementIds` blob yield an empty index — the
 *  caller warns; there's nothing to key on. */
export function buildPlacementIndex(locsGroup: THREE.Object3D): Map<string, PlacementSlot> {
  const index = new Map<string, PlacementSlot>();
  locsGroup.traverse((obj) => {
    const ud = obj.userData as {
      placementIds?: Uint32Array;
      placementIdxs?: number[];
      placementByTri?: Uint32Array;
    };
    const ids = ud.placementIds;
    if (!ids || ids.length === 0) return;
    const hex = (placementIdx: number): string =>
      ids[placementIdx]!.toString(16).padStart(8, "0");

    if (obj instanceof THREE.InstancedMesh && ud.placementIdxs) {
      for (let instanceId = 0; instanceId < ud.placementIdxs.length; instanceId++) {
        const placementIdx = ud.placementIdxs[instanceId]!;
        index.set(hex(placementIdx), { mesh: obj, instanceId, placementIdx });
      }
      return;
    }
    if (obj instanceof THREE.Mesh && ud.placementByTri) {
      // One entry per distinct placement, not per triangle.
      let last = -1;
      for (const placementIdx of ud.placementByTri) {
        if (placementIdx === last) continue;
        last = placementIdx;
        index.set(hex(placementIdx), { mesh: obj, instanceId: null, placementIdx });
      }
    }
  });
  return index;
}

/** Hide whatever a `PlacementSlot` points at, whichever shape it is. */
export function hideSlot(slot: PlacementSlot): void {
  if (slot.mesh instanceof THREE.InstancedMesh && slot.instanceId !== null) {
    hideInstancedSlot(slot.mesh, slot.instanceId);
  } else {
    hideMergedTriangles(slot.mesh, slot.placementIdx);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rsmap/viewer test hideLoc`
Expected: PASS (4 tests)

- [ ] **Step 5: Point selection.ts at the shared module**

In `packages/viewer/src/tools/selection.ts`: delete the local `SUNK_Y` declaration and the `hideInstancedSlot` / `hideMergedTriangles` function bodies at the end of the file, and add to the imports:

```ts
import { SUNK_Y, hideInstancedSlot, hideMergedTriangles } from "../locs/hideLoc.js";
```

Run: `pnpm typecheck`
Expected: clean. If `SUNK_Y` is reported unused in `selection.ts`, drop it from the import — the outline-ghost code may or may not reference it.

- [ ] **Step 6: Commit**

```bash
git add packages/viewer/src/locs/hideLoc.ts packages/viewer/src/locs/hideLoc.test.ts \
        packages/viewer/src/tools/selection.ts
git commit -m "$(cat <<'EOF'
Extract loc-hiding helpers and add a placement-id index

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Programmatic spawn on ModelPlacer

**Files:**
- Modify: `packages/viewer/src/tools/modelPlacer.ts:832-880` (`spawnPlacement`), `:573-580` (`duplicate`), and the click handler that calls `spawnPlacement`
- Modify: `packages/viewer/src/tools/placerTypes.ts` (add `spawnAt` to the `Placer` interface)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Placer.spawnAt(opts: SpawnAtOptions): Promise<THREE.Mesh | null>` where

```ts
export interface SpawnAtOptions {
  id: number;
  position: { x: number; y: number; z: number };
  rotationY: number;
  plane: number;
  animationOverride?: number | null;
  /** When false, `onPlacementSpawned` does NOT fire. Save-apply passes
   *  false so re-materializing a saved placement isn't recorded as a new
   *  edit. Defaults to true. */
  notify?: boolean;
}
```

- [ ] **Step 1: Thread an explicit plane through `spawnPlacement`**

Change the private signature at `modelPlacer.ts:832` from reading `this.placementPlane` to taking it as an argument:

```ts
  private spawnPlacement(
    id: number,
    name: string,
    baked: CachedEntity,
    pose: { position: THREE.Vector3; rotationRad: number },
    plane: number = this.placementPlane,
    notify = true,
  ): PlacedEntity {
```

Inside the body, replace both uses of `this.placementPlane` (the `PlacedEntity.plane` field and the `onPlacementSpawned` argument) with `plane`, and guard the hook:

```ts
    if (notify) {
      this.onPlacementSpawned?.(
        mesh,
        id,
        name,
        baked.modelType,
        baked.sizeX,
        baked.sizeY,
        plane,
      );
    }
```

Existing callers (`handleClick`, `duplicate`) keep working via the defaults — do not change them.

- [ ] **Step 2: Add the public `spawnAt`**

Add after `duplicate` in `modelPlacer.ts`:

```ts
  /**
   * Spawn a placement at an exact world pose without arming the tool.
   * Used by the save store to re-materialize saved placements on region
   * load, and by the legacy-edits importer.
   *
   * Resolves to the new mesh, or null when the entity can't be baked
   * (unknown id on the current cache build, dev endpoint down). Callers
   * count nulls and surface them — a missing entity must never abort the
   * rest of the load.
   */
  async spawnAt(opts: SpawnAtOptions): Promise<THREE.Mesh | null> {
    let baked: CachedEntity;
    try {
      baked = await this.getOrFetch(opts.id, opts.animationOverride ?? undefined);
    } catch (err) {
      console.warn(`[${this.kind}] spawnAt ${opts.id} failed:`, err);
      return null;
    }
    const placement = this.spawnPlacement(
      opts.id,
      baked.name,
      baked,
      {
        position: new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z),
        rotationRad: opts.rotationY,
      },
      opts.plane,
      opts.notify ?? true,
    );
    return placement.mesh;
  }
```

Add `SpawnAtOptions` to `placerTypes.ts` (exact shape in the Interfaces block above) and declare the method on the `Placer` interface:

```ts
  /** Spawn a placement at an exact world pose, bypassing the armed-tool
   *  flow. Resolves null when the entity can't be baked. */
  spawnAt(opts: SpawnAtOptions): Promise<THREE.Mesh | null>;
```

Import `SpawnAtOptions` in `modelPlacer.ts` from `./placerTypes.js`.

- [ ] **Step 3: Verify nothing regressed**

Run: `pnpm typecheck`
Expected: clean.

Run: `pnpm dev`, place an object by clicking, drag it with the gizmo, duplicate with Cmd+D.
Expected: unchanged behaviour — this task is a pure refactor plus new API.

- [ ] **Step 4: Commit**

```bash
git add packages/viewer/src/tools/modelPlacer.ts packages/viewer/src/tools/placerTypes.ts
git commit -m "$(cat <<'EOF'
Add ModelPlacer.spawnAt for programmatic placement

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Node-side save storage + dev endpoints + client

**Files:**
- Create: `packages/extractor/src/saves/store.ts`
- Modify: `packages/extractor/src/index.ts` (re-export the save store functions so the dev middleware can reach them through `loadModule`)
- Modify: `packages/viewer/vite.config.ts` (new routes)
- Create: `packages/viewer/src/saves/saveClient.ts`

**Interfaces:**
- Consumes: `@rsmap/shared/save-file` (`SaveBundle`, `SaveSummary`, `parseSaveBundle`, `emptyRegionFile`, `isRegionFileEmpty`, `slugify`).
- Produces (Node): `listSaves(): Promise<SaveSummary[]>`, `readSave(slug): Promise<SaveBundle | null>`, `writeSave(bundle): Promise<void>`, `deleteSave(slug): Promise<boolean>`.
- Produces (viewer): `SaveClient` class with `list()`, `read(slug)`, `write(bundle)`, `remove(slug)`, `isAvailable()`.

- [ ] **Step 1: Write the Node-side store**

`packages/extractor/src/saves/store.ts`:

```ts
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

export async function deleteSave(slug: string): Promise<boolean> {
  const dir = saveDir(slug);
  try {
    await rm(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
```

`packages/extractor/src/saves/store.ts` sits at the same depth as `region/edits.ts`, so the same `../../../..` resolves to the repo root.

- [ ] **Step 2: Re-export from the extractor entry point**

In `packages/extractor/src/index.ts`, next to the existing `mergeAndSaveEdits` re-export:

```ts
export { listSaves, readSave, writeSave, deleteSave } from "./saves/store.js";
```

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Add the dev endpoints**

In `packages/viewer/vite.config.ts`, immediately before the existing `/api/dev/commit-edits` block (around line 489), add:

```ts
        if (req.url === "/api/dev/saves" || req.url.startsWith("/api/dev/saves?")) {
          const mod = await loadModule(server);
          try {
            writeJson(res, 200, { saves: await mod.listSaves() });
          } catch (err) {
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url.startsWith("/api/dev/saves/")) {
          const slug = decodeURIComponent(
            new URL(req.url, "http://localhost").pathname.slice("/api/dev/saves/".length),
          );
          if (!/^[a-z0-9-]+$/.test(slug)) {
            writeJson(res, 400, { error: `invalid save slug: ${slug}` });
            return;
          }
          const mod = await loadModule(server);
          try {
            if (req.method === "GET") {
              const bundle = await mod.readSave(slug);
              if (!bundle) {
                writeJson(res, 404, { error: `no such save: ${slug}` });
                return;
              }
              writeJson(res, 200, bundle);
              return;
            }
            if (req.method === "PUT") {
              const body = await readJsonBody(req);
              // writeSave re-parses and throws on anything malformed, so
              // the endpoint doesn't duplicate field validation.
              await mod.writeSave(body as never);
              server.config.logger.info(`[saves] wrote ${slug}`);
              writeJson(res, 200, { ok: true, slug });
              return;
            }
            if (req.method === "DELETE") {
              const ok = await mod.deleteSave(slug);
              writeJson(res, ok ? 200 : 404, ok ? { ok: true, slug } : { error: "not found" });
              return;
            }
            writeJson(res, 405, { error: "GET, PUT or DELETE required" });
          } catch (err) {
            server.config.logger.error(`[saves] ${slug} failed: ${(err as Error).message}`);
            writeJson(res, 400, { error: (err as Error).message });
          }
          return;
        }
```

- [ ] **Step 4: Write the viewer client**

`packages/viewer/src/saves/saveClient.ts`:

```ts
import type { SaveBundle, SaveSummary } from "@rsmap/shared/save-file";
import { parseSaveBundle } from "@rsmap/shared/save-file";

/**
 * Transport for the dev-server save endpoints. Isolated from `SaveStore`
 * so the store stays testable without fetch mocking.
 *
 * Every method throws on failure; callers surface the message. A static
 * build has no dev server, so `isAvailable()` probes once and the map menu
 * disables itself rather than throwing on every click.
 */
export class SaveClient {
  private availability: Promise<boolean> | null = null;

  isAvailable(): Promise<boolean> {
    if (!this.availability) {
      this.availability = fetch("/api/dev/saves")
        .then((r) => r.ok)
        .catch(() => false);
    }
    return this.availability;
  }

  async list(): Promise<SaveSummary[]> {
    const r = await fetch("/api/dev/saves");
    if (!r.ok) throw new Error(`list saves failed: HTTP ${r.status}`);
    return ((await r.json()) as { saves: SaveSummary[] }).saves;
  }

  async read(slug: string): Promise<SaveBundle> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`load "${slug}" failed: HTTP ${r.status}`);
    return parseSaveBundle(await r.json());
  }

  async write(bundle: SaveBundle): Promise<void> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(bundle.manifest.slug)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(`save failed: ${body.error ?? `HTTP ${r.status}`}`);
    }
  }

  async remove(slug: string): Promise<void> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (!r.ok) throw new Error(`delete "${slug}" failed: HTTP ${r.status}`);
  }
}
```

- [ ] **Step 5: Verify end to end with curl**

Run `pnpm dev` in one terminal, then:

```bash
curl -s localhost:5173/api/dev/saves
curl -s -X PUT localhost:5173/api/dev/saves/scratch-test \
  -H 'content-type: application/json' \
  -d '{"manifest":{"schemaVersion":1,"name":"Scratch Test","slug":"scratch-test","createdAt":"2026-08-02T00:00:00.000Z","updatedAt":"2026-08-02T00:00:00.000Z","regions":[12850]},"regions":[{"schemaVersion":1,"regionId":12850,"removes":["0000001a"],"placements":[]}]}'
curl -s localhost:5173/api/dev/saves/scratch-test
curl -s -X DELETE localhost:5173/api/dev/saves/scratch-test
```

Expected: `{"saves":[]}` then `{"ok":true,...}`, then the bundle back verbatim, then `{"ok":true,...}`. Confirm `packages/extractor/saves/scratch-test/` appeared and then disappeared.

- [ ] **Step 6: Commit**

```bash
git add packages/extractor/src/saves/store.ts packages/extractor/src/index.ts \
        packages/viewer/vite.config.ts packages/viewer/src/saves/saveClient.ts
git commit -m "$(cat <<'EOF'
Add save storage on disk with dev endpoints and client

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: SaveStore

**Files:**
- Create: `packages/viewer/src/saves/saveStore.ts`, `packages/viewer/src/saves/saveStore.test.ts`

**Interfaces:**
- Consumes: `saveModel.ts` (Task 2), `hideLoc.ts` (Task 3), `Placer.spawnAt` (Task 4), `@rsmap/shared/save-file` (Task 1).
- Produces: `SaveStore` with `trackSpawn`, `updateFromMesh`, `untrack`, `addRemove`, `applyToRegion`, `detachRegion`, `clear`, `load`, `serialize`, `isDirty`, `markClean`, `setIdentity`, `getIdentity`, `onChange`, `stats`.

- [ ] **Step 1: Write the failing tests**

`packages/viewer/src/saves/saveStore.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { REGION_SPAN } from "@rsmap/shared";
import { SAVE_SCHEMA } from "@rsmap/shared/save-file";
import { SaveStore } from "./saveStore.js";
import type { SaveStoreHost } from "./saveStore.js";

const CX = 50;
const CZ = 50;
const EAST_REGION = (51 << 8) | 50;

function makeHost(): SaveStoreHost {
  return {
    centerRegionX: CX,
    centerRegionZ: CZ,
    placerFor: () => null,
    getLoadedRegion: () => undefined,
  };
}

function meshAt(x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  return mesh;
}

describe("SaveStore tracking", () => {
  it("attributes a placement to the region under it and stores local coords", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(REGION_SPAN + 200, 15, -300);

    store.trackSpawn(mesh, { kind: "object", id: 1278, plane: 0, type: 10 });

    const bundle = store.serialize({ name: "T", slug: "t" });
    const region = bundle.regions.find((r) => r.regionId === EAST_REGION);
    expect(region?.placements[0]).toMatchObject({
      kind: "object",
      id: 1278,
      x: 200,
      y: 15,
      z: -300,
      type: 10,
    });
  });

  it("moves a placement between regions when it crosses a seam", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100);
    store.trackSpawn(mesh, { kind: "npc", id: 3105, plane: 0 });

    mesh.position.x = REGION_SPAN + 50;
    store.updateFromMesh(mesh);

    const bundle = store.serialize({ name: "T", slug: "t" });
    expect(bundle.regions.find((r) => r.regionId === 12850)).toBeUndefined();
    expect(
      bundle.regions.find((r) => r.regionId === EAST_REGION)?.placements[0]?.x,
    ).toBe(50);
  });

  it("drops a placement on untrack", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100);
    store.trackSpawn(mesh, { kind: "item", id: 995, plane: 0 });
    store.untrack(mesh);
    expect(store.serialize({ name: "T", slug: "t" }).regions).toHaveLength(0);
  });

  it("records rotation as a free angle", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100, Math.PI / 4);
    store.trackSpawn(mesh, { kind: "object", id: 1278, plane: 0, type: 10 });
    expect(
      store.serialize({ name: "T", slug: "t" }).regions[0]!.placements[0]!.rotationY,
    ).toBeCloseTo(Math.PI / 4);
  });
});

describe("SaveStore dirty state", () => {
  it("starts clean and goes dirty on the first mutation", () => {
    const store = new SaveStore(makeHost());
    expect(store.isDirty()).toBe(false);
    store.addRemove(12850, "0000001a");
    expect(store.isDirty()).toBe(true);
  });

  it("fires onChange for every mutation", () => {
    const store = new SaveStore(makeHost());
    const spy = vi.fn();
    store.onChange = spy;
    store.addRemove(12850, "0000001a");
    store.trackSpawn(meshAt(0, 0, 0), { kind: "npc", id: 1, plane: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("is clean again after markClean", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.markClean();
    expect(store.isDirty()).toBe(false);
  });
});

describe("SaveStore serialization", () => {
  it("round-trips through serialize and load", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.trackSpawn(meshAt(300, 12, -400, 1.5), {
      kind: "object",
      id: 1278,
      plane: 0,
      type: 10,
    });
    const bundle = store.serialize({ name: "Lumbridge Raid", slug: "lumbridge-raid" });

    const reloaded = new SaveStore(makeHost());
    reloaded.load(bundle);

    expect(reloaded.serialize({ name: "Lumbridge Raid", slug: "lumbridge-raid" }))
      .toEqual(bundle);
    expect(bundle.manifest.schemaVersion).toBe(SAVE_SCHEMA);
    expect(bundle.regions[0]!.removes).toEqual(["0000001a"]);
  });

  it("omits regions whose only content was removed", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.removeRemove(12850, "0000001a");
    expect(store.serialize({ name: "T", slug: "t" }).regions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @rsmap/viewer test saveStore`
Expected: FAIL — `./saveStore.js` does not exist.

- [ ] **Step 3: Write the implementation**

`packages/viewer/src/saves/saveStore.ts`:

```ts
import * as THREE from "three";
import {
  SAVE_SCHEMA,
  type SaveBundle,
  type SaveRegionFile,
  type SavedPlacement,
  type SavedPlacementKind,
  emptyRegionFile,
  isRegionFileEmpty,
} from "@rsmap/shared/save-file";
import type { Placer } from "../tools/placerTypes.js";
import { buildPlacementIndex, hideSlot } from "../locs/hideLoc.js";
import {
  regionLocalToWorld,
  regionOriginFor,
  worldToRegionId,
  worldToRegionLocal,
} from "./saveModel.js";

/**
 * The active map save, in memory.
 *
 * Two kinds of content: `removes` (baked locs hidden by placement id) and
 * `placements` (entities the user dropped, across all four placer kinds).
 * Both are stored per region in region-local coordinates, so the same save
 * loads identically regardless of which region the viewer centred on.
 *
 * The store owns no scene state beyond a mesh↔placement mapping. Applying
 * to a region and detaching from one are explicit calls made by main.ts's
 * streaming loader, because only it knows when a region's groups exist.
 *
 * Replaces the old `PendingEdits`: there is no separate "pending" concept
 * any more — the store IS the map, and `isDirty()` tracks whether it has
 * been written to disk since the last change.
 */

export interface SaveStoreHost {
  centerRegionX: number;
  centerRegionZ: number;
  /** Placer that owns a given entity kind, or null if unavailable. */
  placerFor: (kind: SavedPlacementKind) => Placer | null;
  /** Loaded region's scene handles, or undefined if it isn't loaded. */
  getLoadedRegion: (
    regionId: number,
  ) => { offsetX: number; offsetZ: number; locsGroup: THREE.Object3D } | undefined;
}

export interface TrackSpawnInfo {
  kind: SavedPlacementKind;
  id: number;
  plane: number;
  type?: number;
  animationOverride?: number | null;
}

interface RegionSlice {
  removes: Set<string>;
  placements: Set<SavedPlacement>;
}

/** Meshes spawned by `applyToRegion` carry this so `detachRegion` can find
 *  them again without consulting the store. */
interface SaveMeshUserData {
  saveRegionId?: number;
}

export interface ApplyResult {
  hidden: number;
  spawned: number;
  /** Placements whose entity id wouldn't bake on this cache build. */
  skipped: number;
}

export class SaveStore {
  private readonly host: SaveStoreHost;
  private readonly byRegion = new Map<number, RegionSlice>();
  private readonly byMesh = new Map<THREE.Mesh, { regionId: number; data: SavedPlacement }>();
  private dirty = false;
  private slug: string | null = null;
  private name: string | null = null;

  /** Fired after every mutation so the map menu can refresh its label. */
  onChange: (() => void) | null = null;

  constructor(host: SaveStoreHost) {
    this.host = host;
  }

  getIdentity(): { slug: string | null; name: string | null } {
    return { slug: this.slug, name: this.name };
  }

  setIdentity(slug: string, name: string): void {
    this.slug = slug;
    this.name = name;
    this.onChange?.();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
    this.onChange?.();
  }

  stats(): { regions: number; placements: number; removes: number } {
    let placements = 0;
    let removes = 0;
    for (const slice of this.byRegion.values()) {
      placements += slice.placements.size;
      removes += slice.removes.size;
    }
    return { regions: this.byRegion.size, placements, removes };
  }

  private slice(regionId: number): RegionSlice {
    let s = this.byRegion.get(regionId);
    if (!s) {
      s = { removes: new Set(), placements: new Set() };
      this.byRegion.set(regionId, s);
    }
    return s;
  }

  private touched(): void {
    this.dirty = true;
    this.onChange?.();
  }

  /** Region + local coords for a world position, or null when the position
   *  falls off the addressable cache grid. */
  private locate(
    position: THREE.Vector3,
  ): { regionId: number; local: { x: number; y: number; z: number } } | null {
    const regionId = worldToRegionId(
      position.x,
      position.z,
      this.host.centerRegionX,
      this.host.centerRegionZ,
    );
    if (regionId === null) return null;
    const origin = regionOriginFor(regionId, this.host.centerRegionX, this.host.centerRegionZ);
    return { regionId, local: worldToRegionLocal(position, origin) };
  }

  /** Record a newly placed mesh. Called from the placers' spawn hook. */
  trackSpawn(mesh: THREE.Mesh, info: TrackSpawnInfo): void {
    const located = this.locate(mesh.position);
    if (!located) {
      console.warn("[saves] placement outside the cache grid — not tracked");
      return;
    }
    const data: SavedPlacement = {
      kind: info.kind,
      id: info.id,
      plane: info.plane,
      x: located.local.x,
      y: located.local.y,
      z: located.local.z,
      rotationY: mesh.rotation.y,
    };
    if (info.type !== undefined) data.type = info.type;
    if (info.animationOverride !== undefined) {
      data.animationOverride = info.animationOverride;
    }
    this.slice(located.regionId).placements.add(data);
    this.byMesh.set(mesh, { regionId: located.regionId, data });
    this.touched();
  }

  /** Re-read a tracked mesh's pose after a gizmo drag, numeric edit, or
   *  arrow nudge — including re-attributing it to a different region when
   *  it crossed a seam. */
  updateFromMesh(mesh: THREE.Mesh): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    const located = this.locate(mesh.position);
    if (!located) return;
    if (located.regionId !== tracked.regionId) {
      this.slice(tracked.regionId).placements.delete(tracked.data);
      this.slice(located.regionId).placements.add(tracked.data);
      tracked.regionId = located.regionId;
    }
    tracked.data.x = located.local.x;
    tracked.data.y = located.local.y;
    tracked.data.z = located.local.z;
    tracked.data.rotationY = mesh.rotation.y;
    this.touched();
  }

  /** Forget a placement entirely (user deleted it). */
  untrack(mesh: THREE.Mesh): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    this.slice(tracked.regionId).placements.delete(tracked.data);
    this.byMesh.delete(mesh);
    this.touched();
  }

  /** Per-placement animation override changed via the inspector. */
  setAnimationOverride(mesh: THREE.Mesh, animationId: number): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    tracked.data.animationOverride = animationId;
    this.touched();
  }

  addRemove(regionId: number, placementIdHex: string): void {
    const slice = this.slice(regionId);
    if (slice.removes.has(placementIdHex)) return;
    slice.removes.add(placementIdHex);
    this.touched();
  }

  removeRemove(regionId: number, placementIdHex: string): boolean {
    const slice = this.byRegion.get(regionId);
    if (!slice?.removes.delete(placementIdHex)) return false;
    this.touched();
    return true;
  }

  /**
   * Apply this save's slice of `regionId` to a freshly loaded region:
   * hide tombstoned baked locs, then re-materialize placements through
   * their placers. Safe to call when the save has nothing for the region.
   */
  async applyToRegion(regionId: number): Promise<ApplyResult> {
    const result: ApplyResult = { hidden: 0, spawned: 0, skipped: 0 };
    const slice = this.byRegion.get(regionId);
    if (!slice) return result;
    const loaded = this.host.getLoadedRegion(regionId);
    if (!loaded) return result;

    if (slice.removes.size > 0) {
      const index = buildPlacementIndex(loaded.locsGroup);
      if (index.size === 0) {
        console.warn(
          `[saves] region ${regionId} bundle has no placementIds — ${slice.removes.size} removes skipped (re-extract to upgrade)`,
        );
      }
      for (const hex of slice.removes) {
        const slot = index.get(hex);
        if (!slot) continue;
        hideSlot(slot);
        result.hidden++;
      }
    }

    const origin = { offsetX: loaded.offsetX, offsetZ: loaded.offsetZ };
    // Spawn sequentially per placement but let identical ids share one
    // fetch — the placer's own cache handles that, so a plain loop is
    // enough and keeps ordering deterministic.
    for (const data of slice.placements) {
      const placer = this.host.placerFor(data.kind);
      if (!placer) {
        result.skipped++;
        continue;
      }
      const world = regionLocalToWorld(data, origin);
      const mesh = await placer.spawnAt({
        id: data.id,
        position: world,
        rotationY: data.rotationY,
        plane: data.plane,
        animationOverride: data.animationOverride ?? null,
        notify: false,
      });
      if (!mesh) {
        result.skipped++;
        continue;
      }
      (mesh.userData as SaveMeshUserData).saveRegionId = regionId;
      this.byMesh.set(mesh, { regionId, data });
      result.spawned++;
    }
    return result;
  }

  /** Remove the meshes this save spawned for a region that is unloading.
   *  Store data is untouched — re-entering the region respawns them. */
  detachRegion(regionId: number): void {
    for (const [mesh, tracked] of [...this.byMesh]) {
      if (tracked.regionId !== regionId) continue;
      const placer = this.host.placerFor(tracked.data.kind);
      placer?.removeMesh(mesh);
      this.byMesh.delete(mesh);
    }
  }

  /** Drop every mesh and every record — "New map". Callers reload regions
   *  afterwards to restore hidden baked locs. */
  clear(): void {
    for (const [mesh, tracked] of [...this.byMesh]) {
      this.host.placerFor(tracked.data.kind)?.removeMesh(mesh);
    }
    this.byMesh.clear();
    this.byRegion.clear();
    this.slug = null;
    this.name = null;
    this.dirty = false;
    this.onChange?.();
  }

  /** Replace store contents with a loaded save. Does not touch the scene —
   *  the caller reloads regions, and `applyToRegion` does the rest. */
  load(bundle: SaveBundle): void {
    this.byRegion.clear();
    this.byMesh.clear();
    for (const region of bundle.regions) {
      const slice = this.slice(region.regionId);
      for (const hex of region.removes) slice.removes.add(hex);
      for (const p of region.placements) slice.placements.add({ ...p });
    }
    this.slug = bundle.manifest.slug;
    this.name = bundle.manifest.name;
    this.dirty = false;
    this.onChange?.();
  }

  serialize(identity: { name: string; slug: string; createdAt?: string }): SaveBundle {
    const now = new Date().toISOString();
    const regions: SaveRegionFile[] = [];
    for (const [regionId, slice] of this.byRegion) {
      const file = emptyRegionFile(regionId);
      file.removes = [...slice.removes].sort();
      file.placements = [...slice.placements];
      if (!isRegionFileEmpty(file)) regions.push(file);
    }
    regions.sort((a, b) => a.regionId - b.regionId);
    return {
      manifest: {
        schemaVersion: SAVE_SCHEMA,
        name: identity.name,
        slug: identity.slug,
        createdAt: identity.createdAt ?? now,
        updatedAt: now,
        regions: regions.map((r) => r.regionId),
      },
      regions,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @rsmap/viewer test saveStore`
Expected: PASS (9 tests). The round-trip test compares two `serialize()` outputs, whose `updatedAt` differ only if the clock ticks between calls — if it proves flaky, assert on `bundle.regions` instead of the whole bundle.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/viewer/src/saves/saveStore.ts packages/viewer/src/saves/saveStore.test.ts
git commit -m "$(cat <<'EOF'
Add SaveStore: active map state with per-region apply and detach

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Wire the store into the viewer

**Files:**
- Modify: `packages/viewer/src/main.ts` — replace `pendingEdits` with `saveStore` throughout: construction (~line 640-700 where placers and toolPanel are built), the placer hooks (`onPlacementSpawned` ~875, `onPlacementUpdated`, `onMeshRemoved`), `removeRegionFromScene` (~985), `startLoad`'s `.then` (~1094), `beforeunload` (~973)
- Modify: `packages/viewer/src/tools/selection.ts` — host field `pendingEdits` → `saveStore`, `addRemove` call site (~457), plus `untrack` on placed deletes

**Interfaces:**
- Consumes: `SaveStore` (Task 6), `SaveClient` (Task 5).
- Produces: `saveStore` + `saveClient` instances in `main()`, and a `reloadLoadedRegions(): Promise<void>` helper used by New/Open.

- [ ] **Step 1: Construct the store**

In `main()`, after the placers exist and before `toolPanel` is created:

```ts
  const saveClient = new SaveClient();
  const saveStore = new SaveStore({
    centerRegionX,
    centerRegionZ,
    placerFor: (kind) => {
      switch (kind) {
        case "npc": return npcPlacer;
        case "object": return objectPlacer;
        case "item": return itemPlacer;
        case "spotanim": return spotAnimPlacer;
        default: return null;
      }
    },
    getLoadedRegion: (regionId) => {
      const lr = regions.get(regionId);
      return lr
        ? { offsetX: lr.offsetX, offsetZ: lr.offsetZ, locsGroup: lr.locsGroup }
        : undefined;
    },
  });
```

- [ ] **Step 2: Repoint the placer hooks**

Replace the `objectPlacer.onPlacementSpawned` body (currently building an `EditsOverlayAdd` via `worldToTile` + `subOffsetForTile` + `decomposeRotation`) with:

```ts
  objectPlacer.onPlacementSpawned = (mesh, id, _name, modelType, _sizeX, _sizeY, plane) => {
    saveStore.trackSpawn(mesh, {
      kind: "object",
      id,
      plane,
      type: modelType ?? 10,
    });
  };
```

Add the same for the other three placers (they had no spawn hook before):

```ts
  npcPlacer.onPlacementSpawned = (mesh, id, _name, _t, _sx, _sy, plane) => {
    saveStore.trackSpawn(mesh, { kind: "npc", id, plane });
  };
  itemPlacer.onPlacementSpawned = (mesh, id, _name, _t, _sx, _sy, plane) => {
    saveStore.trackSpawn(mesh, { kind: "item", id, plane });
  };
  spotAnimPlacer.onPlacementSpawned = (mesh, id, _name, _t, _sx, _sy, plane) => {
    saveStore.trackSpawn(mesh, { kind: "spotanim", id, plane });
  };
```

For every placer, wire the pose + removal hooks:

```ts
  for (const p of [npcPlacer, objectPlacer, itemPlacer, spotAnimPlacer]) {
    p.onPlacementUpdated = (mesh) => saveStore.updateFromMesh(mesh);
    const prevRemoved = p.onMeshRemoved;
    p.onMeshRemoved = (mesh) => {
      saveStore.untrack(mesh);
      prevRemoved?.(mesh);
    };
  }
```

Delete `subOffsetForTile`, `decomposeRotation`, `pendingObjectAdds`, `commitPendingEdits`, `refreshCommitButton`, `commitInFlight`, and the `PendingEdits` import — they have no remaining callers. `worldToTile` stays: the debug inspector uses it.

- [ ] **Step 3: Apply on load, detach on unload**

In `startLoad`'s `.then((lr) => {...})`, after `eyedropper.addRegion(...)`:

```ts
        void saveStore.applyToRegion(lr.regionId).then((r) => {
          if (r.skipped > 0) {
            setHud(`${r.skipped} saved placement(s) unavailable on this cache build`);
          }
        });
```

In `removeRegionFromScene`, before `regions.delete(regionId)`:

```ts
    saveStore.detachRegion(regionId);
```

Add the reload helper next to `removeRegionFromScene`:

```ts
  /** Tear down and re-fetch every loaded region. Used by New map / Open —
   *  bundles on disk are vanilla, so this is how hidden baked locs come
   *  back without any un-hide bookkeeping. */
  const reloadLoadedRegions = async (): Promise<void> => {
    const ids = [...regions.keys()];
    for (const id of ids) removeRegionFromScene(id);
    await Promise.allSettled(ids.map((id) => startLoad(id)));
  };
```

- [ ] **Step 4: Swap the beforeunload guard**

```ts
  window.addEventListener("beforeunload", (e) => {
    if (saveStore.isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
```

- [ ] **Step 5: Repoint selection**

In `packages/viewer/src/tools/selection.ts`, change the host interface field from `pendingEdits: PendingEdits` to `saveStore: SaveStore`, and at the tombstone call site:

```ts
    this.host.saveStore.addRemove(regionId, locHit.placementIdHex);
```

`removeMesh` already fires `onMeshRemoved`, which now calls `untrack`, so placed-entity deletes need no extra call here.

- [ ] **Step 6: Verify in the browser**

Run: `pnpm typecheck` — expected clean (the `toolPanel` `onCommit`/`setCommitState` references will still compile because Task 8 hasn't removed them yet; if TS complains about the now-unused `commitPendingEdits` forward declaration, delete it).

Run: `pnpm dev`. There is no save UI yet, so verify the wiring through behaviour:

1. Place an object → attempt to reload the page → the browser's "leave site?" prompt appears (dirty flag reached `beforeunload`).
2. Delete a baked loc → it disappears and stays gone (the store recorded the remove; nothing re-bakes).
3. Place an object near the east seam, pan east until the origin region unloads, then pan back → the object is still there at the same spot (detach + re-apply round-tripped it).

Step 3 is the one that catches a broken `applyToRegion`; do not skip it.

- [ ] **Step 7: Commit**

```bash
git add packages/viewer/src/main.ts packages/viewer/src/tools/selection.ts
git commit -m "$(cat <<'EOF'
Track editor placements in SaveStore instead of PendingEdits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Map menu UI + autoload

**Files:**
- Create: `packages/viewer/src/ui/mapMenu.ts`
- Modify: `packages/viewer/src/tools/toolPanel.ts` (replace the `commit` button with a `map` button + drop `onCommit` / `setCommitState`), `packages/viewer/src/main.ts` (mount the menu, autoload)

**Interfaces:**
- Consumes: `SaveStore`, `SaveClient`, `reloadLoadedRegions` (Task 7), `slugify` (Task 1).
- Produces: `MapMenu` class with `constructor(opts: MapMenuOptions)`, `refresh(): void`, and `mount(head: HTMLElement): void`.

```ts
export interface MapMenuOptions {
  store: SaveStore;
  client: SaveClient;
  /** Reload every loaded region from disk (vanilla bundles). */
  reloadRegions: () => Promise<void>;
  /** Status line for feedback ("saved", "load failed: …"). */
  setStatus: (msg: string) => void;
}
```

- [ ] **Step 1: Replace the commit button in the tool panel**

In `toolPanel.ts`, swap the `commit` button markup for a menu anchor the map menu owns:

```html
          <span class="map-slot"></span>
```

Keep the CSS block but rename `.commit` → `.map-btn` (the map button reuses the same colours). Delete `onCommit` from `ToolPanelHost`, delete `setCommitState`, the `commitBtn` field, and its click listener. Add:

```ts
  /** Element the MapMenu mounts into. Kept as a slot so the panel doesn't
   *  need to know anything about saves. */
  getMapSlot(): HTMLElement {
    return this.root.querySelector<HTMLElement>(".map-slot")!;
  }
```

- [ ] **Step 2: Write the menu**

`packages/viewer/src/ui/mapMenu.ts`:

```ts
import { slugify } from "@rsmap/shared/save-file";
import type { SaveClient } from "../saves/saveClient.js";
import type { SaveStore } from "../saves/saveStore.js";

/**
 * Head-bar map control: shows the active save's name plus a dirty dot, and
 * opens a dropdown with New / Open / Save / Save as / Export / Import /
 * Delete.
 *
 * Every destructive action (New, Open, Delete) confirms first when the
 * store is dirty. The control disables itself when no dev server is
 * present — a static build can render a map but can't persist one.
 */

export interface MapMenuOptions {
  store: SaveStore;
  client: SaveClient;
  reloadRegions: () => Promise<void>;
  setStatus: (msg: string) => void;
}

export class MapMenu {
  private readonly opts: MapMenuOptions;
  private readonly button = document.createElement("button");
  private readonly dropdown = document.createElement("div");
  private available = false;
  private createdAt: string | null = null;

  constructor(opts: MapMenuOptions) {
    this.opts = opts;
    this.button.className = "head-btn map-btn";
    this.button.type = "button";
    this.button.title = "map saves";
    this.button.addEventListener("click", () => void this.toggle());
    this.dropdown.className = "map-dropdown";
    this.dropdown.style.display = "none";
    opts.store.onChange = () => this.refresh();
    void opts.client.isAvailable().then((ok) => {
      this.available = ok;
      this.refresh();
    });
  }

  mount(slot: HTMLElement): void {
    slot.appendChild(this.button);
    slot.appendChild(this.dropdown);
    this.refresh();
  }

  refresh(): void {
    const { name } = this.opts.store.getIdentity();
    const dirty = this.opts.store.isDirty() ? " •" : "";
    this.button.textContent = `map: ${name ?? "untitled"}${dirty}`;
    this.button.disabled = !this.available;
    this.button.title = this.available
      ? "map saves"
      : "saves need the dev server (pnpm dev)";
  }

  private async toggle(): Promise<void> {
    if (this.dropdown.style.display === "block") {
      this.dropdown.style.display = "none";
      return;
    }
    this.dropdown.replaceChildren();
    const add = (label: string, onClick: () => void | Promise<void>): void => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "map-item";
      item.textContent = label;
      item.addEventListener("click", () => {
        this.dropdown.style.display = "none";
        void onClick();
      });
      this.dropdown.appendChild(item);
    };

    add("New map", () => this.newMap());
    add("Save", () => this.save());
    add("Save as…", () => this.saveAs());
    add("Export", () => this.exportFile());
    add("Import", () => this.importFile());
    if (this.opts.store.getIdentity().slug) add("Delete", () => this.deleteActive());

    const saves = await this.opts.client.list().catch(() => []);
    if (saves.length > 0) {
      const sep = document.createElement("div");
      sep.className = "map-sep";
      sep.textContent = "open";
      this.dropdown.appendChild(sep);
      for (const s of saves) {
        add(`${s.name} (${s.regions.length} region${s.regions.length === 1 ? "" : "s"})`, () =>
          this.open(s.slug),
        );
      }
    }
    this.dropdown.style.display = "block";
  }

  private confirmDiscard(): boolean {
    if (!this.opts.store.isDirty()) return true;
    return window.confirm("Discard unsaved changes to the current map?");
  }

  private async newMap(): Promise<void> {
    if (!this.confirmDiscard()) return;
    this.opts.store.clear();
    this.createdAt = null;
    await this.opts.reloadRegions();
    this.opts.setStatus("new map");
  }

  private async open(slug: string): Promise<void> {
    if (!this.confirmDiscard()) return;
    try {
      const bundle = await this.opts.client.read(slug);
      this.opts.store.clear();
      this.opts.store.load(bundle);
      this.createdAt = bundle.manifest.createdAt;
      await this.opts.reloadRegions();
      localStorage.setItem("rsmap.lastSave", slug);
      this.opts.setStatus(`opened ${bundle.manifest.name}`);
    } catch (err) {
      this.opts.setStatus(`open failed: ${(err as Error).message}`);
    }
  }

  private async save(): Promise<void> {
    const { slug, name } = this.opts.store.getIdentity();
    if (!slug || !name) return this.saveAs();
    await this.writeAs(name, slug);
  }

  private async saveAs(): Promise<void> {
    const suggested = this.opts.store.getIdentity().name ?? "untitled";
    const name = window.prompt("Save map as:", suggested);
    if (!name) return;
    const slug = slugify(name);
    const existing = await this.opts.client.list().catch(() => []);
    if (
      existing.some((s) => s.slug === slug) &&
      slug !== this.opts.store.getIdentity().slug &&
      !window.confirm(`"${slug}" already exists. Overwrite?`)
    ) {
      return;
    }
    this.createdAt = null;
    await this.writeAs(name, slug);
  }

  private async writeAs(name: string, slug: string): Promise<void> {
    try {
      const bundle = this.opts.store.serialize({
        name,
        slug,
        createdAt: this.createdAt ?? undefined,
      });
      await this.opts.client.write(bundle);
      this.createdAt = bundle.manifest.createdAt;
      this.opts.store.setIdentity(slug, name);
      this.opts.store.markClean();
      localStorage.setItem("rsmap.lastSave", slug);
      const { regions, placements, removes } = this.opts.store.stats();
      this.opts.setStatus(
        `saved ${name} — ${placements} placement(s), ${removes} remove(s), ${regions} region(s)`,
      );
    } catch (err) {
      this.opts.setStatus(`save failed: ${(err as Error).message}`);
    }
  }

  private exportFile(): void {
    const { slug, name } = this.opts.store.getIdentity();
    const bundle = this.opts.store.serialize({
      name: name ?? "untitled",
      slug: slug ?? "untitled",
      createdAt: this.createdAt ?? undefined,
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${bundle.manifest.slug}.rsmap.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private importFile(): void {
    if (!this.confirmDiscard()) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (text) => {
        try {
          const bundle = JSON.parse(text) as unknown;
          this.opts.store.clear();
          // load() takes a parsed bundle; SaveClient.read validates on the
          // network path, so validate here too before trusting the file.
          const { parseSaveBundle } = await import("@rsmap/shared/save-file");
          const parsed = parseSaveBundle(bundle);
          this.opts.store.load(parsed);
          this.createdAt = parsed.manifest.createdAt;
          await this.opts.reloadRegions();
          this.opts.setStatus(`imported ${parsed.manifest.name} (unsaved)`);
        } catch (err) {
          this.opts.setStatus(`import failed: ${(err as Error).message}`);
        }
      });
    });
    input.click();
  }

  private async deleteActive(): Promise<void> {
    const { slug, name } = this.opts.store.getIdentity();
    if (!slug) return;
    if (!window.confirm(`Delete save "${name ?? slug}"? This removes it from disk.`)) return;
    try {
      await this.opts.client.remove(slug);
      if (localStorage.getItem("rsmap.lastSave") === slug) {
        localStorage.removeItem("rsmap.lastSave");
      }
      this.opts.store.clear();
      await this.opts.reloadRegions();
      this.opts.setStatus(`deleted ${slug}`);
    } catch (err) {
      this.opts.setStatus(`delete failed: ${(err as Error).message}`);
    }
  }
}
```

Add matching CSS to `toolPanel.ts`'s `injectStyles()` (same visual language as the existing head buttons):

```css
    #toolPanel .map-slot { position: relative; }
    #toolPanel .map-dropdown {
      position: absolute; top: 22px; right: 0; z-index: 20;
      background: #10151f; border: 1px solid #2a334a; border-radius: 4px;
      min-width: 200px; padding: 4px 0; box-shadow: 0 4px 16px #0008;
    }
    #toolPanel .map-dropdown .map-item {
      display: block; width: 100%; text-align: left; background: transparent;
      border: none; color: #c8d0e0; font: inherit; padding: 4px 10px; cursor: pointer;
    }
    #toolPanel .map-dropdown .map-item:hover { background: #1d2740; color: #e6f0fa; }
    #toolPanel .map-dropdown .map-sep {
      color: #5a6478; font-size: 10px; text-transform: uppercase;
      padding: 6px 10px 2px; border-top: 1px solid #2a334a; margin-top: 4px;
    }
```

- [ ] **Step 3: Mount it and add autoload**

In `main.ts`, after `toolPanel` is constructed:

```ts
  const mapMenu = new MapMenu({
    store: saveStore,
    client: saveClient,
    reloadRegions: reloadLoadedRegions,
    setStatus: (msg) => setHud(msg),
  });
  mapMenu.mount(toolPanel.getMapSlot());

  // Autoload: ?save=<slug> wins, then the last save this browser opened.
  // `?save=none` forces a vanilla map.
  const saveParam = new URLSearchParams(location.search).get("save");
  const autoSlug =
    saveParam === "none" ? null : (saveParam ?? localStorage.getItem("rsmap.lastSave"));
  if (autoSlug && (await saveClient.isAvailable())) {
    try {
      const bundle = await saveClient.read(autoSlug);
      saveStore.load(bundle);
      await Promise.all([...regions.keys()].map((id) => saveStore.applyToRegion(id)));
      setHud(`loaded map ${bundle.manifest.name}`);
    } catch (err) {
      console.warn(`[saves] autoload of "${autoSlug}" failed:`, err);
    }
  }
```

Place this after the initial `Promise.allSettled` region load so the first regions exist — applying to already-loaded regions here, and `startLoad`'s hook covering everything that streams in later.

- [ ] **Step 4: Verify the full loop by hand**

Run: `pnpm dev`

1. Place two objects and an NPC; delete one baked loc.
2. Map menu → Save as… → "Test Map". Confirm `packages/extractor/saves/test-map/` has `manifest.json` + `12850.json`, and that the JSON matches what you placed.
3. Refresh. The map reloads automatically (autoload from localStorage); placements and the hidden loc are back.
4. Map menu → New map. Scene returns to vanilla, including the previously deleted loc.
5. Map menu → open "Test Map" again; everything returns.
6. Export, then New map, then Import the downloaded file — same scene.
7. Load `?save=none` — vanilla, and the menu label reads `map: untitled`.

Run: `pnpm typecheck` and `pnpm --filter @rsmap/viewer test` — both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/viewer/src/ui/mapMenu.ts packages/viewer/src/tools/toolPanel.ts packages/viewer/src/main.ts
git commit -m "$(cat <<'EOF'
Add map menu with save, open, export and import

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Migrate edits/12850.json into a save

**Files:**
- Create (temporary): `packages/viewer/src/saves/importLegacyEdits.ts`
- Modify (temporary): `packages/viewer/src/ui/mapMenu.ts` (one extra menu item)
- Create: `packages/extractor/saves/lumbridge/…` (the committed output)

**Interfaces:**
- Consumes: `SaveStore`, `Placer.spawnAt`, `sampleTerrainAt` from `main.ts`.
- Produces: `importLegacyEdits(opts): Promise<{ imported: number; skipped: number }>` — deleted again in Task 10.

This task inverts the bake-prediction math in `main.ts:836` (`subOffsetForTile`). Read that function and its comment block before writing the inverse; the `sizeX`/`sizeY` swap on cardinal rotation 1 or 3 is the part that silently corrupts positions if skipped.

- [ ] **Step 1: Write the importer**

`packages/viewer/src/saves/importLegacyEdits.ts`:

```ts
import * as THREE from "three";
import { TILE_SIZE } from "@rsmap/shared";
import type { Placer } from "../tools/placerTypes.js";

/**
 * THROWAWAY. Converts the pre-saves `packages/extractor/edits/<id>.json`
 * overlay into live placements so it can be saved as a named map. Delete
 * this file once the conversion is committed — keeping it would mean
 * keeping the bbox-base inverse below alive forever, which is exactly what
 * the saves redesign retires.
 *
 * The old format stored `tileX/tileZ` plus offsets measured against the
 * position `placeLocs` produces AFTER a re-bake. Reconstructing a world
 * position therefore means redoing the bake prediction and adding the
 * recorded offset:
 *
 *   bakeBaseX = tileX * TILE_SIZE + (offsetCellsX * TILE_SIZE) / 2
 *   bakeBaseZ = -(tileZ * TILE_SIZE + (offsetCellsY * TILE_SIZE) / 2)
 *   worldX    = bakeBaseX + (offsetX ?? 0)
 *   worldZ    = bakeBaseZ + (offsetZ ?? 0)
 *   worldY    = terrainY(bakeBaseX, bakeBaseZ, plane) + (offsetY ?? 0)
 *
 * where offsetCells is the loc's tile footprint for bbox-centered types
 * (10, 11) and 1 otherwise — with sizeX/sizeY SWAPPED when the cardinal
 * rotation is 1 or 3.
 *
 * World rotation is the inverse of `decomposeRotation`: cardinal R means
 * world angle −R × π/2, plus the stored residual `rotationY`.
 */

interface LegacyAdd {
  locId: number;
  plane: number;
  tileX: number;
  tileZ: number;
  type: number;
  rotation: number;
  animationOverride: number | null;
  offsetX?: number;
  offsetZ?: number;
  offsetY?: number;
  rotationY?: number;
}

interface LegacyOverlay {
  regionId: number;
  removes: string[];
  adds: LegacyAdd[];
}

export interface ImportLegacyOptions {
  /** Fetched JSON of the old overlay file. */
  overlay: LegacyOverlay;
  /** Region offsets for the overlay's region, from the loaded region. */
  offsetX: number;
  offsetZ: number;
  objectPlacer: Placer;
  /** Object footprint lookup — `/api/object/:id` returns sizeX/sizeY. */
  fetchSize: (locId: number) => Promise<{ sizeX: number; sizeY: number }>;
  sampleTerrainAt: (worldX: number, worldZ: number, plane?: number) => number | null;
  onRemove: (regionId: number, placementIdHex: string) => void;
}

export async function importLegacyEdits(
  opts: ImportLegacyOptions,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const hex of opts.overlay.removes) opts.onRemove(opts.overlay.regionId, hex);

  for (const add of opts.overlay.adds) {
    const { sizeX, sizeY } = await opts.fetchSize(add.locId).catch(() => ({
      sizeX: 1,
      sizeY: 1,
    }));
    const isBoundingBoxed = add.type === 10 || add.type === 11;
    const swap = isBoundingBoxed && (add.rotation === 1 || add.rotation === 3);
    const effSX = swap ? sizeY : sizeX;
    const effSY = swap ? sizeX : sizeY;
    const cellsX = isBoundingBoxed ? effSX : 1;
    const cellsY = isBoundingBoxed ? effSY : 1;

    const baseX = add.tileX * TILE_SIZE + (cellsX * TILE_SIZE) / 2;
    const baseZ = -(add.tileZ * TILE_SIZE + (cellsY * TILE_SIZE) / 2);
    const localX = baseX + (add.offsetX ?? 0);
    const localZ = baseZ + (add.offsetZ ?? 0);
    const worldX = localX + opts.offsetX;
    const worldZ = localZ + opts.offsetZ;
    const terrainY = opts.sampleTerrainAt(baseX + opts.offsetX, baseZ + opts.offsetZ, add.plane);
    if (terrainY === null) {
      console.warn(`[legacy] no terrain under loc ${add.locId} at ${add.tileX},${add.tileZ}`);
      skipped++;
      continue;
    }
    const worldY = terrainY + (add.offsetY ?? 0);
    const rotationY = -add.rotation * (Math.PI / 2) + (add.rotationY ?? 0);

    const mesh = await opts.objectPlacer.spawnAt({
      id: add.locId,
      position: new THREE.Vector3(worldX, worldY, worldZ),
      rotationY,
      plane: add.plane,
      notify: true, // let the normal spawn hook track it into the store
    });
    if (mesh) imported++;
    else skipped++;
  }

  return { imported, skipped };
}
```

- [ ] **Step 2: Add the temporary menu item**

In `mapMenu.ts`'s `toggle()`, after `add("Import", …)`:

```ts
    add("Import legacy edits…", () => this.importLegacy());
```

and a method that fetches the old file and calls the importer. The overlay lives outside `public/`, so read it through a one-off file picker rather than adding an endpoint:

```ts
  private importLegacy(): void {
    if (!this.confirmDiscard()) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (text) => {
        const { importLegacyEdits } = await import("../saves/importLegacyEdits.js");
        const result = await this.opts.importLegacy!(
          JSON.parse(text) as never,
          importLegacyEdits,
        );
        this.opts.setStatus(
          `legacy import: ${result.imported} placed, ${result.skipped} skipped — save it now`,
        );
      });
    });
    input.click();
  }
```

Add the matching optional hook to `MapMenuOptions`:

```ts
  /** THROWAWAY (see importLegacyEdits.ts). Wired only while migrating the
   *  pre-saves overlay; both this and the module go away afterwards. */
  importLegacy?: (
    overlay: unknown,
    run: typeof import("../saves/importLegacyEdits.js").importLegacyEdits,
  ) => Promise<{ imported: number; skipped: number }>;
```

In `main.ts`, supply it — this is where `sampleTerrainAt`, the loaded region offsets, and an object-size fetch are all in scope:

```ts
    importLegacy: async (overlay, run) => {
      const o = overlay as { regionId: number };
      const lr = regions.get(o.regionId);
      if (!lr) throw new Error(`region ${o.regionId} is not loaded`);
      return run({
        overlay: overlay as never,
        offsetX: lr.offsetX,
        offsetZ: lr.offsetZ,
        objectPlacer,
        fetchSize: async (locId) => {
          const r = await fetch(`/api/object/${locId}`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.json()) as { sizeX?: number; sizeY?: number };
          return { sizeX: body.sizeX ?? 1, sizeY: body.sizeY ?? 1 };
        },
        sampleTerrainAt,
        onRemove: (regionId, hex) => saveStore.addRemove(regionId, hex),
      });
    },
```

- [ ] **Step 3: Run the migration**

Run: `pnpm dev`, open `?region=12850&save=none`.

1. Map menu → Import legacy edits… → pick `packages/extractor/edits/12850.json`.
2. Expect the status line to read `legacy import: 180 placed, 0 skipped`. Any non-zero skip count means the inverse math or a fetch failed — investigate before saving.
3. The bundle at `public/regions/12850/` may still be the one baked *with* the old overlay applied, which would double up every placement. Re-extract first (`pnpm extract -- --region 12850`) and reload so you're looking at a vanilla bundle plus runtime placements.
4. Spot-check with the debug inspector (Shift+hover) that a multi-tile rotated object (`rotation` 1 or 3, `type` 10) landed on the same tile the old overlay recorded — that's the case the size swap governs, and the one that fails silently if the swap is dropped. Pick one from `edits/12850.json` and compare its `tileX`/`tileZ` against the inspector readout.
5. Map menu → Save as… → "Lumbridge".

- [ ] **Step 4: Commit the converted save**

```bash
git add packages/extractor/saves/lumbridge
git commit -m "$(cat <<'EOF'
Convert the Lumbridge edits overlay into a named save

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Retire the bake-time overlay path

**Files:**
- Delete: `packages/extractor/edits/`, `packages/viewer/src/tools/pendingEdits.ts`, `packages/viewer/src/saves/importLegacyEdits.ts`
- Rename: `packages/extractor/src/region/edits.ts` → `packages/extractor/src/region/placementHash.ts` (keep only `placementHash`)
- Modify: `packages/extractor/src/index.ts`, `packages/extractor/src/region/locs.ts`, `shared/src/region-bundle.ts`, `packages/viewer/vite.config.ts`, `packages/viewer/src/ui/mapMenu.ts`, `packages/viewer/src/main.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: `prepareLocs(cache, regionX, regionZ)` and `emitLocs(plan, atlas, terrainHeights)` — both lose their overlay parameters.

- [ ] **Step 1: Remove the throwaway importer**

Delete `packages/viewer/src/saves/importLegacyEdits.ts`, the `importLegacy` option from `MapMenuOptions`, the `importLegacy` implementation in `main.ts`, and the "Import legacy edits…" menu item.

- [ ] **Step 2: Strip the extractor overlay plumbing**

- `packages/extractor/src/region/edits.ts` → rename to `placementHash.ts`; delete `EDITS_DIR`, `loadEdits`, `saveEdits`, `mergeAndSaveEdits` and now-unused imports. Keep `placementHash` verbatim.
- `packages/extractor/src/region/locs.ts`: update the import to `./placementHash.js`; drop the `overlayAdds` parameter from `prepareLocs` and the `overlay` parameter from `emitLocs`, plus every branch that consumed them.
- `packages/extractor/src/index.ts`: delete the `loadEdits` import and re-exports, the `const overlay = await loadEdits(regionId)` block and its log line, and pass no overlay to `prepareLocs` / `emitLocs`.
- `shared/src/region-bundle.ts`: delete `EditsOverlay`, `EditsOverlayAdd`, and `EDITS_SCHEMA`.

```bash
git rm -r packages/extractor/edits
rm packages/viewer/src/tools/pendingEdits.ts
```

- [ ] **Step 3: Strip the commit-edits endpoint**

In `packages/viewer/vite.config.ts`, delete the `/api/dev/commit-edits` route block, `commitEditsForRegion`, `commitMutex`, and the `CommitEditsDiff` import/type.

- [ ] **Step 4: Verify nothing references the removed code**

```bash
grep -rn "pendingEdits\|PendingEdits\|commit-edits\|EditsOverlay\|loadEdits\|mergeAndSaveEdits\|EDITS_SCHEMA" \
  packages shared CLAUDE.md --include='*.ts' --include='*.md'
```

Expected: no hits outside `docs/superpowers/`.

Run: `pnpm typecheck` — clean.
Run: `pnpm --filter @rsmap/viewer test` — clean.
Run: `pnpm extract -- --region 12850` — completes, final line reports `✓ 0 parse failures`, and no `[extract] applying overlay` line appears.

- [ ] **Step 5: Confirm the bundle is vanilla and the save still loads**

Run: `pnpm dev`, open `?region=12850&save=none` — the Lumbridge edits are absent (vanilla cache scenery). Then open the map menu and load "Lumbridge" — the 180 placements and 60 hidden locs return.

- [ ] **Step 6: Update CLAUDE.md**

Replace the "**Commit-edits persistence.**" paragraph in the *In-viewer editor* section with:

```markdown
**Named map saves.** The map menu in the editor head bar saves the whole
editable scene — baked-loc removes plus every NPC / object / item / FX
placement — to `packages/extractor/saves/<slug>/` (one `manifest.json` plus
one `<regionId>.json` per touched region, checked into git as source data).
Saves apply as a *runtime overlay*: bundles under
`packages/viewer/public/regions/` are always vanilla cache output, so
switching maps or starting fresh is a scene reload, not a re-extract.
`?save=<slug>` autoloads a map, `?save=none` forces vanilla, and the last
opened save is remembered per browser. Export/import moves a save as one
`.rsmap.json`. Design: `docs/superpowers/specs/2026-08-02-save-map-design.md`.
```

Also update the *Where things live* table: drop the `edits` row if present, and add:

```markdown
| `packages/viewer/src/saves/saveStore.ts` | active map save: tracking, per-region apply/detach |
| `packages/extractor/src/saves/store.ts` | save file I/O (list / read / write / delete) |
| `shared/src/save-file.ts` | shared save schema + `SAVE_SCHEMA` |
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Retire the bake-time edits overlay in favour of named saves

Bundles are now always vanilla cache output: prepareLocs/emitLocs lose
their overlay parameters, /api/dev/commit-edits and PendingEdits are gone,
and edits/ is deleted now that its contents live in saves/lumbridge.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification Checklist

Run after Task 10:

- [ ] `pnpm typecheck` — both packages clean
- [ ] `pnpm --filter @rsmap/viewer test` — all suites pass
- [ ] `pnpm extract -- --region 12850` — no overlay log line, `✓ 0 parse failures`
- [ ] `?save=none` renders vanilla Lumbridge
- [ ] Loading "Lumbridge" restores 180 placements + 60 hidden locs
- [ ] Placing an object, panning until its region unloads, and panning back leaves it in place
- [ ] Dragging a placement across a region seam and saving writes it into the neighbour's region file
- [ ] Refresh after a save reopens the same map; refresh after New map opens vanilla
- [ ] Closing the tab with unsaved changes prompts; after Save it doesn't
