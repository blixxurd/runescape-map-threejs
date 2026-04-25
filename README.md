# RuneScape Map — Three.js

> A browser-based map viewer and scene editor for Old School RuneScape.

Decodes snapshots of the OSRS cache from the
[openrs2 archive](https://archive.openrs2.org/) into static, Three.js-ready
region bundles, then renders them with a Vite + Three.js frontend. On top of
the rendered world there's an in-browser editor for arranging scenes —
placing NPCs, objects, and items, selecting and manipulating them with a 3D
gizmo, all session-only (no persistence yet).

Not affiliated with Jagex. Educational/research project that reads public
cache snapshots; OSRS cache data is © Jagex Ltd.

[Quick start](#quick-start) · [Editor controls](#editor-controls) ·
[Architecture](#architecture) · [Limitations](#limitations) ·
[Contributing](#contributing)

---

## Quick start

Requires Node 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev
# → http://127.0.0.1:5173/?region=12850   (Lumbridge)
```

On first load, the dev server downloads the pinned OSRS cache snapshot
(~140 MB into `.cache/`, gitignored) and extracts the region bundle on
demand. Subsequent loads are instant. Switch regions by changing the URL —
valid IDs are `(regionX << 8) | regionZ` with both axes in `[0, 255]`.

A few good starting points:

| Region | Place |
|---|---|
| `12850` | Lumbridge |
| `12342` | Varrock |
| `13105` | Falador |
| `9781`  | Karamja volcano |

You can also pre-extract from the command line:

```bash
pnpm extract -- --region 12342
pnpm extract -- --region 12342 --build 230   # override the pinned build
```

To bulk re-extract every region you've previously visited (e.g. after an
extractor bug fix that requires regenerating bundles):

```bash
pnpm --filter @rsmap/extractor exec tsx scripts/reextract-all.ts
```

---

## What works

### Rendering

- Full 64×64 region terrain with OSRS-accurate per-vertex baked lighting
  (port of `Landscape.mixLightness`).
- Underlay + overlay tile blending, overlay shape table, shared texture
  atlas for terrain and locs.
- Static scenery (locs): decoded models, per-face HSL and textures, recolor
  / retexture substitutions, contoured-ground deformation for fences /
  trees / rocks.
- Scenery animation: every sequence frame is baked at extract time; the
  viewer swaps `BufferGeometry.position` on a 50 Hz tick matching the
  client (`frameLengths[i] × 20ms`).
- Multi-region grid (3×3 default, scalable) with seam-consistent terrain
  blending and contoured-loc heights.
- On-demand region extraction via Vite middleware: visiting `?region=<id>`
  triggers an in-process bake if the bundle isn't on disk yet.

### Editor

The top-right tool panel covers placement; the rest is mouse-driven on the
selected entity.

| Tool | What it does |
|---|---|
| **NPCs** | Search ~12k NPCs, click to arm, click terrain to place. Idle animations auto-loop. NPC's declared animations are in a per-arm dropdown; "more animations ▾" searches the full ~12k sequence catalog. |
| **Objects** | Search ~28k baked locs (walls, scenery, doors, crates). `R` rotates in 45° steps; contoured objects follow terrain slopes; animated ones (mills, fires, banners) cycle frames. |
| **Items** | Search ~5k items; drops the inventory model on the ground at click position. |
| **Eyedropper (`I`)** | Click any baked loc in the world to grab its id and re-arm the Object tool. |
| **Free placement** | Toggle in panel head — disables tile-center snap for off-grid positioning. |

### Selection (no tool armed)

Click any placement to select it — a cyan outline highlights the mesh and
a floating inspector panel appears.

| Action | Key |
|---|---|
| Translate handle (XZ ground-plane, Y re-clamps to terrain) | `T` (default) |
| Rotate handle (Y axis, 45° snap; Shift = free angle) | `R` |
| Deselect | `Esc`, click empty terrain |
| Delete | `Delete` / `Backspace`, or Inspector → Delete |
| Duplicate at same pose | `Cmd/Ctrl+D`, or Inspector → Duplicate |
| Nudge by one tile (Shift = 1 unit) | Arrow keys |
| Edit position / rotation numerically | Inspector fields |
| Override animation (NPCs only) | Inspector dropdown |

Arming a placer auto-deselects so the gizmo and ghost preview don't fight
over the canvas.

### Debug overlay

With nothing armed and nothing selected, hold **Shift** to inspect the tile
or loc under the cursor (plane, coords, underlay/overlay ids, blended HSL,
loc type/rotation, face counts). **Shift+click** copies a paste-ready block —
the preferred way to report visual bugs.

---

## Architecture

```
.cache/<openrs2-id>/cache/        downloaded disk.zip + xteas.json
          │
          ▼
packages/extractor/   Node CLI — decodes one region → static bundle
          │            uses osrscachereader for cache I/O + XTEA
          ▼
packages/viewer/public/regions/<id>/
  terrain.meta.json  + terrain.{pos,col,uv,heights}.bin
  locs.json          + locs.{pos,col,uv}.bin    + locs.frames.pos.bin
  atlas.json         + atlas.png        (shared by terrain + locs)
          │
          ▼
packages/viewer/     Vite + Three.js app — fetches bundle, builds
                     BufferGeometry + InstancedMesh per (locId, type)
```

Extractor runs offline (Node); viewer only reads static files. The on-disk
schema is declared once in `shared/src/region-bundle.ts` and imported by
both packages.

Coordinate convention: world is right-handed `+X = east`, `+Y = up`,
`+Z = south` (Three.js camera-friendly). The extractor negates both Y and
Z on every vertex from the OSRS client's convention; both flips together
preserve handedness so triangle winding from the OSRS tile-shape tables
carries over unchanged. Region extent: X ∈ [0, 8064], Z ∈ [−8064, 0].

For the deeper architectural breakdown see [`CLAUDE.md`](CLAUDE.md). For
the plan to scale past a 3×3 grid, see [`docs/scaling.md`](docs/scaling.md).

---

## Limitations

These are intentional scope cuts, not bugs:

- **Plane 0 only.** Upper floors decode but the viewer hides them — the
  client's auto-roof-removal is not implemented.
- **No water / water animation** and most dynamic effects.
- **Per-instance animation phase not randomized** — neighbouring identical
  animated locs move in sync.
- **No streaming / LOD** for whole-world rendering.
  See [`docs/scaling.md`](docs/scaling.md) for the plan.
- **Editor is session-only** — placements don't persist across reloads.
- **Attack/emote NPC animations** live in game scripts (not the cache);
  the "more animations" search lets you try any sequence id, but
  mismatched skeletons will render oddly.

A fuller list lives in [`CLAUDE.md`](CLAUDE.md) under *Known M1
limitations*.

---

## Build a static site

`pnpm build` produces a plain static bundle in `packages/viewer/dist/`. The
static build has no extractor middleware, so every region you want to ship
must be extracted ahead of time into
`packages/viewer/public/regions/<id>/`.

---

## Repo layout

```
packages/
  extractor/   Node CLI and importable API — cache → region bundle
    scripts/   one-off ops scripts (bulk re-extract, etc.)
  viewer/      Vite + Three.js app
shared/        On-disk bundle schema (imported by both)
docs/          scaling.md, design notes
reference/     Reference OSRS client sources (gitignored)
```

Worth reading next:

- [`CLAUDE.md`](CLAUDE.md) — architectural overview and intentional scope
  cuts.
- [`docs/scaling.md`](docs/scaling.md) — plan for rendering past a 3×3
  grid.

---

## Contributing

The repo is single-author for now. If you found a visual bug, the
**Shift+click** debug-inspector copy is the fastest way to share enough
context to investigate (cache ids + raw values + blended results).

Type-check + build before committing:

```bash
pnpm typecheck
pnpm build
```

---

## License

MIT for everything in this repository. OSRS cache data is © Jagex
Ltd. — you are responsible for the terms under which you access it.
