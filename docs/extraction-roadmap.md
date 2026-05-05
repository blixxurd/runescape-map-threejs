# Cache extraction roadmap

The extractor currently surfaces only a fraction of what `osrscachereader`
makes available. This doc enumerates the phases we've **deferred** — what
each phase covers, what it'd cost, and what blocks it. The phases under
active work (1–5, 9) plus their cross-cutting prerequisites are tracked in
the session task list, not here.

For the field-by-field accounting that produced these phases, see the
"Cache extraction full accounting" thread in `memory/`.

---

## Phase 5b — Reactive varbit/varp UI

Phase 5 captures morph data in the bundle and resolves alternates at
scene-load time using `packages/viewer/src/state/varState.ts`. Flipping
a var at runtime via `setVar(...)` in the DevTools console requires a
page reload to re-bucket placements into the new InstancedMeshes.

**5b adds:** a floating panel listing every `(varKind, varId)` controlling
a morph in the loaded regions, with sliders / buttons to twiddle them
and an in-place scene rebuild (no reload).

**Hard part:** rebuilding affected InstancedMeshes incrementally.
Naive approach is "tear down `locsGroup` and re-call `placeLocs`" —
loses transient editor state (selections, ghosts) and is jankier than
needed. Cleaner: pre-bucket per (placementIdx → alt block options),
maintain per-instance handles, and on var change move instances between
their old and new InstancedMeshes' matrices. This requires extending
`placeLocs` to expose those handles, then a separate `applyMorphChange`
function the panel calls.

**Why deferred:** Phase 5 captured data is the heavy lift; the panel is
~2 days of UI work against a stable substrate. Ship the data first,
iterate on UI when there's a feature that exercises it (quests overlay,
"world state simulator", etc.).

---

## Phase 6 — Ambient audio

Loc-level positional sound (taverns, mills, lava, fountains).

**Source fields** (all on `ObjectDefinition`):

- `ambientSoundId` (single sound + distance)
- `ambientSoundIds[]` (multi-sound rotation)
- `ambientSoundDistance`, `ambientSoundChangeTicksMin/Max`,
  `ambientSoundRetain`
- `soundVisibility`, `soundDistanceFadeCurve`
- `soundFadeInCurve`, `soundFadeInDuration`, `soundFadeOutCurve`,
  `soundFadeOutDuration`

**Steps:**

1. Decode sound-effect index. `osrscachereader` ships
   `MusicTrackLoader` but the sound-effect path may need a patch — verify
   `getDef(IndexType.SOUNDEFFECTS)` resolves before committing.
2. Bake sound files into `packages/viewer/public/sounds/<id>.ogg`. Cache
   stores raw MIDI/sample data so a conversion step (likely via `tone.js`
   or pre-baked OGG export) is required.
3. Surface ambient-sound metadata into `LocPlacement` (or a sibling
   `locs.audio.json` to keep the geometry bundle clean).
4. Viewer: `THREE.PositionalAudio` per loc; obey distance + retain
   semantics; respect `soundVisibility` (only audible when loc is on
   screen).

**Why deferred:** large; new asset format; new runtime audio manager.
Skip until ambient audio is an explicit feature ask.

**Prerequisites:** Phase 1 (interactType lands first so audio sources can
filter to player-reachable tiles).

---

## Phase 7 — Minimap

Top-down 2D map with loc icons.

**Source fields:**

- `ObjectDefinition.mapSceneID` — minimap icon index (chest, anvil,
  fountain, etc.); already decoded in Phase 1.
- `ObjectDefinition.mapAreaId` — geographic region tag; already decoded
  in Phase 1.
- `NpcDefinition.isMinimapVisible` — whether to show NPC dot.
- `NpcDefinition.headIconArchiveIds`, `headIconSpriteIndex` — skull /
  prayer / boss icons.
- Minimap icon sprite archive (separate sprite index; `mapSceneID`
  indexes into it).

**Steps:**

1. Decode minimap icon sprites (similar pattern to texture atlas).
2. Bake per-region 2D map: top-down terrain colors + per-tile loc icons.
3. Output: `packages/viewer/public/regions/<id>/minimap.png` +
   `minimap.json` (icon positions, areaIds).
4. Viewer: HUD panel. Click-to-pan-camera. Hover shows `mapAreaId` name.

**Why deferred:** UI work, not extraction work — Phase 1 already
captures the cache-side data that drives it.

**Prerequisites:** Phase 1. Optionally Phase 4's NPC catalog if you want
NPC dots filtered by category.

---

## Phase 8 — Player / equipment rendering

Only relevant if the viewer ever places a player avatar.

**Source data:**

- `KitLoader` — body-part kit defs (hair, beard, torso, etc.). Currently
  not decoded by the extractor at all.
- `ItemDefinition.maleHeadModel`, `femaleHeadModel`, `maleOffset`,
  `femaleOffset` — equipped models for headgear.
- `SequenceDefinition.leftHandItem`, `rightHandItem` — show weapons
  during attack anims.

**Steps:**

1. New extractor module `packages/extractor/src/region/kits.ts` (or a
   global `kits.ts` since kits aren't region-scoped).
2. New entity type in the placer: "Player" with kit pickers (skin tone,
   gender, hair, etc.) + equipped-items pickers.
3. Composite-model builder that merges kit parts + equipped items into
   one renderable mesh.

**Why deferred:** large new feature; ~3–5 days of focused work; not
needed for any currently-discussed use case.

**Prerequisites:** Phase 4 (item catalog with equippable subset).

---

## Phase 10 — Music

Region-scoped background music tracks.

**Source data:**

- `MusicTrackLoader` (already shipped by `osrscachereader`).
- Per-region `mapAreaId → trackId` mapping (lives in scripts; partially
  derivable from `ObjectDefinition.mapAreaId` + a hand-maintained
  area→track table à la RuneLite's `Music` enum).

**Steps:** subsumed under Phase 6 — same audio runtime, same asset-bake
pipeline.

**Why deferred:** Phase 6 prerequisite.

---

## Always-deferred (out of scope)

The osrscachereader library does not expose these and we have no plans to
add them:

- Quests & quest scripts
- ClientScript bytecode (CS2)
- World map (the in-game minimap is a separate asset format from Phase
  7's per-region minimap)
- Interfaces / widgets
- NPC + item *spawn* data (lives in scripts, not cache; RuneLite ships
  its own JSON spawn list)

If any of these become critical, swap to a different cache library
(e.g. Jagex's `runelite-cache` Java tooling via a sidecar process, or
reimplement the relevant decoders).
