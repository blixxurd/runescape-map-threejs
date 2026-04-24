import * as THREE from "three";
import { TILE_SIZE } from "@rsmap/shared";

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
  /** Bilinear terrain-height lookup. Returns `null` when no loaded region
   *  covers (worldX, worldZ). Used by contoured-object deformation. */
  sampleTerrainAt: (worldX: number, worldZ: number) => number | null;
}

export interface ModelPlacerConfig {
  /** Server endpoint prefix, e.g. `/api/npc` or `/api/object`. */
  endpoint: string;
  /** Debug/scene name prefix for placed meshes. */
  meshNamePrefix: string;
  /** Logical tag put on each placed mesh's userData. */
  kind: string;
  /** Global atlas that matches the UVs the server emits. Placed meshes
   *  sample from this as their `map`; vertex colors are tint. */
  atlasTexture: THREE.Texture;
}

interface CachedEntity {
  geometry: THREE.BufferGeometry;
  name: string;
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

export class ModelPlacer {
  private readonly host: ModelPlacerHost;
  private readonly config: ModelPlacerConfig;
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
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

  /** Mirrors the physical Shift key. When held AND a placer is armed we
   *  hide the ghost and flip the cursor to a delete indicator — the same
   *  Shift+click already deletes a hovered placement, so this just makes
   *  the intent obvious. Tracked on `window` because focus can be anywhere
   *  (search input, panel button) when the user starts holding. */
  private shiftHeld = false;

  onPlacementsChanged: ((count: number) => void) | null = null;
  onRotationChanged: ((rot: number) => void) | null = null;
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

  clearAll(): void {
    for (const p of this.placed) {
      this.group.remove(p.mesh);
      (p.mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.placed.length = 0;
    this.onPlacementsChanged?.(0);
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.isArmed()) return;
    if (e.key !== "r" && e.key !== "R") return;
    // Skip when a form field has focus — the search input lives on top of
    // the canvas and we don't want to cycle rotation on every "r" keystroke
    // the user types in a search query.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const step = e.shiftKey ? 7 : 1; // Shift+R = rotate the other way (+7 ≡ -1 mod 8).
    this.placementRotation = (this.placementRotation + step) & 7;
    // Keep the ghost oriented to match the pending placement rotation.
    this.ghostMesh.rotation.y = (this.placementRotation * Math.PI) / 4;
    this.onRotationChanged?.(this.placementRotation);
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
    const hit = this.raycastTerrain(e);
    if (!hit) {
      this.hideGhost();
      return;
    }
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
    this.ghostMesh.rotation.y = (pose.rotation * Math.PI) / 4;
    this.ghostMesh.visible = true;
  }

  private hideGhost(): void {
    this.ghostMesh.visible = false;
  }

  /** Placement pose for the armed entity at a raycast hit. Tile-center
   *  snap on XZ, user-controlled `placementRotation`. Kept as a helper
   *  so the ghost and the real placement share the same math. */
  private resolvePose(worldPoint: THREE.Vector3): {
    position: THREE.Vector3;
    rotation: number;
  } {
    // Free placement uses the raw hit (clone it so callers can't mutate
    // the raycaster's internal Vector3); tile snap drops to the centre of
    // whatever tile the hit falls inside.
    const position = this.snapToTile
      ? snapToTileCenter(worldPoint)
      : worldPoint.clone();
    return { position, rotation: this.placementRotation };
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
    const hit = this.raycastTerrain(e);
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
    // Contoured and animated placements both need their own geometry:
    // contoured because the deformation is per-placement, animated because
    // we overwrite the position attribute each tick. Static rigid entities
    // reuse the cached shared geometry for zero-copy instancing.
    let geom = baked.geometry;
    if (baked.contouredGround !== undefined) {
      geom = baked.geometry.clone();
      applyContourDeformation(
        baked.basePositions,
        geom.attributes.position as THREE.BufferAttribute,
        baked.modelHeight,
        baked.contouredGround,
        pose,
        this.host.sampleTerrainAt,
      );
    } else if (baked.animation) {
      // Share color + uv with the cached geometry (they don't change
      // across frames); only `position` needs a writable copy.
      geom = new THREE.BufferGeometry();
      const mutablePositions = new Float32Array(baked.basePositions.length);
      mutablePositions.set(baked.animation.framePositions[0]!);
      geom.setAttribute("position", new THREE.BufferAttribute(mutablePositions, 3));
      const srcColor = baked.geometry.getAttribute("color") as THREE.BufferAttribute;
      const srcUv = baked.geometry.getAttribute("uv") as THREE.BufferAttribute;
      geom.setAttribute("color", srcColor);
      geom.setAttribute("uv", srcUv);
      geom.boundingSphere = baked.geometry.boundingSphere;
    }
    const mesh = new THREE.Mesh(geom, this.material);
    mesh.position.copy(pose.position);
    mesh.rotation.y = (pose.rotation * Math.PI) / 4;
    mesh.name = `${this.config.meshNamePrefix}:${armedIdSnapshot}`;
    mesh.userData = {
      kind: this.config.kind,
      id: armedIdSnapshot,
      name: armedNameSnapshot,
      rotation: pose.rotation,
    };
    this.group.add(mesh);
    const placement: PlacedEntity = { mesh, id: armedIdSnapshot, name: armedNameSnapshot };
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
    const target = hits[0]!.object as THREE.Mesh;
    const idx = this.placed.findIndex((p) => p.mesh === target);
    if (idx < 0) return;
    this.group.remove(target);
    (target.geometry as THREE.BufferGeometry).dispose();
    this.placed.splice(idx, 1);
    this.onPlacementsChanged?.(this.placed.length);
  }

  private raycastTerrain(e: MouseEvent): THREE.Intersection | null {
    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    const targets = this.host.getTerrainObjects();
    const hits = this.raycaster.intersectObjects(targets, true);
    return hits[0] ?? null;
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
  pose: { position: THREE.Vector3; rotation: number },
  sample: (worldX: number, worldZ: number) => number | null,
): void {
  const out = outAttr.array as Float32Array;
  const cos = Math.cos((pose.rotation * Math.PI) / 4);
  const sin = Math.sin((pose.rotation * Math.PI) / 4);
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
