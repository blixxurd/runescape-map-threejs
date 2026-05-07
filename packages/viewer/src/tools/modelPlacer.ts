import * as THREE from "three";
import { TILE_SIZE } from "@rsmap/shared";
import type {
  PlacedMeshUserData,
  PlacedRef,
  Placer,
  PlacerKind,
} from "./placerTypes.js";

/**
 * Generic "arm → click to place" tool for any entity whose server endpoint
 * returns a `{ positions: number[], colors: number[] }` baked triangle soup.
 *
 * One instance per entity type: the NPC tool uses `/api/npc/:id`, the object
 * tool uses `/api/object/:id`. Shared mechanics:
 *   - Per-id geometry cache — repeat clicks don't re-fetch.
 *   - Keyboard `R` cycles placement rotation through 0/90/180/270°. The
 *     current rotation applies to subsequent placements; existing ones are
 *     unaffected.
 *   - Shift-click a placed mesh → delete it. (Plain click deletes nothing
 *     unless armed.)
 *   - Right-click while armed → cancel.
 *
 * Each placer owns its own `Group` under the scene root so the tool panel
 * can call `clearAll()` on one without affecting the other.
 */

export interface ModelPlacerHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** Terrain meshes the click raycast should run against. */
  getTerrainObjects: () => THREE.Object3D[];
  /** Bilinear terrain-height lookup at the given plane (default 0). Returns
   *  `null` when no loaded region covers (worldX, worldZ). Used by both
   *  the placer's pose-clamp and contoured-object deformation. */
  sampleTerrainAt: (worldX: number, worldZ: number, plane?: number) => number | null;
  /** Geometry the placer should consider stackable in obey-geometry mode:
   *  baked loc groups (per region) plus every placer's scene group, so a
   *  freshly placed cat can sit on a freshly placed box. The placer
   *  filters `:ghost`-named children at raycast time so its own preview
   *  mesh doesn't shadow the surface. */
  getGeometryObjects: () => THREE.Object3D[];
}

export interface ModelPlacerConfig {
  /** Server endpoint prefix, e.g. `/api/npc` or `/api/object`. */
  endpoint: string;
  /** Debug/scene name prefix for placed meshes. */
  meshNamePrefix: string;
  /** Logical tag put on each placed mesh's userData. */
  kind: PlacerKind;
  /** Global atlas that matches the UVs the server emits. Placed meshes
   *  sample from this as their `map`; vertex colors are tint. */
  atlasTexture: THREE.Texture;
}

interface CachedEntity {
  geometry: THREE.BufferGeometry;
  name: string;
  /** Present only on `/api/object` responses. The OSRS placement type
   *  (0..22) the bake chose for this loc. Used by the commit-edits hook
   *  so the cache add records the right type. */
  modelType?: number;
  /** Present only on `/api/object` responses. ObjectDefinition.sizeX/Y —
   *  the bbox tile footprint of the loc in cache coords (1..N). The
   *  commit-edits hook uses these to compensate for `placeLocs`'
   *  bbox-center positioning of type 10/11 placements: a 2×1 loc clicked
   *  at tile (a, b) ends up rendered at world `(a*128 + 128, _, -(b*128 +
   *  64))` post-bake, so the overlay must record an `offsetX = -64` to
   *  cancel the half-cell shift. */
  sizeX?: number;
  sizeY?: number;
  /** Present only on `/api/object` responses. `undefined` → rigid model.
   *  Defined (including 0) → apply contour-ground deformation. See
   *  `applyContourDeformation` for the two opcode variants. */
  contouredGround?: number;
  /** Original local-space positions, kept around so per-placement contour
   *  deformation can start from the rigid pose on each call. */
  basePositions: Float32Array;
  /** Tallest Y across `basePositions` — needed to compute the opcode-81
   *  ratio falloff. Cached once to avoid an O(n) scan per placement. */
  modelHeight: number;
  /** Pre-sliced per-frame position views, if the server returned an idle
   *  animation (NPCs' `standingAnimation`). Each placed mesh gets its own
   *  mutable position attribute and swaps into it via `tick()`. Undefined
   *  for static entities — no runtime cost. */
  animation?: EntityAnimation;
  /** NPC-specific. The sequence id actually baked into `animation` — lets
   *  the picker show which entry is currently active. */
  activeAnimationId?: number;
  /** NPC-specific. Menu of sequence ids the user can switch to via the
   *  armed-banner dropdown (walking, running, rotate variants). */
  availableAnimations?: Array<{ id: number; label: string }>;
}

interface EntityAnimation {
  framePositions: Float32Array[];
  frameDurationsMs: number[];
  /** Duration of one full play-through of all frames, before the loop tail
   *  kicks in. */
  introDurationMs: number;
  /** First frame in the loop tail (see `loc-bundle` schema comments for the
   *  frameStep regime table — same logic). */
  loopStartFrame: number;
  /** Sum of durations from loopStartFrame onward; 0 for one-shot freeze. */
  loopDurationMs: number;
}

interface PlacedEntity {
  mesh: THREE.Mesh;
  id: number;
  name: string;
  /** OSRS plane (0..3) the placement was committed to. Used by
   *  `updatePose` to re-sample terrain Y on the same floor; without this,
   *  dragging a plane-1 placement would snap it back to ground. */
  plane: number;
  /** The bake this placement was built from. Held so `duplicate` /
   *  `updatePose` (contour redeform) can re-run the same per-vertex math
   *  without round-tripping the network cache. */
  cached: CachedEntity;
  /** `true` when `mesh.geometry` is a per-placement clone (contoured or
   *  animated); `false` when it shares the cached bake's geometry. Drives
   *  whether removeMesh disposes the geometry — disposing a shared one
   *  would invalidate the cache for every other placement of the same id. */
  ownsGeometry: boolean;
  /** Sequence id active on this placement, if any. Mirrors `cached
   *  .activeAnimationId` at construction time but kept separately so
   *  `swapAnimation` can update it without mutating the cache. */
  animationId?: number;
  /** Animation runtime state — present iff the entity is animated. The
   *  mesh's position attribute is mutable and owned by this placement
   *  (not shared with the cache) so swapping per-tick can't affect the
   *  ghost or any other placement. */
  animation?: PlacedAnimationState;
}

interface PlacedAnimationState {
  data: EntityAnimation;
  /** performance.now() at spawn — drives a per-instance cycle clock so
   *  placements don't tick in lockstep. */
  startMs: number;
  /** Last frame index written to the position attribute; short-circuits
   *  the attribute swap + GPU upload when the frame hasn't changed. */
  lastFrameApplied: number;
}

interface BakedResponse {
  id: number;
  name: string;
  positions: number[];
  colors: number[];
  uvs: number[];
  /** Objects only — the OSRS placement type (0..22) the bake picked from
   *  the def's `objectTypes`. Walls (0..3), wall decor (4..8), normal
   *  scenery (10), floor decor (22). The commit-edits hook needs this
   *  so the re-extracted placement uses the SAME type the user saw —
   *  hardcoding 10 silently dropped fences/doors during re-bake. */
  modelType?: number;
  /** Objects only — `ObjectDefinition.sizeX/sizeY`. See `CachedEntity`. */
  sizeX?: number;
  sizeY?: number;
  /** Objects only — present means the viewer should contour this
   *  placement's vertices against terrain. */
  contouredGround?: number;
  /** NPCs only — present means the viewer should cycle through frames. */
  animation?: {
    frameCount: number;
    frameTicks: number[];
    framesPositions: number[];
    frameStep: number;
  };
  /** NPCs only — echoes back the sequence id actually baked. */
  activeAnimationId?: number;
  /** NPCs only — available alternate animations. */
  availableAnimations?: Array<{ id: number; label: string }>;
}

export class ModelPlacer implements Placer {
  readonly kind: PlacerKind;
  private readonly host: ModelPlacerHost;
  private readonly config: ModelPlacerConfig;
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  /** Separate raycaster for the down-ray that resolves Y at a snapped tile
   *  center in obey-geometry mode. Kept distinct from `raycaster` so it
   *  doesn't stomp the camera-derived state mid-mousemove. */
  private readonly surfaceRaycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  /** Key format is `${id}:${animationOverrideOrDefault}` so the same NPC
   *  can be armed with different animations and each gets its own cached
   *  geometry+frames. Objects and items only ever use the default slot. */
  private readonly cache = new Map<string, Promise<CachedEntity>>();
  private readonly material: THREE.MeshBasicMaterial;
  /** Shared material for the ghost preview. Clones the main material but
   *  kicks opacity down and disables depth writes so it doesn't pollute
   *  the real geometry's depth buffer. `alphaTest` is dropped so partly-
   *  transparent vertex-color outputs render instead of getting cut. */
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
  private readonly ghostMesh: THREE.Mesh;
  private readonly placed: PlacedEntity[] = [];

  private armedId: number | null = null;
  private armedName = "";
  private armedFetch: Promise<CachedEntity> | null = null;
  private armedEntity: CachedEntity | null = null;

  /** Dedicated geometry used when the ghost is showing a contoured
   *  placement. Rebuilt from `armedEntity.basePositions` on each mousemove
   *  so the preview matches the terrain under the current cursor — safe
   *  to mutate because no placed mesh holds a reference. */
  private ghostContourGeom: THREE.BufferGeometry | null = null;

  /** Last terrain hit recorded by `handleMove`. Cached so we can refresh
   *  the ghost preview without a fresh mouse event — used by the plane
   *  shortcuts (`,` / `.`) so the ghost lifts to the new floor instantly
   *  instead of waiting for the next mousemove. */
  private lastTerrainHit: { x: number; y: number; z: number } | null = null;

  /** 0-7 eighth-turns around world +Y (45° increments). R cycles forward,
   *  Shift+R cycles backward. Eighth-turns let users place fences/walls
   *  diagonally across a tile — OSRS caches only do quarter-turns, but
   *  the viewer isn't bound by that convention. */
  private placementRotation = 0;

  /** When `true`, drop the tile-center snap and place at the exact raycast
   *  hit. Lets users tuck props between tiles (flower pots hugging a wall,
   *  rocks in corners, etc.) at the cost of breaking the "looks like it's
   *  part of the map" guarantee. Off by default — tile snap is what users
   *  expect in an OSRS editor. */
  private snapToTile = true;

  /** When `true`, the cursor + placement-Y resolution test loc geometry +
   *  every placer's scene meshes alongside terrain. Lets users stack a
   *  cat on a box on a table. Off by default so the simple "drop on the
   *  ground" path stays fast and predictable. NPCs/items/spotanims live
   *  in scene memory only, so stacking these is purely cosmetic; objects
   *  CAN be stacked too but the on-disk overlay schema doesn't carry a Y
   *  offset yet (see `EditsOverlayAdd`), so committed stacked objects
   *  snap back to terrain on re-bake. */
  private obeyGeometry = false;

  /** OSRS plane (0..3) the next placement will be committed to. Adjusted
   *  with `,` (down) and `.` (up) while the placer is armed. The ghost
   *  preview lifts to the chosen plane's terrain Y immediately so the user
   *  sees what they'll get on commit. Reset to 0 on cancel. */
  private placementPlane = 0;

  /** Mirrors the physical Shift key. When held AND a placer is armed we
   *  hide the ghost and flip the cursor to a delete indicator — the same
   *  Shift+click already deletes a hovered placement, so this just makes
   *  the intent obvious. Tracked on `window` because focus can be anywhere
   *  (search input, panel button) when the user starts holding. */
  private shiftHeld = false;

  onPlacementsChanged: ((count: number) => void) | null = null;
  onRotationChanged: ((rot: number) => void) | null = null;
  /** Fired after a placement is removed (shift-click delete or
   *  selection's Delete key). Selection listens so it can clear stale
   *  state if the removed mesh was the current selection. */
  onMeshRemoved: ((mesh: THREE.Mesh) => void) | null = null;
  /** Fired when a new placement spawns from a click or duplicate. Used by
   *  the commit-edits hook to register the spawn in `PendingEdits`.
   *  `modelType` is the OSRS placement type (0..22) the bake chose for
   *  this loc — wall (0..3), wall decor (4..8), normal scenery (10),
   *  floor decor (22). NPCs/items/spotanims pass `undefined`.
   *  `sizeX`/`sizeY` are `ObjectDefinition.sizeX/sizeY` (1..N tile
   *  footprint), needed by the commit-edits hook to compensate for
   *  bbox-center positioning of multi-tile type-10/11 locs. Undefined
   *  for non-objects. `plane` is the OSRS plane (0..3) at which to commit
   *  the placement. */
  onPlacementSpawned:
    | ((
        mesh: THREE.Mesh,
        id: number,
        name: string,
        modelType: number | undefined,
        sizeX: number | undefined,
        sizeY: number | undefined,
        plane: number,
      ) => void)
    | null = null;
  /** Fired when the user changes the placement plane (`,` / `.` shortcuts).
   *  Tool panel listens so the armed banner can show "plane N". */
  onPlacementPlaneChanged: ((plane: number) => void) | null = null;
  /** Fired when an existing placement's pose changes (gizmo drag, numeric
   *  input, arrow nudge). Lets the commit-edits hook update the matching
   *  `EditsOverlayAdd`. */
  onPlacementUpdated: ((mesh: THREE.Mesh) => void) | null = null;
  /** Fires once per successful `arm()` with whatever animation metadata
   *  the server returned (NPC-only today). Lets the panel show a picker
   *  of available sequences without the placer knowing about the DOM. */
  onArmedAnimationInfo:
    | ((info: {
        id: number;
        activeAnimationId?: number;
        available: Array<{ id: number; label: string }>;
      }) => void)
    | null = null;

  constructor(host: ModelPlacerHost, config: ModelPlacerConfig) {
    this.host = host;
    this.config = config;
    this.kind = config.kind;
    this.group.name = config.meshNamePrefix;
    this.group.userData.role = config.kind;
    host.scene.add(this.group);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      alphaTest: 0.01,
      side: THREE.DoubleSide,
      map: config.atlasTexture,
    });

    this.ghostMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
      map: config.atlasTexture,
    });
    this.ghostMesh = new THREE.Mesh(undefined, this.ghostMaterial);
    this.ghostMesh.visible = false;
    this.ghostMesh.name = `${config.meshNamePrefix}:ghost`;
    // Draw the ghost after terrain + locs so it appears on top even when
    // a corner of the model intersects nearby scenery. `renderOrder = 1`
    // combined with `depthWrite: false` gives a clean "hovering preview".
    this.ghostMesh.renderOrder = 1;
    this.group.add(this.ghostMesh);

    host.canvas.addEventListener("click", (e) => void this.handleClick(e));
    host.canvas.addEventListener("contextmenu", (e) => this.handleRightClick(e));
    host.canvas.addEventListener("mousemove", (e) => this.handleMove(e));
    host.canvas.addEventListener("mouseleave", () => this.hideGhost());
    window.addEventListener("keydown", (e) => {
      this.handleKey(e);
      this.handleShift(e, true);
    });
    window.addEventListener("keyup", (e) => this.handleShift(e, false));
    window.addEventListener("blur", () => {
      // Release shift state if focus leaves the window — otherwise a
      // shift-drag that ends off-window can leave the placer stuck in
      // delete-cursor mode.
      if (this.shiftHeld) {
        this.shiftHeld = false;
        this.refreshArmedCursor();
      }
    });
  }

  arm(id: number, name: string, animationOverride?: number): void {
    this.armedId = id;
    this.armedName = name;
    this.refreshArmedCursor();
    this.hideGhost();
    // Clear the previous arm's cached entity + contour-ghost geometry.
    // Without this, two failure modes:
    //   (1) `handleMove` runs with the OLD entity while the new fetch is
    //       in flight, briefly previewing the wrong loc.
    //   (2) Switching between two contoured locs short-circuits the
    //       `if (!this.ghostContourGeom)` check, so the new entity gets
    //       its positions deformed into the OLD entity's clone — colors
    //       and UVs stay stale.
    this.armedEntity = null;
    if (this.ghostContourGeom) {
      this.ghostContourGeom.dispose();
      this.ghostContourGeom = null;
    }
    const fetchPromise = this.getOrFetch(id, animationOverride);
    this.armedFetch = fetchPromise;
    // Attach the geometry to the ghost as soon as it resolves, provided the
    // user hasn't re-armed something else in the meantime.
    fetchPromise
      .then((entity) => {
        if (this.armedFetch !== fetchPromise) return;
        this.armedEntity = entity;
        // Non-contoured meshes share the cached geometry; contoured
        // meshes use the ghost-contour geometry initialised by handleMove.
        if (entity.contouredGround === undefined) {
          this.ghostMesh.geometry = entity.geometry;
        }
        if (entity.availableAnimations && entity.availableAnimations.length > 0) {
          this.onArmedAnimationInfo?.({
            id,
            activeAnimationId: entity.activeAnimationId,
            available: entity.availableAnimations,
          });
        }
      })
      .catch(() => {
        // Swallowed — the click handler surfaces the same rejection with
        // a console.warn + cancel(). No need to double-log here.
      });
  }

  cancel(): void {
    if (this.armedId === null) return;
    this.armedId = null;
    this.armedName = "";
    this.armedFetch = null;
    this.armedEntity = null;
    this.refreshArmedCursor();
    this.hideGhost();
  }

  isArmed(): boolean {
    return this.armedId !== null;
  }

  getRotation(): number {
    return this.placementRotation;
  }

  /** Scene group that holds every placed mesh for this placer. Exposed so
   *  cross-tool features (eyedropper, bulk export) can raycast against
   *  placements without reaching into private state. */
  getSceneGroup(): THREE.Group {
    return this.group;
  }

  /** Toggle the tile-center snap. `true` (default) snaps X/Z to tile
   *  centers; `false` uses the exact raycast hit for free-form placement. */
  setSnapToTile(enabled: boolean): void {
    this.snapToTile = enabled;
  }

  /** Toggle obey-geometry. When `true`, cursor raycasts and the snapped-Y
   *  resolver also test loc + placer geometry, so placements rest on top
   *  of whatever they're hovering over (a cat lands on a placed box, a
   *  torch lands on a fence top, etc.). Default `false`. */
  setObeyGeometry(enabled: boolean): void {
    this.obeyGeometry = enabled;
    this.refreshGhostFromLastHit();
  }

  /** Read-only — the plane the next placement will commit to. */
  getPlacementPlane(): number {
    return this.placementPlane;
  }

  /** Set the active placement plane (0..3). Out-of-range values clamp.
   *  Fires `onPlacementPlaneChanged` so the panel banner can refresh.
   *  Refreshes the ghost preview from the cached last cursor hit so the
   *  user doesn't have to wiggle the mouse to see the new floor. */
  setPlacementPlane(plane: number): void {
    const clamped = Math.max(0, Math.min(3, plane | 0));
    if (clamped === this.placementPlane) return;
    this.placementPlane = clamped;
    this.onPlacementPlaneChanged?.(clamped);
    this.refreshGhostFromLastHit();
  }

  /** Re-run the ghost positioning logic against the cached last cursor
   *  position. Used by plane-shift (no fresh mouse event) and any other
   *  state change that should immediately reflect in the preview. */
  private refreshGhostFromLastHit(): void {
    if (!this.armedEntity || !this.lastTerrainHit) return;
    if (this.shiftHeld) return;
    const point = new THREE.Vector3(
      this.lastTerrainHit.x,
      this.lastTerrainHit.y,
      this.lastTerrainHit.z,
    );
    const pose = this.resolvePose(point);
    if (this.armedEntity.contouredGround !== undefined) {
      if (!this.ghostContourGeom) {
        this.ghostContourGeom = this.armedEntity.geometry.clone();
        this.ghostMesh.geometry = this.ghostContourGeom;
      }
      applyContourDeformation(
        this.armedEntity.basePositions,
        this.ghostContourGeom.attributes.position as THREE.BufferAttribute,
        this.armedEntity.modelHeight,
        this.armedEntity.contouredGround,
        pose,
        this.host.sampleTerrainAt,
      );
    }
    this.ghostMesh.position.copy(pose.position);
    this.ghostMesh.rotation.y = pose.rotationRad;
    this.ghostMesh.visible = true;
  }

  clearAll(): void {
    const removed = this.placed.slice();
    for (const p of this.placed) {
      this.group.remove(p.mesh);
      if (p.ownsGeometry) (p.mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.placed.length = 0;
    this.onPlacementsChanged?.(0);
    if (this.onMeshRemoved) for (const p of removed) this.onMeshRemoved(p.mesh);
  }

  /** Selection-facing snapshot of every placement. Returns plain refs so
   *  callers don't accidentally mutate internal state. */
  getPlacements(): PlacedRef[] {
    return this.placed.map((p) => ({
      mesh: p.mesh,
      kind: this.kind,
      id: p.id,
      name: p.name,
      animationId: p.animationId,
      availableAnimations: p.cached.availableAnimations,
    }));
  }

  /** Move + rotate a placement. Y is re-clamped to the terrain at the new
   *  XZ when terrain is loaded under that point — placements always sit on
   *  the ground, matching how they were originally placed. Contoured
   *  placements re-run their slope deformation against the new pose.
   *
   *  `preserveY = true` skips the resample and writes `position.y` through
   *  unchanged. Used when the gizmo's Y handle is the active drag axis so
   *  the user's manual lift translates into a non-zero `offsetY` on the
   *  pending edit instead of fighting the surface clamp. */
  updatePose(
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    rotationRad: number,
    preserveY = false,
  ): void {
    const placement = this.placed.find((p) => p.mesh === mesh);
    if (!placement) return;
    let finalY: number;
    if (preserveY) {
      finalY = position.y;
    } else {
      const sampledY = this.obeyGeometry
        ? this.surfaceYAt(position.x, position.z)
        : this.host.sampleTerrainAt(position.x, position.z, placement.plane);
      finalY = sampledY ?? position.y;
    }
    mesh.position.set(position.x, finalY, position.z);
    mesh.rotation.y = rotationRad;
    if (placement.cached.contouredGround !== undefined) {
      // Re-deform against the new world position. We need the placement's
      // OWN geometry (must be a clone, since contoured placements always
      // own their geometry).
      const geom = mesh.geometry as THREE.BufferGeometry;
      applyContourDeformation(
        placement.cached.basePositions,
        geom.attributes.position as THREE.BufferAttribute,
        placement.cached.modelHeight,
        placement.cached.contouredGround,
        { position: mesh.position, rotationRad },
        this.host.sampleTerrainAt,
      );
    }
    this.onPlacementUpdated?.(mesh);
  }

  /** Remove a placement by mesh reference. Used both by shift-click delete
   *  and by selection's Delete-key path. */
  removeMesh(mesh: THREE.Mesh): void {
    const idx = this.placed.findIndex((p) => p.mesh === mesh);
    if (idx < 0) return;
    const placement = this.placed[idx]!;
    this.group.remove(mesh);
    if (placement.ownsGeometry) {
      (mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.placed.splice(idx, 1);
    this.onPlacementsChanged?.(this.placed.length);
    this.onMeshRemoved?.(mesh);
  }

  /** Clone a placement at the same pose, animation, and bake. Used by the
   *  selection inspector's Duplicate button (Cmd/Ctrl+D). */
  duplicate(mesh: THREE.Mesh): void {
    const src = this.placed.find((p) => p.mesh === mesh);
    if (!src) return;
    this.spawnPlacement(src.id, src.name, src.cached, {
      position: mesh.position.clone(),
      rotationRad: mesh.rotation.y,
    });
  }

  /** Swap the animation on an existing placement. Re-fetches via the bake
   *  cache (keyed per `(id, animationId)` so each variant is built once),
   *  rebuilds the placement's geometry around the new frames, and resets
   *  the per-placement animation clock so it starts at frame 0. */
  async swapAnimation(mesh: THREE.Mesh, animationId: number): Promise<void> {
    const placement = this.placed.find((p) => p.mesh === mesh);
    if (!placement) return;
    const newCached = await this.getOrFetch(placement.id, animationId);
    // Bail if the placement was removed while the fetch was in flight.
    if (!this.placed.includes(placement)) return;
    const pose = {
      position: mesh.position.clone(),
      rotationRad: mesh.rotation.y,
    };
    const { geom, owns } = this.buildGeometryFor(newCached, pose);
    const oldGeom = mesh.geometry as THREE.BufferGeometry;
    mesh.geometry = geom;
    if (placement.ownsGeometry) oldGeom.dispose();
    placement.cached = newCached;
    placement.ownsGeometry = owns;
    placement.animationId = newCached.activeAnimationId;
    if (newCached.animation) {
      placement.animation = {
        data: newCached.animation,
        startMs: performance.now(),
        lastFrameApplied: -1,
      };
    } else {
      delete placement.animation;
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.isArmed()) return;
    // Skip when a form field has focus — the search input lives on top of
    // the canvas and we don't want to cycle rotation on every "r" keystroke
    // the user types in a search query.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "r" || e.key === "R") {
      const step = e.shiftKey ? 7 : 1; // Shift+R = rotate the other way (+7 ≡ -1 mod 8).
      this.placementRotation = (this.placementRotation + step) & 7;
      // Keep the ghost oriented to match the pending placement rotation.
      this.ghostMesh.rotation.y = (this.placementRotation * Math.PI) / 4;
      this.onRotationChanged?.(this.placementRotation);
      return;
    }
    if (e.key === ",") {
      this.setPlacementPlane(this.placementPlane - 1);
      return;
    }
    if (e.key === ".") {
      this.setPlacementPlane(this.placementPlane + 1);
      return;
    }
  }

  private handleShift(e: KeyboardEvent, down: boolean): void {
    if (e.key !== "Shift") return;
    if (this.shiftHeld === down) return;
    this.shiftHeld = down;
    this.refreshArmedCursor();
    if (down) {
      // Ghost immediately goes away so it doesn't occlude whatever is
      // about to be clicked away. `handleMove` will bring it back on the
      // first mousemove after Shift releases.
      this.hideGhost();
    }
  }

  /** Apply the delete cursor when armed + shift held, else the plain
   *  crosshair armed cursor, else clear. Idempotent — safe to call
   *  whenever any of those states changes. */
  private refreshArmedCursor(): void {
    const canvas = this.host.canvas;
    if (!this.isArmed()) {
      canvas.style.cursor = "";
      return;
    }
    canvas.style.cursor = this.shiftHeld ? DELETE_CURSOR : "crosshair";
  }

  private handleMove(e: MouseEvent): void {
    if (!this.isArmed()) {
      this.hideGhost();
      return;
    }
    if (this.shiftHeld) {
      // Suppress the preview while the user is aiming at something to
      // delete — the cursor X is enough of an indicator.
      this.hideGhost();
      return;
    }
    const entity = this.armedEntity;
    if (!entity) return; // fetch still pending
    const hit = this.raycastSurface(e);
    if (!hit) {
      this.hideGhost();
      return;
    }
    // Cache the hit so plane shortcuts can refresh the ghost without a
    // fresh mouse event. Stored as a plain object — keeping a Vector3
    // would risk holding a stale reference to the raycaster's pool.
    this.lastTerrainHit = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    const pose = this.resolvePose(hit.point);
    if (entity.contouredGround !== undefined) {
      // Rebuild the ghost geometry every move — cheap (a few hundred
      // vertices) and keeps the preview honest on sloped terrain.
      if (!this.ghostContourGeom) {
        this.ghostContourGeom = entity.geometry.clone();
        this.ghostMesh.geometry = this.ghostContourGeom;
      }
      applyContourDeformation(
        entity.basePositions,
        this.ghostContourGeom.attributes.position as THREE.BufferAttribute,
        entity.modelHeight,
        entity.contouredGround,
        pose,
        this.host.sampleTerrainAt,
      );
    }
    this.ghostMesh.position.copy(pose.position);
    this.ghostMesh.rotation.y = pose.rotationRad;
    this.ghostMesh.visible = true;
  }

  private hideGhost(): void {
    this.ghostMesh.visible = false;
  }

  /** Placement pose for the armed entity at a raycast hit. Tile-center
   *  snap on XZ, user-controlled `placementRotation` (eighth-turns)
   *  converted to radians here so callers don't repeat the math. Y is
   *  re-sampled at the active `placementPlane`'s terrain so the ghost
   *  (and the eventual placement) sit on the chosen floor — clicking
   *  ground while the placer is set to plane 1 lifts the ghost up to
   *  the second-floor terrain at that XZ. */
  private resolvePose(worldPoint: THREE.Vector3): {
    position: THREE.Vector3;
    rotationRad: number;
  } {
    // Free placement uses the raw hit (clone it so callers can't mutate
    // the raycaster's internal Vector3); tile snap drops to the centre of
    // whatever tile the hit falls inside.
    const position = this.snapToTile
      ? snapToTileCenter(worldPoint)
      : worldPoint.clone();
    if (this.obeyGeometry) {
      // Free + obey: the cursor's hit Y is already the right surface at
      // (position.x, position.z) since XZ wasn't moved. Snap + obey:
      // the snap shifted XZ, so re-resolve via a downward ray at the new
      // location (the cursor might have been at the corner of a box, but
      // the tile center sits on bare floor or on a different stack).
      if (this.snapToTile) {
        const y = this.surfaceYAt(position.x, position.z);
        if (y !== null) position.y = y;
      }
    } else {
      const planeY = this.host.sampleTerrainAt(position.x, position.z, this.placementPlane);
      if (planeY !== null) position.y = planeY;
    }
    return { position, rotationRad: (this.placementRotation * Math.PI) / 4 };
  }

  private handleRightClick(e: MouseEvent): void {
    if (!this.isArmed()) return;
    e.preventDefault();
    this.cancel();
  }

  private async handleClick(e: MouseEvent): Promise<void> {
    // Shift+click deletes first — before asking whether we're armed — so
    // users can remove a placed entity without cycling tools.
    if (e.shiftKey) {
      this.deleteAt(e);
      return;
    }

    if (!this.isArmed()) return;
    const hit = this.raycastSurface(e);
    if (!hit) return;

    const armedIdSnapshot = this.armedId!;
    const armedNameSnapshot = this.armedName;
    const fetchPromise = this.armedFetch;
    if (!fetchPromise) return;

    let baked: CachedEntity;
    try {
      baked = await fetchPromise;
    } catch (err) {
      console.warn(`[${this.config.kind}] ${armedIdSnapshot} failed to load:`, err);
      this.cancel();
      return;
    }

    // Re-arm / cancel while awaiting → bail quietly.
    if (this.armedId !== armedIdSnapshot) return;

    // Same resolver as the ghost so the real placement matches the preview.
    // Pulls either user-rotation (default objects) or edge-snap (walls).
    const pose = this.resolvePose(hit.point);
    this.spawnPlacement(armedIdSnapshot, armedNameSnapshot, baked, pose);
  }

  /**
   * Build a per-placement geometry from a bake at the given pose. Returns
   * the geometry plus an `owns` flag — `true` means the geometry is a
   * fresh per-placement clone (contoured / animated) and the placement
   * must dispose it on removal; `false` means it shares the cached bake's
   * geometry (rigid static), and disposing would invalidate the cache for
   * every other placement of the same id.
   */
  private buildGeometryFor(
    baked: CachedEntity,
    pose: { position: THREE.Vector3; rotationRad: number },
  ): { geom: THREE.BufferGeometry; owns: boolean } {
    if (baked.contouredGround !== undefined) {
      const geom = baked.geometry.clone();
      applyContourDeformation(
        baked.basePositions,
        geom.attributes.position as THREE.BufferAttribute,
        baked.modelHeight,
        baked.contouredGround,
        pose,
        this.host.sampleTerrainAt,
      );
      return { geom, owns: true };
    }
    if (baked.animation) {
      // Share color + uv with the cached geometry (they don't change
      // across frames); only `position` needs a writable copy.
      const geom = new THREE.BufferGeometry();
      const mutablePositions = new Float32Array(baked.basePositions.length);
      mutablePositions.set(baked.animation.framePositions[0]!);
      geom.setAttribute("position", new THREE.BufferAttribute(mutablePositions, 3));
      const srcColor = baked.geometry.getAttribute("color") as THREE.BufferAttribute;
      const srcUv = baked.geometry.getAttribute("uv") as THREE.BufferAttribute;
      geom.setAttribute("color", srcColor);
      geom.setAttribute("uv", srcUv);
      geom.boundingSphere = baked.geometry.boundingSphere;
      return { geom, owns: true };
    }
    return { geom: baked.geometry, owns: false };
  }

  /**
   * Common path for `handleClick` and `duplicate`: take a resolved bake +
   * pose, build the mesh, register the placement, fire the change callback.
   */
  private spawnPlacement(
    id: number,
    name: string,
    baked: CachedEntity,
    pose: { position: THREE.Vector3; rotationRad: number },
  ): PlacedEntity {
    const { geom, owns } = this.buildGeometryFor(baked, pose);
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.position.copy(pose.position);
    mesh.rotation.y = pose.rotationRad;
    mesh.name = `${this.config.meshNamePrefix}:${id}`;
    const userData: PlacedMeshUserData = {
      kind: this.config.kind,
      id,
      name,
    };
    mesh.userData = userData;
    this.group.add(mesh);
    const placement: PlacedEntity = {
      mesh,
      id,
      name,
      plane: this.placementPlane,
      cached: baked,
      ownsGeometry: owns,
      animationId: baked.activeAnimationId,
    };
    if (baked.animation) {
      placement.animation = {
        data: baked.animation,
        startMs: performance.now(),
        // -1 forces a first-tick apply even when the frame happens to be
        // 0 — defensive against a stale initial buffer.
        lastFrameApplied: -1,
      };
    }
    this.placed.push(placement);
    this.onPlacementsChanged?.(this.placed.length);
    this.onPlacementSpawned?.(
      mesh,
      id,
      name,
      baked.modelType,
      baked.sizeX,
      baked.sizeY,
      this.placementPlane,
    );
    return placement;
  }

  /**
   * Advance every animated placement's position attribute to the frame
   * that should be showing at `nowMs`. Static placements are skipped. Same
   * frame-math as `tickLocAnimations` in `placeLocs.ts` — if you change
   * one, update the other.
   */
  tick(nowMs: number): void {
    for (const p of this.placed) {
      const state = p.animation;
      if (!state) continue;
      const elapsed = nowMs - state.startMs;
      const { data } = state;
      let frame: number;
      if (elapsed < data.introDurationMs) {
        let acc = 0;
        frame = data.frameDurationsMs.length - 1;
        for (let i = 0; i < data.frameDurationsMs.length; i++) {
          acc += data.frameDurationsMs[i]!;
          if (elapsed < acc) {
            frame = i;
            break;
          }
        }
      } else if (data.loopDurationMs === 0) {
        frame = data.frameDurationsMs.length - 1;
      } else {
        const loopMs = (elapsed - data.introDurationMs) % data.loopDurationMs;
        let acc = 0;
        frame = data.frameDurationsMs.length - 1;
        for (let i = data.loopStartFrame; i < data.frameDurationsMs.length; i++) {
          acc += data.frameDurationsMs[i]!;
          if (loopMs < acc) {
            frame = i;
            break;
          }
        }
      }
      if (frame === state.lastFrameApplied) continue;
      state.lastFrameApplied = frame;
      const posAttr = p.mesh.geometry.attributes.position as THREE.BufferAttribute;
      (posAttr.array as Float32Array).set(data.framePositions[frame]!);
      posAttr.needsUpdate = true;
    }
  }

  private deleteAt(e: MouseEvent): void {
    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    // Raycast against the placed meshes only — skipping the ghost, which
    // lives in the same group but isn't deletable (and would shadow a
    // valid delete target when hovered).
    const hits = this.raycaster.intersectObjects(
      this.placed.map((p) => p.mesh),
      false,
    );
    if (hits.length === 0) return;
    this.removeMesh(hits[0]!.object as THREE.Mesh);
  }

  /** Raycast at the cursor. Always tests terrain; in obey-geometry mode
   *  also tests loc + placer geometry, returning the first non-ghost hit.
   *  Skipping `:ghost`-named meshes keeps the placer's own preview from
   *  shadowing the surface during armed-mode mousemove. */
  private raycastSurface(e: MouseEvent): THREE.Intersection | null {
    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    const targets: THREE.Object3D[] = [...this.host.getTerrainObjects()];
    if (this.obeyGeometry) targets.push(...this.host.getGeometryObjects());
    const hits = this.raycaster.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.object.name && h.object.name.endsWith(":ghost")) continue;
      return h;
    }
    return null;
  }

  /** Top-of-stack Y at world (x, z) for obey-geometry mode. Shoots a
   *  downward ray from very high up against terrain + geometry, ignoring
   *  the placer's own ghost. Falls back to `sampleTerrainAt` if nothing
   *  is hit (e.g. (x, z) outside the loaded region grid, or a degenerate
   *  geometry mesh). Off-mode callers should keep using `sampleTerrainAt`
   *  directly — this method's overhead is wasted for plain ground placements. */
  private surfaceYAt(x: number, z: number): number | null {
    this.surfaceRaycaster.set(
      new THREE.Vector3(x, 1e6, z),
      new THREE.Vector3(0, -1, 0),
    );
    const targets: THREE.Object3D[] = [
      ...this.host.getTerrainObjects(),
      ...this.host.getGeometryObjects(),
    ];
    const hits = this.surfaceRaycaster.intersectObjects(targets, true);
    for (const h of hits) {
      if (h.object.name && h.object.name.endsWith(":ghost")) continue;
      return h.point.y;
    }
    return this.host.sampleTerrainAt(x, z, this.placementPlane);
  }

  private updateNdc(e: MouseEvent): void {
    const rect = this.host.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }

  private getOrFetch(id: number, animationOverride?: number): Promise<CachedEntity> {
    const cacheKey = `${id}:${animationOverride ?? "d"}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const url =
      animationOverride !== undefined
        ? `${this.config.endpoint}/${id}?anim=${animationOverride}`
        : `${this.config.endpoint}/${id}`;
    const job = (async (): Promise<CachedEntity> => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          `${this.config.kind} ${id} (${r.status}): ${body.error ?? "unknown"}`,
        );
      }
      const body = (await r.json()) as BakedResponse;
      const geom = new THREE.BufferGeometry();
      const positions = new Float32Array(body.positions);
      const colors = new Uint8Array(body.colors);
      const uvs = new Float32Array(body.uvs);
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
      geom.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geom.computeBoundingSphere();
      let modelHeight = 0;
      for (let i = 1; i < positions.length; i += 3) {
        if (positions[i]! > modelHeight) modelHeight = positions[i]!;
      }
      // Pre-slice animation frames + precompute loop math. Most entities
      // don't animate; we skip all of this unless the server opted in.
      let animation: EntityAnimation | undefined;
      if (body.animation && body.animation.frameCount >= 2) {
        const a = body.animation;
        const perFrameFloats = positions.length;
        const framesArr = new Float32Array(a.framesPositions);
        const framePositions: Float32Array[] = [];
        for (let f = 0; f < a.frameCount; f++) {
          framePositions.push(
            framesArr.subarray(f * perFrameFloats, (f + 1) * perFrameFloats),
          );
        }
        const frameDurationsMs = a.frameTicks.map((t) => Math.max(1, t) * 20);
        const introDurationMs = frameDurationsMs.reduce((acc, v) => acc + v, 0);
        let loopStartFrame: number;
        let loopDurationMs: number;
        if (a.frameStep <= 0) {
          loopStartFrame = a.frameCount;
          loopDurationMs = 0;
        } else if (a.frameStep >= a.frameCount) {
          loopStartFrame = 0;
          loopDurationMs = introDurationMs;
        } else {
          loopStartFrame = a.frameCount - a.frameStep;
          loopDurationMs = 0;
          for (let f = loopStartFrame; f < a.frameCount; f++) {
            loopDurationMs += frameDurationsMs[f]!;
          }
        }
        animation = {
          framePositions,
          frameDurationsMs,
          introDurationMs,
          loopStartFrame,
          loopDurationMs,
        };
      }
      return {
        geometry: geom,
        name: body.name,
        modelType: body.modelType,
        sizeX: body.sizeX,
        sizeY: body.sizeY,
        contouredGround: body.contouredGround,
        basePositions: positions,
        modelHeight,
        animation,
        activeAnimationId: body.activeAnimationId,
        availableAnimations: body.availableAnimations,
      };
    })();
    job.catch(() => this.cache.delete(cacheKey));
    this.cache.set(cacheKey, job);
    return job;
  }
}

/**
 * Port of the extractor's contoured-loc Y deformation (`deformContouredModel`
 * in `region/locs.ts`). Runs on placement to make fences/trees/rocks hug
 * the terrain under each vertex instead of standing rigid on a flat pose.
 *
 * Two variants, selected by `contouredThreshold`:
 *   - `0` (opcode 21) — every vertex gets the full `terrain_y_here −
 *     terrain_y_at_origin` delta. Used by fences, small shrubs.
 *   - `> 0` (opcode 81) — linear falloff in "ratio space": vertices near
 *     the base get the full delta, vertices above the threshold stay
 *     rigid. Used by trees so the canopy doesn't warp.
 *
 * `basePositions` is the rigid pose (in local model space); we write the
 * deformed result into `outAttr`'s backing array and flag it for upload.
 * The mesh's own `position.y` + `rotation.y` are already set by the
 * caller — we only need the terrain sample under each vertex's WORLD xz.
 */
function applyContourDeformation(
  basePositions: Float32Array,
  outAttr: THREE.BufferAttribute,
  modelHeight: number,
  contouredThreshold: number,
  pose: { position: THREE.Vector3; rotationRad: number },
  sample: (worldX: number, worldZ: number) => number | null,
): void {
  const out = outAttr.array as Float32Array;
  const cos = Math.cos(pose.rotationRad);
  const sin = Math.sin(pose.rotationRad);
  const baseTerrain = pose.position.y;
  // Opcode 81 uses `yRatio = vy / modelHeight` (0 at the base, 1 at the
  // tallest vertex). The threshold, stored as `byte × 256`, is compared
  // against that ratio scaled to 0..65536 — mirror the extractor port.
  const thresholdRatio = contouredThreshold / 65536;
  for (let i = 0; i < basePositions.length; i += 3) {
    const lx = basePositions[i]!;
    const ly = basePositions[i + 1]!;
    const lz = basePositions[i + 2]!;
    // Apply the placement rotation to the local XZ so the terrain sample
    // is taken where the vertex will actually land.
    const rx = cos * lx + sin * lz;
    const rz = -sin * lx + cos * lz;
    const worldX = pose.position.x + rx;
    const worldZ = pose.position.z + rz;
    const t = sample(worldX, worldZ);
    let deltaH = t === null ? 0 : t - baseTerrain;
    if (contouredThreshold > 0 && modelHeight > 0) {
      // Ratio-space falloff: full delta at the ground, scaled down
      // toward the threshold, zero above it.
      const ratio = Math.max(0, Math.min(1, ly / modelHeight));
      if (ratio >= thresholdRatio) {
        deltaH = 0;
      } else {
        deltaH *= (thresholdRatio - ratio) / thresholdRatio;
      }
    }
    out[i] = lx;
    out[i + 1] = ly + deltaH;
    out[i + 2] = lz;
  }
  outAttr.needsUpdate = true;
}

/**
 * Snap an arbitrary world-space point to the OSRS tile grid. Y is kept as
 * the terrain hit height so the ghost sits exactly on the tile surface;
 * X / Z are rounded down to the tile's SW corner then shifted to the tile
 * center (+TILE_SIZE/2). World +Z = south, so tileZ math uses `-worldZ`.
 */
function snapToTileCenter(worldPoint: THREE.Vector3): THREE.Vector3 {
  const tileX = Math.floor(worldPoint.x / TILE_SIZE);
  const tileZ = Math.floor(-worldPoint.z / TILE_SIZE);
  return new THREE.Vector3(
    tileX * TILE_SIZE + TILE_SIZE / 2,
    worldPoint.y,
    -(tileZ * TILE_SIZE + TILE_SIZE / 2),
  );
}

/**
 * CSS `cursor` value for "shift held → about to delete". A small inline
 * SVG with a red circle + white X, hotspot on the centre so the click
 * target matches the visual target. Falls back to `not-allowed` on
 * browsers that refuse the custom cursor (Firefox is flaky on SVG cursors
 * taller than the OS default).
 */
const DELETE_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="rgba(210,40,40,0.92)" stroke="white" stroke-width="1.5"/><line x1="8" y1="8" x2="16" y2="16" stroke="white" stroke-width="2.2" stroke-linecap="round"/><line x1="16" y1="8" x2="8" y2="16" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const DELETE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(DELETE_CURSOR_SVG)}") 12 12, not-allowed`;
