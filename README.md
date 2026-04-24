# RuneScape Map — Three.js

A browser map viewer for Old School RuneScape. Extracts raw cache data from
the [openrs2 archive](https://archive.openrs2.org/) into static Three.js-ready
bundles, then renders them with a Vite + Three.js frontend.

Not affiliated with Jagex. This is an educational/research project that reads
public cache snapshots.

## What works

**Rendering**

- 64×64 map regions rendered as a single BufferGeometry per plane, with
  baked OSRS-accurate per-vertex lighting.
- Underlay + overlay tile blending, overlay shape table, and shared
  texture atlas for terrain + locs.
- Static scenery (locs): decoded models, per-face HSL and textures,
  recolor/retexture substitutions, contoured-ground deformation for
  fences / trees / rocks.
- Scenery animation: every sequence frame baked in the extractor, swapped
  by `BufferGeometry.position` on a 50 Hz tick matching the client.
- Multi-region grid (3×3 default, scalable) with seam-consistent
  terrain blending and contoured-loc heights.
- On-demand region extraction: visit `?region=<id>` and the dev server
  extracts the bundle in-process if it hasn't been generated yet.

**Editor tools** (top-right panel)

- **NPCs** — search ~12k NPCs, click to arm, click terrain to place.
  Animations auto-loop; pick from the NPC's declared animations or
  search the full 12k-sequence catalog ("more animations ▾").
- **Objects** — search ~28k baked locs (walls, scenery, doors, crates).
  R rotates in 45° steps (supports diagonal fences). Contoured objects
  follow terrain slopes; animated ones (mills, fires, banners) cycle
  frames.
- **Items** — search ~5k items; drops the inventory-model on the
  ground at click position.
- **Paint** — color picker + click to tint a tile.
- **Eyedropper (I)** — click any baked loc to grab its id and re-arm
  the Object tool for placing copies.
- **Free placement** toggle — disable tile-center snap for precise
  off-grid positioning.
- **Shift+click a placement** — delete it (cursor flips to a red X
  while Shift is held).
- **Debug inspector** — when nothing is armed, hold **Shift** to see
  cache data behind any tile or loc; **Shift+click** copies a
  paste-ready block.

## What doesn't (yet)

- Upper floors — decoded but hidden; the client's auto-roof-removal is
  not implemented.
- Water, water animation, and most dynamic effects.
- Per-instance animation phase (neighbouring animated locs move in
  sync).
- Streaming / LOD for whole-world rendering. See
  [`docs/scaling.md`](docs/scaling.md) for the plan.
- Editor state is session-only (not persisted across reloads).
- Attack/emote animations for NPCs live in game scripts, not the cache
  — the "more animations" search lets you try any sequence id but
  mismatched skeletons will render oddly.

A fuller list of intentional scope cuts lives in
[`CLAUDE.md`](CLAUDE.md) under "Known M1 limitations".

## Run it

Requires Node 20+ and [pnpm](https://pnpm.io/).

```bash
pnpm install
pnpm dev
# → http://127.0.0.1:5173/?region=12850   (Lumbridge)
```

On first load the dev server will download the pinned OSRS cache
snapshot (~140 MB into `.cache/`, gitignored) and extract the region
bundle. Subsequent loads are instant.

Jump to any region by changing the URL — valid region IDs are
`(regionX << 8) | regionZ`, 0 ≤ regionX, regionZ ≤ 255. A few good
starting points:

| region | place |
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

## Build a static site

`pnpm build` produces a plain static bundle in `packages/viewer/dist/`.
The static build has no extractor middleware, so every region you want
to ship must be extracted ahead of time into
`packages/viewer/public/regions/<id>/`.

## Repo layout

```
packages/
  extractor/   Node CLI and importable API — cache → region bundle
  viewer/      Vite + Three.js app
shared/        On-disk bundle schema (imported by both)
docs/          scaling.md, etc.
reference/     Reference OSRS client sources (gitignored)
```

- [`CLAUDE.md`](CLAUDE.md) — architectural overview and intentional scope cuts.
- [`docs/scaling.md`](docs/scaling.md) — plan for rendering past a 3×3 grid.

## License

MIT for everything in this repository. OSRS cache data is © Jagex
Ltd. — you are responsible for the terms under which you access it.
