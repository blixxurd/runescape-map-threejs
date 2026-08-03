# Named map saves

**Date:** 2026-08-02
**Status:** approved design, not yet implemented

## Problem

Editor persistence today is a single bake-time overlay per region:
`packages/extractor/edits/<regionId>.json`, applied by `extractRegion` when
the region is baked. That gives one implicit slot per region and no way to
name, switch, or discard a set of edits. Starting from a vanilla map means
deleting the overlay file by hand and re-extracting — which is exactly what
happened last session.

NPC, item, and SpotAnim placements don't persist at all. They live in placer
scene groups for the length of a browser session and vanish on refresh.

## Goal

Named saves that capture the whole editable scene. Load one to get your edits
back; start fresh to get vanilla. Saves are files on disk, diffable and
committable, with export/import for sharing.

## Decisions

| Question | Decision |
|---|---|
| What a save captures | Baked-loc removes, object adds, and NPC / item / SpotAnim placements. No game-mode config (game mode lives on the `game-mode` branch). |
| Save unit | One named save spans every region it touched. |
| How edits reach the world | Runtime overlay in the viewer. Bundles stay vanilla. |
| Storage | On disk under `packages/extractor/saves/`, plus export/import of a single JSON file. |
| Old bake path | Retired. `edits/12850.json` migrates into a save; `edits/` and the commit-edits endpoint are deleted. |

### Why runtime and not re-bake

The extractor never bakes NPCs, items, or SpotAnims into bundles, and the
geometry endpoints they need (`/api/npc/:id`, `/api/object/:id`, …) are
dev-middleware only. Those three kinds can *only* be re-materialized at
runtime. Applying object edits at runtime too gives one uniform apply path for
all four kinds instead of two parallel systems.

It also makes bundles immutable: `public/regions/<id>/` is always vanilla, so
"start fresh" is a scene reload rather than a multi-second re-extract, and a
bundle can never silently carry someone else's edits.

The cost is render performance. Object adds spawn as individual meshes through
the placer rather than folding into the merged/instanced bundle geometry. For
editor-scale maps (180 placements in the largest existing overlay) that is
acceptable. If a save ever grows large enough to matter, the fix is a bake step
layered on top — not a change to the save format.

## Data model

```
packages/extractor/saves/<slug>/
  manifest.json
  12850.json
  12849.json
```

`manifest.json`:

```jsonc
{
  "schemaVersion": 1,
  "name": "Lumbridge raid",   // display name as typed
  "slug": "lumbridge-raid",   // directory name, slugified, unique
  "createdAt": "2026-08-02T18:00:00.000Z",
  "updatedAt": "2026-08-02T18:42:00.000Z",
  "regions": [12850, 12849]
}
```

Per-region file:

```jsonc
{
  "schemaVersion": 1,
  "regionId": 12850,
  "removes": ["1a2b3c"],       // placementId hex, tombstoned baked locs
  "placements": [ /* SavedPlacement */ ]
}
```

```ts
export interface SavedPlacement {
  kind: "npc" | "object" | "item" | "spotanim";
  id: number;
  plane: number;
  /** Region-local world units. Origin = the region's own SW corner, so a
   *  save stays valid regardless of which region is the streaming centre
   *  when it loads. */
  x: number;
  y: number;
  z: number;
  /** Free-angle Y rotation in radians. No cardinal/residual split — the
   *  runtime path takes an angle directly. */
  rotationY: number;
  /** Objects only. OSRS placement type chosen when the object was placed
   *  (walls 0..3, wall decor 4..8, scenery 10, floor decor 22). */
  type?: number;
  /** NPCs today. Per-placement sequence override. */
  animationOverride?: number | null;
}
```

Types live in a new `shared/src/save-file.ts` with a `SAVE_SCHEMA` constant,
following the same single-source pattern as `*_SCHEMA` in
`shared/src/region-bundle.ts`. A schema mismatch refuses the load with a clear
message; v1 does no auto-migration.

### Why region-local world coordinates

`EditsOverlayAdd` stores `tileX/tileZ` plus offsets measured against the
position `placeLocs` will produce after a re-bake. That requires predicting the
bake: the bbox-centre math in `main.ts:836` (`subOffsetForTile`), including the
`sizeX`/`sizeY` swap on cardinal rotation 1 or 3. It exists only because edits
had to survive baking.

A runtime overlay spawns through the placer, which takes a world position
directly, so the prediction is unnecessary. Storing absolute `y` also means
obey-geometry stacks reload without re-sampling terrain.

Export/import serializes a whole save — manifest plus every region inlined — as
one `<slug>.rsmap.json`.

## Components

### `SaveStore` — `packages/viewer/src/saves/saveStore.ts`

In-memory active save. Replaces `PendingEdits` entirely.

- State: `slug`, `name`, `Map<regionId, { removes: Set<string>, placements: SavedPlacement[] }>`, dirty flag.
- Mutators called by placers and selection: `addPlacement`, `updatePlacement`,
  `removePlacement`, `addRemove`, `removeRemove`. Each marks dirty and fires
  `onChange` for the head-bar badge.
- `applyToRegion(loadedRegion)` — apply this save to a freshly loaded region.
- `detachRegion(regionId)` — despawn placements when a region unloads.
- `serialize()` / `load(data)`.

### `SaveClient` — `packages/viewer/src/saves/saveClient.ts`

Thin fetch wrapper over the dev endpoints. Isolated so the store has no
knowledge of transport and stays unit-testable.

### Map menu — `packages/viewer/src/ui/mapMenu.ts`

Replaces the `commit` button in the tool panel head. Shows `map: <name> •`
(dot = unsaved). Menu items: New map, Open…, Save (⌘/Ctrl+S), Save as…,
Export, Import, Delete.

- **Save** on an unnamed map falls through to **Save as…**.
- **Save as…** slugifies the typed name; a slug collision prompts to
  overwrite or rename rather than silently replacing a save.
- **Delete** acts on the active save and then drops to a fresh vanilla map.
- Switching or creating with unsaved changes prompts once.

### Dev endpoints — `packages/viewer/vite.config.ts`

| route | behaviour |
|---|---|
| `GET /api/dev/saves` | list manifests |
| `GET /api/dev/saves/:slug` | manifest + all region files inlined |
| `PUT /api/dev/saves/:slug` | write whole save; tmp+rename per file; prune region files with no content |
| `DELETE /api/dev/saves/:slug` | remove the directory |

Import is a client-side file read followed by `PUT`. Export downloads data the
store already holds. In a static build there is no dev server, so the map menu
renders disabled with a tooltip — the same posture as the catalog fallback.

## Data flow

### Region load

`setupRegion` builds the `LoadedRegion` and calls `saveStore.applyToRegion(lr)`
after `placeLocs`:

1. Build a `placementIdHex → { mesh, instanceId | placementIdx }` index from
   the whole-region `placementIds` array that `placeLocs` stamps onto every
   mesh.
2. For each `removes` entry, hide the slot via the existing
   `hideInstancedSlot` / `hideMergedTriangles` helpers in `selection.ts`.
3. For each placement, spawn through the owning placer at
   `(x + lr.offsetX, y, z + lr.offsetZ)`. Spawns are async (geometry fetch per
   entity id) and deduped by id so twenty copies of one tree cost one fetch.
   Each spawned mesh gets `userData.saveRegionId = regionId`.

Applying per region means a multi-region save materializes incrementally as you
pan, with no separate "load the whole save" step.

### Region unload

Save-spawned meshes live in placer groups, not the region group, so
`removeRegionFromScene` calls `saveStore.detachRegion(regionId)`, which removes
every mesh stamped with that `saveRegionId`. Store data is untouched; re-entering
the region respawns from it.

### Region attribution

A placement belongs to the region containing its world XZ, evaluated at spawn
and re-evaluated after any gizmo move or arrow-key nudge. Dragging a mesh across
a seam moves it between region files. Reuses the region lookup the commit path
already performs.

### Start fresh / switch saves

Both are one operation: clear the store, reload the currently-loaded regions,
then apply the new save (or nothing). Because bundles are permanently vanilla, a
reload yields a pristine scene — no un-hiding of instances, no saved-matrix
bookkeeping.

### Autoload

`?save=<slug>` wins; otherwise `localStorage["rsmap.lastSave"]`; `?save=none`
forces vanilla. A refresh returns you to the map you were editing.

## Migration

`edits/12850.json` holds 60 removes and 180 adds, 116 carrying sub-tile offsets
— too many to convert by hand.

A throwaway **Import legacy edits** menu item does it once:

1. Read the overlay file.
2. For each add, reconstruct the world position by inverting
   `subOffsetForTile` — bbox base plus recorded offset, with the same
   rotation-1/3 size swap; `sizeX`/`sizeY` come from `/api/object/:id`, and
   `offsetY` re-anchors on a terrain sample at the bake-base XZ.
3. Spawn each through the normal placer path and copy `removes` across.
4. The result is an ordinary unsaved map; the user names and saves it.

The converted save is committed, then the importer is deleted in the same
branch. Keeping it would mean keeping the bbox-base inverse math alive, which
is what this redesign retires.

### Removals

- `packages/extractor/edits/` and its loader
- `overlay` parameters on `prepareLocs` / `emitLocs` and the `loadEdits` call in
  `extractRegion`
- `/api/dev/commit-edits` middleware
- `packages/viewer/src/tools/pendingEdits.ts`
- `EditsOverlay` / `EditsOverlayAdd` from `shared/src/region-bundle.ts`

Bundle schema constants are unaffected — bundle output does not change, so no
`*_SCHEMA` bump is needed.

## Failure modes

| Condition | Behaviour |
|---|---|
| Save references a region that no longer extracts | Skip it, warn once in console. Rest of the save loads. |
| Entity id missing from the current cache build | Skip that placement, count them, surface one toast. |
| Bundle predates the `placementIds` blob | Removes can't apply for that region; warn once, reusing selection's existing message. |
| Dev server unreachable | Map menu disabled; in-memory scene untouched. |
| `PUT` fails | Store stays dirty, error surfaced, nothing discarded. |
| Schema version mismatch | Refuse the load with the expected/found versions. No partial apply. |

## Verification

Add `vitest` to the viewer (`pnpm test`) covering the pure logic only:

- save-file serialization round-trip (`serialize` → `load` → deep equal)
- region attribution, including a position that crosses a seam
- `placementIdHex → slot` index construction against a synthetic
  `placementIds` array

Scene behaviour stays visual: place objects and NPCs spanning a region seam,
save, reload with `?save=none` to confirm the bundle is genuinely vanilla, then
`?save=<slug>` and verify positions with the debug inspector's shift-click
copy. `pnpm typecheck` must pass for both packages.

## Out of scope

- Baking a save's objects back into bundle geometry
- Game-mode raid config (spawn, character, extraction) — `game-mode` branch
- Undo/redo
- Save-to-save diffing or merging
- Terrain edits — saves cover locs and entities only
