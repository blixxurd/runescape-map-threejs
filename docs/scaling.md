# Scaling beyond a 3×3 region grid

The viewer currently loads a `(2 * NEIGHBOR_RADIUS + 1)²` square of regions
centered on the URL's `?region=`, default radius 1 → 3×3. This document
catalogues what would have to change to render a substantially larger
neighborhood or the full Gielinor surface (~700 non-empty regions as of
build 234).

## Summary

- **3×3 (today):** works on a modern laptop, ~180 MB of bundle data, ~20 MB
  of GPU texture, tens of thousands of draw calls.
- **~25 regions (a small kingdom, e.g. all of Misthalin):** achievable with
  disk/GPU caching of atlases; no structural changes needed but a unified
  atlas becomes attractive.
- **Whole surface (~700 regions):** requires on-demand streaming, a unified
  texture atlas, extractor upgrades for inter-region blending, and LOD.
  Not a weekend project — call out the pieces below.

## What the current pipeline does per region

The extractor bakes each 64×64 map square into a self-contained bundle:

- `terrain.meta.json` + `terrain.pos.bin / .col.bin / .uv.bin / .heights.bin`
- `locs.json` + `locs.pos.bin / .col.bin / .uv.bin` (+ optional `.frames.pos.bin`)
- `atlas.json` + `atlas.png` — only the textures that this region references
- `terrain.debug.json`, `locs.debug.json`, `terrain.tri_tiles.bin` (lazy)

Region-to-region is decoupled: every bundle stands alone, vertex positions
are region-local (SW corner at 0,0). The viewer offsets each region's
`terrainGroup` / `locsGroup` by `(Δregion × REGION_SPAN, 0, -Δregion × REGION_SPAN)`
in world space.

## Known quality gaps at region seams

These are all **extractor-side** — they can't be hidden by viewer smoothing.

1. **Blended underlay colors.** `Landscape.mixLightness` runs an 11×11
   weighted blend over neighbors (`hsl.ts` → `blendUnderlayTiles`). Tiles
   within 5 tiles of a region edge see "no underlay" for any neighbor
   tile that happens to live in the next region, so the hue near the seam
   is tinted toward the blend's default. The OSRS client and rs-map-viewer
   both sidestep this by loading the 8 neighbor map squares during blend.
   Fix: take the adjacent regions' `MapDefinition.tiles[plane][x][z]` and
   reach across the boundary during `blendUnderlayTiles`.

2. **Per-vertex terrain lighting.** `computeVertexLights` derives each
   vertex normal from the 4 neighboring tile heights. Edge vertices treat
   missing neighbors as `height = 0`, producing a visible lighting step
   at region boundaries. Fix: extend `heights[plane][x][z]` with a
   one-row border from each neighbor before running `computeVertexLights`.

3. **Large-loc scene-merge pass.** See `memory/merge_normals_gap.md`.
   Adjacent large locs that straddle a region boundary are currently
   decoded independently, so their shared edge faces aren't hidden via
   `ModelData.mergeNormals`. Low-impact today; becomes common with more
   loaded regions (multi-tile buildings that straddle boundaries).

## Viewer-side gaps and their fixes

### Texture atlas per region

Each region ships its own `atlas.png` keyed by the textures that region
references. At 9 regions we allocate 9 separate GL textures. Pros:
extractor stays simple, regions are independent. Cons: 9× the upload
cost, no texture-ID coherence for debugging, and every region pays the
atlas-baking latency individually.

**What to do at scale:**

- **Static world-wide atlas.** Bake one atlas over all textures (a few
  hundred, max) and ship it once. Every region's UVs already key on a
  `cell` index, so the extractor just needs to resolve `cellByTextureId`
  against the global manifest instead of a per-region one. Atlas shrinks
  to a single ~4 MB PNG, and loading N regions costs 0 extra GL textures.

- **Atlas manifest.** Promote `atlas.json` to a world-scale file at
  `/regions/atlas.json` with the full `cellByTextureId` map; keep
  per-region `atlas.json` only for back-compat during the migration.

### Region loading strategy

`main.ts` does `Promise.allSettled` over a fixed list up front. That's
fine for 3×3. For dozens of regions or full-world:

- **LRU streaming.** Keep a visible-region set driven by camera position.
  Load regions when the camera enters a radius; unload (dispose
  geometries, drop textures) once outside a hysteresis radius. Vite's
  fetch cache + browser HTTP cache make re-entry cheap.

- **Priority queue.** When crossing a boundary, start fetching the
  newly-exposed neighbors before the camera even arrives — predictive
  prefetch based on velocity.

- **Serve as a world.** Today every bundle is under
  `public/regions/<id>/`. That's fine for thousands of tiny HTTP fetches
  on localhost but at world scale you'd want bulk manifest files
  (one JSON listing which regions exist) plus HTTP/2 or
  multi-fetch bundling to avoid the N×3–4 round-trip penalty (each
  region is 3 JSONs + 4–8 binary blobs).

### Draw calls and instancing

Each loc block becomes an `InstancedMesh` per plane, per region. Lumbridge
alone is ~2500 blocks × up to 4 planes = ~10k InstancedMesh objects. 9
regions ≈ 32k draw calls, already pushing the lower tier of laptop GPUs.

**At scale:**

- **Cross-region instance sharing.** If regions share a unified atlas and
  a unified block geometry cache (same `(locId, modelType, bakedRotation)`
  produces the same byte-identical geometry — they do today), every
  instance of the same block across the world could live in a single
  `InstancedMesh`. Memory: O(unique blocks), not O(placements × regions).
  This is the single biggest render-side win for world-scale.

- **BatchedMesh (Three.js r163+).** Groups static meshes of different
  geometries into one draw call. Would consolidate terrain plane meshes
  across regions into one call per plane. Complements cross-region
  instancing rather than replacing it.

### Z-precision across a large world

`camera.far` currently tracks the grid diagonal (`gridDiag * 2`). At
full-world extents (700 regions × 8192 units ≈ 5–6 M units edge-to-edge),
the linear depth buffer loses precision to the point that z-fighting
returns. Options in order of increasing effort:

- **Keep far tight via streaming.** If only a few regions are ever visible
  at once (LRU), `camera.far` stays in the ~50k range and nothing changes.
- **Logarithmic depth buffer.** Three supports this but it breaks our
  `polygonOffset`-based loc-vs-terrain decal fix (see `memory/z_fighting.md`).
  If we enable it we'd need an alternative decal scheme (fragment-shader
  depth bias or the 1-unit Y-lift approach already used for locs).
- **Reversed-Z.** Highest precision, biggest rewrite; probably overkill.

### Fog / horizon

`scene.fog` is currently sized to the grid diagonal. At world scale, fog
serves as the soft "edge of loaded world" mask that hides the LRU cutoff.
Its near/far should track the streaming radius, not the world.

### Debug inspector

`DebugInspector` now handles one entry per loaded region and lazy-loads
the debug bundle on first hit. At world scale this is already fine —
nothing changes except lazy unload matching the LRU above.

### Animated locs, night sky

Both are per-frame work. Animated locs scale with the number of visible
animated blocks, not regions; the tick cost is trivial even at 10× the
current count. Night sky is camera-only. Neither needs work.

## Concrete near-term wins if we keep 3×3

Stuff that would still pay off without going all the way to streaming:

1. **Unified atlas.** Biggest single win: one texture, fewer draw-call
   state changes, consistent UV debugging. ~1 day.
2. **Neighbor-aware terrain blending.** Fixes the visible seam in
   underlay colors and lighting at the 3×3 boundaries. Needs extractor
   to load the 8 neighboring map squares during terrain prep. ~1 day.
3. **Cross-region instance sharing for locs.** Needs a shared
   block-geometry cache in the viewer so the same `(locId, modelType,
   bakedRotation)` only uploads once. ~1 day.

The extractor already produces self-consistent bundles, so none of these
require a schema change — they're additive.

## Reference implementations

- `rs-map-viewer` (dennisdev) streams regions on demand and uses a
  unified atlas + cross-region instance sharing. It's the right starting
  point for any of the scale-up items above — see its `Scene` and
  `ChunkManager` for the pattern.
- The OSRS client itself streams a fixed `SceneBuilder.sceneSize = 104`
  tiles square, i.e. effectively 2×2 regions, and reloads as the player
  moves. It does cross-region blending unconditionally.
