# RuneScape Map Viewer (Three.js)

Decodes snapshots of the Old School RuneScape cache (from
[archive.openrs2.org](https://archive.openrs2.org/)) into static Three.js-ready
bundles, then renders them in a Vite + Three.js viewer in the browser.

## Architecture at a glance

```
.cache/<openrs2-id>/cache/        downloaded disk.zip + xteas.json
          │
          ▼
packages/extractor/   Node CLI — decodes one region → static bundle
          │            uses osrscachereader for cache I/O + XTEA
          ▼
packages/viewer/public/regions/<id>/
  terrain.meta.json  + terrain.pos.bin + terrain.col.bin + terrain.uv.bin
                     + terrain.heights.bin + terrain.blocked.bin
  locs.json          + locs.pos.bin    + locs.col.bin    + locs.uv.bin
                     + locs.frames.pos.bin (when any animated)
  atlas.json         + atlas.png       (shared for both)
packages/viewer/public/catalog/      (gitignored, baked by `pnpm catalogs`)
  npc.json + object.json + item.json + spotanim.json + sequence.json
          │
          ▼
packages/viewer/     Vite + Three.js app — fetches bundle, builds BufferGeometry
                     + InstancedMesh per (locId, type) block
```

Extractor runs offline (Node); viewer only reads static files. The on-disk
schema is declared once in `shared/src/region-bundle.ts` and imported by both
packages. Each artifact carries a `schemaVersion` field gated against a
single-source `*_SCHEMA` constant in that same file — the loader raises
`StaleBundleError` on mismatch, which auto-triggers a re-extract in dev
(via the `/api/extract` middleware) and throws cleanly in static deploys.
See `memory/bundle_schema_versioning.md` for the bump procedure.

## Run

```
pnpm install
pnpm extract -- --region 12850      # Lumbridge on the pinned build
pnpm extract -- --region 12850 --build 230   # override if experimenting
pnpm catalogs                       # bake static entity catalogs (NPC/object/item/spotanim/sequence)
pnpm dev                            # viewer at http://127.0.0.1:5173/?region=12850
pnpm typecheck                      # both packages
```

`.cache/` is gitignored; first extract downloads ~140 MB of cache + keys.
`packages/viewer/public/catalog/` is gitignored too — `pnpm catalogs` is
only required for static deploys (`pnpm build`); dev mode falls back to
the live `/api/<name>-catalog` endpoints.

### Cache build pin

The project is pinned to **OSRS build 234** (released 2025-10-22), set as
`DEFAULT_BUILD` in `packages/extractor/src/index.ts`. We pin because
`osrscachereader` 1.1.3 was published 2025-11-08 with its ObjectLoader opcode
table updated for that same game patch — later cache builds contain opcodes
the library doesn't know, which poison the OBJECT archive and force us to
skip tens of unique loc IDs per region. Build 234 gives us **zero** opcode
parse failures, so we should stay there until `osrscachereader` ships an
update. Upgrading: bump `DEFAULT_BUILD`, re-extract, check the final log line
for "0 parse failures".

## Coordinate convention (important)

**World:** right-handed, `+X = east`, `+Y = up`, `+Z = south` (glTF / Three.js
camera-friendly). This is **not** the OSRS client's convention — the extractor
negates both Y and Z on every vertex. Both flips together preserve handedness,
so triangle winding from the OSRS tile-shape tables carries over unchanged.

This is the only convention that gives north-at-top **and** east-on-right with
Three.js's default camera math. Trying to keep `+Z = north` and fix the camera
mirrors east/west on screen — don't go back down that path. Full reasoning in
`memory/osrs_cache_decoding.md`.

**Region extent:** X ∈ [0, 8064], Z ∈ [−8064, 0]. Region center = (4096, 0, −4096).

## Dependencies worth knowing about

- [`osrscachereader`](https://github.com/Dezinater/osrscachereader) — cache I/O,
  XTEA decrypt, definition decoding. Browser- and Node-capable.
  - It has bugs (`ObjectDefinition.getModel` reads `recolorFrom` but the loader
    writes `recolorToFind`; `ObjectLoader.handleOpcode` doesn't know build-236+
    opcodes). We monkey-patch `ObjectLoader.load` in
    `packages/extractor/src/patches/objectLoader.ts` to return empty defs on
    parse failure rather than poisoning the archive.
- `three` — Three.js r169.
- `sade`, `fflate` — CLI + zip.

## Known M1 limitations

These are intentional scope cuts, not bugs — tackle them only when promoted:

- **Plane 0 only.** Upper floors decode into `terrain.meta.json` / `locs.json`
  but the viewer hides them.
- **No overlay textures.** Overlay texture IDs are decoded but not sampled;
  textured tiles render as flat color.
- **No loc textures.** Loc faces with `faceTextures[i] != -1` render as a
  muted warm-grey fallback (`(140, 118, 95)`). Without this, they decode to
  near-white from the texture-tint HSL and glare.
- ~~**No per-loc recoloring / retexturing**~~ Fixed — we apply the
  `recolorToFind → recolorToReplace` substitution ourselves in
  `packages/extractor/src/region/locs.ts` after `getModel` returns.
- ~~**No overlay/loc textures**~~ Overlays, underlays, and loc face
  textures are all decoded into a single shared atlas PNG and sampled
  via per-vertex UVs. Loc face UVs use Gramian-inverse affine projection
  onto each model's explicit texture triangle (OSRS render-type 0).
- **~90 locIds skipped per region**, but on the pinned build 234 these are
  all legitimate "no geometry" cases, not parse failures. The extractor's
  final log line reports the breakdown: `noDef / noModel / empty / err`.
  `noModel` covers placements that ask for a loc-model-type the def doesn't
  supply (e.g. a scenery-only def placed with `type=22` floor decor);
  `empty` covers genuinely invisible locs like spawn anchors. Nothing to
  recover — these don't render in the OSRS client either.
- **Loc placement is tile-centered.** Walls (types 0–3) sit at tile centers
  rather than edges, BUT the model geometry itself is pre-offset by the model
  author so visually most walls land in the right place. Wall-type offset
  tables can be added later for exotic types.
- **Multi-model loc types handled:** type 2 (`WALL_CORNER`) renders both L
  halves, type 11 (`NORMAL_DIAGIONAL`) resolves to `modelType=10 + rot+4`.
  Rotation (including the `>3` variants with method1194/1206 baked in) is
  stored per block — instance matrices are translation-only.
- **Single region by default, grid-capable.** Viewer loads a
  `(2·NEIGHBOR_RADIUS + 1)²` square around the URL region; default
  `NEIGHBOR_RADIUS = 0` in `packages/viewer/src/main.ts` so only the URL
  region renders. Bump to 1 for a 3×3 grid — missing bundles are skipped
  with a console warning. The extractor stitches terrain across region
  seams: heights use the neighbor's (0, z) / (x, 0) corners for the east
  column / north row, and the 11×11 underlay blend runs on a 74×74 padded
  scene (center region + 5-tile border from each of the 8 neighbors), so
  heights and colors both match across adjacent bundles. Contoured-loc
  vertex sampling also reads the same padded scene heights so
  tree/fence/rock bases align at the boundary. Full world-scale
  (streaming, unified atlas): `docs/scaling.md`.
- **No water / water animation.**
- **Terrain tile `settings` byte** (render flags): only bit `0x2` (bridge)
  could plausibly matter at M1 and even that needs a plane-shifted terrain
  pass. Bits `0x4` (indoor), `0x8` (force-minLevel=0), `0x10`
  (hide-from-player-level) all feed the client's auto-roof-removal, which
  needs a player-position feature we haven't built. The raw byte is
  preserved through the debug JSON so the inspector surfaces it; see
  `reference/AUDIT.md` → *Tile* and `memory/tile_settings_byte.md` for the
  exhaustive per-bit writeup. **Bit `0x1` (gameplay-blocked)** *is* now
  extracted: 1 byte per tile in `terrain.blocked.bin`, plane-major.
  Consumers (passability overlays, pathfinding) can read it directly off
  the bundle.
- **Contoured-ground scenery follows the slope.** Trees / fences / rocks
  (`ObjectDefinition.contouredGround`, opcodes 21 & 81) get per-vertex Y
  deformation baked into a per-placement copy of the block geometry. Trunk
  bases track the terrain under each vertex; canopies of opcode-81 trees
  stay rigid above the ratio-space threshold. Details in
  `memory/osrs_cache_decoding.md`. Cost: contoured blocks can't instance, so
  each contoured placement emits its own geometry (~2× bundle size for
  Lumbridge).
- **Animation.** Scenery locs with `animationID ≥ 0` get every frame
  of their sequence baked in the extractor (`locs.frames.pos.bin`) and the
  viewer swaps `BufferGeometry.position` per render tick. Speed matches the
  client (`frameLengths[i] × 20ms`, 50Hz client-tick clock — RuneLite's
  `CLIENT_TICK_LENGTH = 20` and rs-map-viewer agree). End-of-cycle behaviour
  uses `SequenceDefinition.frameStep`: `-1`/`0` → freeze on last frame,
  `0 < frameStep < frameCount` → tail loop of size `frameStep`, `≥ frameCount`
  → full loop. Colors / UVs don't re-light per frame, only positions.
  Diagonal-wall (`bakedRotation ≥ 4`) animated locs fall back to the static
  pose. All instances of a block animate in lockstep — `randomizeAnimStart`
  (per-instance random phase) is not implemented, so neighbouring identical
  animated locs move in sync. The cache flag is now captured in the bundle
  (`LocBlockAnimation.randomizePhase`) so a future runtime split has the
  input it needs; see `memory/animation_wip.md` for the deferred plan.
- **Terrain and loc lighting are both pre-baked** into per-vertex colors
  using the OSRS client's exact algorithms (`Landscape.mixLightness` for
  terrain, `Model.applyLighting` + `method816` for locs). Both meshes
  use `MeshBasicMaterial` so Three.js doesn't double-shade. Reference
  Java sources at `/reference/` (gitignored) — see `reference/AUDIT.md`
  for the formula-by-formula comparison that drove the current
  implementation.
- **Color management is disabled** (`THREE.ColorManagement.enabled = false`)
  because OSRS colors are authored in sRGB with no gamma pass — Three's
  default sRGB-to-linear-to-sRGB pipeline would double-encode and produce
  a yellow cast. Atlas texture colorSpace is `NoColorSpace`.

## In-viewer editor

Top-right tool panel with four placement tabs (NPCs / Objects / Items / FX)
plus an Eyedropper to grab an entity id from anything in the world. Each
tab fetches a baked geometry on-demand via Vite dev middleware, ghosts a
preview at the cursor, and drops a `THREE.Mesh` on click. Animations,
contoured-ground deformation, and 45° rotation steps all carry from the
placer's behaviour. The FX tab places SpotAnims (projectiles, spell
impacts, gfx-on-NPC); cache `frameStep === -1` is force-promoted to a
full loop so the editor can show the animation continuously. See
`memory/editor_tools.md` for the full rundown.

Selection layer (no tool armed → click-to-select). Two flavours: existing
*placed* entities get the full editor; *baked* scenery locs from the cache
get a read-only inspector + Delete (which records the loc as a "remove" in
the active save, hiding it immediately).

- `OutlinePass` highlights the selected mesh in cyan. Baked-loc selections
  use a single-instance "outline ghost" so the cyan edge is on just the
  clicked instance, not every sibling in the InstancedMesh.
- `TransformControls` gizmo: `T` for translate (X/Y/Z all visible — Y
  bypasses the surface clamp so manual lifts stick; the placement's exact
  world Y then flows into the active save via `onPlacementUpdated` →
  `SaveStore.updateFromMesh`), `R` for rotate around Y. Snaps to 45°, hold
  Shift for free angle. **Listen to `objectChange`, not `change`** — see
  `memory/tc_change_vs_objectchange.md`.
- Floating inspector panel: numeric X/Z/rotation, ±45° steppers, NPC
  animation override, Delete + Duplicate.
- Keyboard: Esc deselect, Delete/Backspace remove, Cmd/Ctrl+D duplicate,
  arrow keys nudge by `TILE_SIZE` (Shift+arrow for 1-unit fine).
- Arming any placer auto-deselects.

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

**Obey-geometry ("stack") toggle.** When on, the placer + gizmo raycast
loc groups + every placer's scene group on top of terrain, so placements
rest on whatever's under the cursor. Every placement kind's stack survives
a save + reload — the save file stores each placement's exact world Y
(`SavedPlacement.y`), so NPCs/items/FX stack just as durably as objects.

## Debug inspector

Hold **Shift** while hovering the viewer (with no editor tool armed and
nothing selected) → a panel appears with the cache data for the tile / loc
under the cursor (plane, tile coords, underlay/overlay ids + textureIds, raw
RGB, blended HSL, loc type + rotation, face counts, etc). **Shift+click**
copies a compact paste-ready block to the clipboard — the preferred way to
report visual bugs.

Implementation: `packages/viewer/src/debug/inspector.ts`. Debug data lives in
`terrain.debug.json`, `terrain.tri_tiles.bin`, and `locs.debug.json`; all are
lazy-loaded on first Shift press so normal rendering has zero cost.

## Where things live

| file | purpose |
|------|---------|
| `packages/extractor/src/index.ts` | CLI entry |
| `packages/extractor/src/download.ts` | openrs2 download + unzip |
| `packages/extractor/src/region/terrain.ts` | terrain triangle-soup baking |
| `packages/extractor/src/region/locs.ts` | loc decode + model flatten |
| `packages/extractor/src/tables/tileShapes.ts` | canonical 13-shape tile subdivision |
| `packages/extractor/src/color/hsl.ts` | HSL16 ↔ RGB + neighbor blend |
| `packages/extractor/src/patches/objectLoader.ts` | library opcode-crash shim |
| `packages/viewer/src/main.ts` | Three.js scene + camera + lights |
| `packages/viewer/src/terrain/buildTerrainMesh.ts` | BufferGeometry per plane |
| `packages/viewer/src/locs/placeLocs.ts` | InstancedMesh per (locId, type) |
| `packages/viewer/src/tools/modelPlacer.ts` | NPC / Object / Item / SpotAnim placer (implements `Placer`) |
| `packages/viewer/src/tools/selection.ts` | Click-to-select, OutlinePass, TransformControls |
| `packages/viewer/src/tools/inspectorPanel.ts` | Floating draggable inspector |
| `packages/viewer/src/tools/placerTypes.ts` | `Placer` interface, `PlacedRef`, `PlacedMeshUserData` |
| `packages/viewer/src/state/varState.ts` | Phase 5 varbit/varp registry; consulted at scene-load to resolve loc morphs |
| `packages/extractor/src/entities/spotAnimModel.ts` | Phase 9 SpotAnim baker + catalog |
| `packages/extractor/scripts/reextract-all.ts` | Bulk re-extract every region (atlas-poisoning fix) |
| `shared/src/region-bundle.ts` | shared on-disk schema types + `*_SCHEMA` constants |
| `packages/viewer/src/saves/saveStore.ts` | active map save: tracking, per-region apply/detach |
| `packages/extractor/src/saves/store.ts` | save file I/O (list / read / write / delete) |
| `shared/src/save-file.ts` | shared save schema + `SAVE_SCHEMA` |
| `docs/extraction-roadmap.md` | parked phases (audio / minimap / player / music / reactive var UI) |

## Commit / release hygiene

- `packages/viewer/public/regions/` is gitignored (regenerate via `pnpm extract`).
- `packages/viewer/public/catalog/` is gitignored (regenerate via `pnpm catalogs`).
- `.cache/` is gitignored.
