import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  TILE_SIZE,
  TILES_PER_SIDE,
  VERTICES_PER_SIDE,
  packRegionId,
  unpackRegionId,
} from "@rsmap/shared";
import { loadRegion, type LoadPhase, type RegionData } from "./loader.js";
import { buildTerrainMeshes } from "./terrain/buildTerrainMesh.js";
import { placeLocs, tickLocAnimations, type LocAnimationState } from "./locs/placeLocs.js";
import { DebugInspector } from "./debug/inspector.js";
import { createSkybox, type SkyPreset } from "./sky/skybox.js";
import { EnvironmentPanel } from "./sky/environmentPanel.js";
import { ToolPanel } from "./tools/toolPanel.js";
import { ModelPlacer } from "./tools/modelPlacer.js";
import { Eyedropper } from "./tools/eyedropper.js";
import { Selection } from "./tools/selection.js";
import { InspectorPanel } from "./tools/inspectorPanel.js";
import { loadGlobalAtlas } from "./tools/globalAtlas.js";
import { captureScreenshot } from "./util/screenshot.js";
import { PlacesPanel } from "./ui/placesPanel.js";

// Match OSRS's sRGB-passthrough convention — the original client never did
// gamma/linear-space conversions. With Three's default color management on,
// our sRGB-authored vertex colors would be treated as linear, re-encoded
// to sRGB on output, and appear washed-out yellow. Disabling puts every
// byte in "what you send is what you display" mode.
THREE.ColorManagement.enabled = false;

const CENTER_REGION_ID = Number(new URLSearchParams(location.search).get("region") ?? "12850");
const MAX_PLANE = 3;
/**
 * Half-width of the loaded region grid. 0 = center region only (default),
 * 1 = 3×3 square, N = (2N+1)² square. The viewer is scene-graph-ready for
 * any radius, but past 1 there are visible seams where per-region
 * terrain blending / vertex lighting doesn't reach into the neighbor —
 * see `docs/scaling.md`.
 */
const NEIGHBOR_RADIUS = 1;
const REGION_SPAN = TILES_PER_SIDE * TILE_SIZE;

const hud = document.getElementById("hud")!;
const setHud = (text: string): void => {
  hud.textContent = text;
};

/**
 * One rendered region's runtime state. Owned by `main` so the plane-cap
 * toggle and debug inspector can iterate across every loaded region.
 */
interface LoadedRegion {
  regionId: number;
  /** Tile-grid delta from the URL's center region, in cache coords. */
  dRegionX: number;
  dRegionZ: number;
  /** World-space offset applied to the region's terrain + locs groups. */
  offsetX: number;
  offsetZ: number;
  region: RegionData;
  atlasTexture: THREE.Texture;
  terrainGroup: THREE.Group;
  locsGroup: THREE.Group;
  animated: LocAnimationState[];
}

async function setupRegion(
  regionId: number,
  centerRegionX: number,
  centerRegionZ: number,
  renderer: THREE.WebGLRenderer,
  onPhaseChange?: (phase: LoadPhase) => void,
): Promise<LoadedRegion> {
  const region = await loadRegion(regionId, { onPhaseChange });

  const { regionX, regionZ } = unpackRegionId(regionId);
  const dRegionX = regionX - centerRegionX;
  const dRegionZ = regionZ - centerRegionZ;
  // Cache +Y (north) maps to world −Z (because world +Z = south). A region
  // one step north of the center sits at world Z − REGION_SPAN.
  const offsetX = dRegionX * REGION_SPAN;
  const offsetZ = -dRegionZ * REGION_SPAN;

  // Atlas is per-region. Each region picks its own texture set so we can't
  // share a single GPU texture across regions without re-baking a unified
  // atlas. At 9 regions × ~2 MB each this is fine; revisit if the grid
  // grows (see docs/scaling.md).
  const atlasTexture = await new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(region.atlasUrl, resolve, undefined, reject);
  });
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
  atlasTexture.generateMipmaps = true;
  atlasTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.colorSpace = THREE.NoColorSpace;
  atlasTexture.flipY = false;

  const terrainGroup = buildTerrainMeshes(
    region.terrainMeta,
    region.terrainPositions,
    region.terrainColors,
    region.terrainUvs,
    atlasTexture,
  );
  terrainGroup.position.set(offsetX, 0, offsetZ);
  // Tag so the inspector can trace a hit back to its region.
  terrainGroup.userData.regionId = regionId;

  const placedLocs = placeLocs(
    region.locs,
    region.locsPositions,
    region.locsColors,
    region.locsUvs,
    region.locsFramesPositions,
    region.terrainMeta,
    region.terrainHeights,
    atlasTexture,
  );
  placedLocs.group.position.set(offsetX, 0, offsetZ);
  placedLocs.group.userData.regionId = regionId;

  return {
    regionId,
    dRegionX,
    dRegionZ,
    offsetX,
    offsetZ,
    region,
    atlasTexture,
    terrainGroup,
    locsGroup: placedLocs.group,
    animated: placedLocs.animated,
  };
}

async function main(): Promise<void> {
  setHud(`loading region ${CENTER_REGION_ID}…`);

  const canvas = document.getElementById("app")!;
  // Tried `logarithmicDepthBuffer: true` to spread depth precision evenly
  // across the 25k-unit region — it works for distance flicker BUT breaks
  // polygon offset (log depth writes via `gl_FragDepth`, which bypasses
  // the rasterizer's polygon-offset stage that decals on terrain rely
  // on). Stick with the default linear buffer + a saner near/far ratio.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvas.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f1a);
  // Fog is driven by the EnvironmentPanel and defaults off. Camera far
  // plane is still sized to the loaded grid so distant regions render
  // even without fog; fog's only job is the atmospheric fade.
  const gridDiag = REGION_SPAN * (2 * NEIGHBOR_RADIUS + 1) * Math.SQRT2;

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    16,
    gridDiag * 2,
  );

  // Center the camera on the URL region. It sits at world offset 0, so its
  // visual center is (REGION_SPAN/2, 0, -REGION_SPAN/2) — same math as the
  // single-region build.
  const regionCenter = new THREE.Vector3(REGION_SPAN / 2, 0, -REGION_SPAN / 2);
  camera.position.set(
    regionCenter.x,
    TILE_SIZE * 30,
    regionCenter.z + TILE_SIZE * 40,
  );
  camera.lookAt(regionCenter);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(regionCenter);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xd0e3ff, 0x3b2a1a, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(1, 1.4, 0.6);
  scene.add(sun);

  const { regionX: centerRegionX, regionZ: centerRegionZ } = unpackRegionId(CENTER_REGION_ID);

  // Region streaming state. `regions` holds everything finished and in the
  // scene; `loading` dedupes concurrent requests; `failed` absorbs ocean /
  // off-map ids so we don't hammer the middleware on every stream tick.
  const regions = new Map<number, LoadedRegion>();
  const loading = new Map<number, Promise<LoadedRegion | null>>();
  const failed = new Set<number>();
  const regionPhase = new Map<number, LoadPhase["phase"]>();

  /** World camera → cache regionId under the camera's current horizontal
   *  position. Inverse of the `offsetX/offsetZ` math in `setupRegion`. */
  const cameraRegionId = (): number => {
    const dRx = Math.floor(camera.position.x / REGION_SPAN);
    const dRz = Math.floor(-camera.position.z / REGION_SPAN);
    const rx = Math.max(0, Math.min(0xff, centerRegionX + dRx));
    const rz = Math.max(0, Math.min(0xff, centerRegionZ + dRz));
    return packRegionId(rx, rz);
  };

  /** Ids we want loaded right now: (2r+1)² square around the camera's
   *  current region, clamped to the 256×256 cache grid. */
  const desiredRegionIds = (): number[] => {
    const centerId = cameraRegionId();
    const { regionX: crx, regionZ: crz } = unpackRegionId(centerId);
    const ids: number[] = [];
    for (let dz = -NEIGHBOR_RADIUS; dz <= NEIGHBOR_RADIUS; dz++) {
      for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx++) {
        const rx = crx + dx;
        const rz = crz + dz;
        if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) continue;
        ids.push(packRegionId(rx, rz));
      }
    }
    return ids;
  };

  /**
   * Forward decl — filled in after `updateHud` / `applyPlaneCap` /
   * `inspector` exist. Called from the tick's stream check and from the
   * initial loader. Already-loaded / already-in-flight ids resolve
   * immediately without kicking off work; failed ids resolve to null.
   */
  let startLoad!: (regionId: number) => Promise<LoadedRegion | null>;

  // Initial grid ids — kicked off concurrently below once the loader is
  // fully wired. First paint waits for at least the center region.
  const initialIds = desiredRegionIds();

  // Skybox rides the camera. The panel in `EnvironmentPanel` drives it via
  // a dropdown — replaces the old `B` on/off hotkey. Fog is opt-in and
  // configured from the same panel.
  const INITIAL_SKY: SkyPreset = "aurora";
  const skybox = createSkybox(INITIAL_SKY);
  scene.add(skybox.mesh);
  // Sync the scene clear color to the sky's horizon so fog (when enabled)
  // blends into a matching tint rather than a hardcoded midnight blue.
  scene.background = skybox.getBackgroundColor();
  new EnvironmentPanel(
    {
      onSkyChange: (preset) => {
        skybox.setPreset(preset);
        scene.background = skybox.getBackgroundColor();
        // If fog is currently on, keep its color in sync with the new sky.
        if (scene.fog) (scene.fog as THREE.Fog).color.copy(skybox.getBackgroundColor());
      },
      onFogChange: ({ enabled, distance, thickness }) => {
        if (!enabled) {
          scene.fog = null;
          return;
        }
        const near = distance * (1 - thickness);
        const far = distance;
        // Reuse existing fog object when possible to avoid re-keying the
        // scene's fog reference every slider tick (Three.js re-uploads
        // fog uniforms per material anyway, but a stable reference lets
        // it skip the one-time "fog changed" path).
        if (scene.fog instanceof THREE.Fog) {
          scene.fog.near = near;
          scene.fog.far = far;
          scene.fog.color.copy(skybox.getBackgroundColor());
        } else {
          scene.fog = new THREE.Fog(skybox.getBackgroundColor(), near, far);
        }
      },
    },
    { sky: INITIAL_SKY },
  );

  /**
   * Snap the camera to the world-space center of a given region. Existing
   * regions stay in the scene; the streaming loader picks up the new
   * camera position and pulls neighbours of the destination on demand.
   * Camera pose mirrors the initial setup (high + slightly south, looking
   * at the center) so the framing stays consistent across teleports.
   */
  const goToRegion = (targetRegionId: number): void => {
    const { regionX: trx, regionZ: trz } = unpackRegionId(targetRegionId);
    const dx = trx - centerRegionX;
    const dz = trz - centerRegionZ;
    const worldX = (dx + 0.5) * REGION_SPAN;
    // Cache +Z=north → world −Z=north, so dz>0 (north of center) sits at
    // world Z < 0. Match the same offset math as `setupRegion`.
    const worldZ = -(dz + 0.5) * REGION_SPAN;
    camera.position.set(worldX, TILE_SIZE * 30, worldZ + TILE_SIZE * 40);
    controls.target.set(worldX, 0, worldZ);
    controls.update();
  };

  new PlacesPanel({
    onTeleport: (regionId) => goToRegion(regionId),
  });

  // Plane cap — OSRS roof-removal. Default 1: ground + bridges visible,
  // upper stories + roofs hidden. Applied uniformly across every loaded
  // region. `[` goes down a floor, `]` goes up. Cumulative: cap=3 shows all.
  let planeCap = 1;
  const applyPlaneCapTo = (lr: LoadedRegion): void => {
    for (const child of lr.terrainGroup.children) {
      const p = (child.userData as { plane?: number }).plane;
      if (p !== undefined) child.visible = p <= planeCap;
    }
    for (const child of lr.locsGroup.children) {
      const p = (child.userData as { plane?: number }).plane;
      if (p !== undefined) child.visible = p <= planeCap;
    }
  };
  const applyPlaneCap = (): void => {
    for (const lr of regions.values()) applyPlaneCapTo(lr);
    updateHud();
  };

  const updateHud = (): void => {
    const extracting = [...regionPhase.entries()].filter(([, p]) => p === "extracting").map(([id]) => id);
    const fetching = [...regionPhase.entries()].filter(([, p]) => p === "fetching").map(([id]) => id);
    const inflight: string[] = [];
    if (extracting.length > 0) inflight.push(`extracting ${extracting.slice(0, 3).join(", ")}`);
    else if (fetching.length > 0) inflight.push(`fetching ${fetching.slice(0, 3).join(", ")}`);
    const camId = cameraRegionId();
    setHud(
      `center ${CENTER_REGION_ID}  build ${BUILD_ID ?? "?"}  under camera: ${camId}\n` +
        `${regions.size} regions loaded${inflight.length > 0 ? " · " + inflight.join(" · ") : ""}` +
        (failed.size > 0 ? `  (skipped ${failed.size})` : "") +
        (counts.npc + counts.object + counts.item > 0
          ? `  · placed: ${[
              counts.npc ? `${counts.npc} npc` : "",
              counts.object ? `${counts.object} obj` : "",
              counts.item ? `${counts.item} item` : "",
            ].filter(Boolean).join(", ")}`
          : "") +
        `\nvisible: plane 0..${planeCap}   [ / ] to change   H: hide UI\n` +
        `WASD pan · Space/Ctrl up·down · Shift sprint · drag rotate · scroll zoom`,
    );
  };
  // Build id is surfaced once we've loaded the first region (all regions
  // share the pinned extractor build). Until then the HUD shows `?`.
  let BUILD_ID: number | undefined;
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    // Skip when typing in the tool panel's search box etc.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "[" && planeCap > 0) {
      planeCap--;
      applyPlaneCap();
    } else if (e.key === "]" && planeCap < MAX_PLANE) {
      planeCap++;
      applyPlaneCap();
    } else if (e.key === "h" || e.key === "H") {
      document.body.classList.toggle("ui-hidden");
    } else if (e.key === "p" || e.key === "P") {
      takeScreenshot();
    }
  });

  /** Flushes a render and downloads the canvas as PNG. Re-named here so
   *  both the keybind and the toolpanel button share the same path. */
  const takeScreenshot = (): void => {
    captureScreenshot(renderer, scene, camera, CENTER_REGION_ID);
  };

  // WASD pan — unchanged from the single-region build. Speed scales with
  // camera height so the Google-Maps feel carries into the larger grid.
  const keysHeld = new Set<string>();
  window.addEventListener("keydown", (e) => {
    keysHeld.add(e.key.toLowerCase());
  });
  window.addEventListener("keyup", (e) => {
    keysHeld.delete(e.key.toLowerCase());
  });
  window.addEventListener("blur", () => {
    keysHeld.clear();
  });

  // Debug inspector — starts empty; each stream-loaded region registers
  // itself via `addRegion` when its meshes are added to the scene.
  const inspector = new DebugInspector({ camera, renderer }, []);

  /**
   * Bilinear terrain-height lookup at an arbitrary world (x, z). Walks the
   * live `regions` map to find the owning region, reads directly out of
   * its `terrainHeights` Int16 grid.
   *
   * Returns `null` when the XZ falls outside any loaded region or off the
   * cache grid. Callers (the contoured placer) should treat a miss as
   * "don't deform this vertex", matching the extractor's edge-clamp
   * behaviour for contoured locs at region boundaries.
   *
   * Only plane 0 is queried — user placements live on the ground for now,
   * and sampling the actual hit's plane isn't plumbed through yet.
   */
  const sampleTerrainAt = (worldX: number, worldZ: number): number | null => {
    const dRx = Math.floor(worldX / REGION_SPAN);
    const dRz = Math.floor(-worldZ / REGION_SPAN);
    const rx = centerRegionX + dRx;
    const rz = centerRegionZ + dRz;
    if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) return null;
    const regionId = packRegionId(rx, rz);
    const lr = regions.get(regionId);
    if (!lr) return null;
    const localX = worldX - lr.offsetX;
    const localZ = worldZ - lr.offsetZ;
    const tileXf = localX / TILE_SIZE;
    // World +Z = south, cache +Z = north → invert to get cache-space tile z.
    const tileZf = -localZ / TILE_SIZE;
    const tx = Math.max(0, Math.min(TILES_PER_SIDE - 1, Math.floor(tileXf)));
    const tz = Math.max(0, Math.min(TILES_PER_SIDE - 1, Math.floor(tileZf)));
    const fx = Math.max(0, Math.min(1, tileXf - Math.floor(tileXf)));
    const fz = Math.max(0, Math.min(1, tileZf - Math.floor(tileZf)));
    const heights = lr.region.terrainHeights;
    const stride = VERTICES_PER_SIDE;
    const base = 0; // plane 0 only, see docstring
    const sw = heights[base + tz * stride + tx]!;
    const se = heights[base + tz * stride + (tx + 1)]!;
    const nw = heights[base + (tz + 1) * stride + tx]!;
    const ne = heights[base + (tz + 1) * stride + (tx + 1)]!;
    return (
      sw * (1 - fx) * (1 - fz) +
      se * fx * (1 - fz) +
      nw * (1 - fx) * fz +
      ne * fx * fz
    );
  };

  // Editor tools — each one owns a free-standing group under the scene
  // root and queries the live `regions` map via `getTerrainObjects` for
  // raycasts. The tool panel orchestrates arming across all three so only
  // one is active at a time.
  const toolHost = {
    scene,
    camera,
    canvas: renderer.domElement,
    getTerrainObjects: () => [...regions.values()].map((r) => r.terrainGroup),
    sampleTerrainAt,
  };
  // Shared global atlas for placer meshes. Kicks off in parallel with the
  // rest of main's boot — the placers are constructed in-process once it
  // resolves. The first atlas build on the server side is expensive (~1-3s
  // decoding every texture) so we show an HUD hint while it loads.
  setHud(`loading region ${CENTER_REGION_ID}… (+ texture atlas)`);
  const globalAtlas = await loadGlobalAtlas();

  const npcPlacer = new ModelPlacer(toolHost, {
    endpoint: "/api/npc",
    meshNamePrefix: "npc",
    kind: "npc",
    atlasTexture: globalAtlas.texture,
  });
  const objectPlacer = new ModelPlacer(toolHost, {
    endpoint: "/api/object",
    meshNamePrefix: "object",
    kind: "object",
    atlasTexture: globalAtlas.texture,
  });
  const itemPlacer = new ModelPlacer(toolHost, {
    endpoint: "/api/item",
    meshNamePrefix: "item",
    kind: "item",
    atlasTexture: globalAtlas.texture,
  });
  const eyedropper = new Eyedropper({
    camera,
    canvas: renderer.domElement,
    // Expose the placer groups so "pick from world" also resolves the
    // user's own placements, not just baked scenery.
    getPlacerGroups: () => [
      npcPlacer.getSceneGroup(),
      objectPlacer.getSceneGroup(),
      itemPlacer.getSceneGroup(),
    ],
  });

  const counts = { npc: 0, object: 0, item: 0 };
  npcPlacer.onPlacementsChanged = (n) => {
    counts.npc = n;
    updateHud();
  };
  objectPlacer.onPlacementsChanged = (n) => {
    counts.object = n;
    updateHud();
  };
  itemPlacer.onPlacementsChanged = (n) => {
    counts.item = n;
    updateHud();
  };

  const modelPlacers = { npc: npcPlacer, object: objectPlacer, item: itemPlacer };

  let toolPanel!: ToolPanel;
  const forEachModelPlacer = (fn: (p: ModelPlacer) => void): void => {
    fn(npcPlacer);
    fn(objectPlacer);
    fn(itemPlacer);
  };
  /** Forward-declared so `cancelOthers` and `refreshInspectorEnabled` can
   *  see the selection. Filled in once `Selection` is constructed below.
   *  `?.` guards work even before assignment because optional chaining
   *  treats `null` / `undefined` as a no-op. */
  let selection: Selection | null = null;
  /** Cancel every tool except `keep` (if provided). Used every time we
   *  arm something so at most one tool is hot at any given moment. Also
   *  drops any current selection — arming a placer auto-deselects so
   *  the gizmo and the placement ghost can't fight over the canvas. */
  const cancelOthers = (keep?: "npc" | "object" | "item"): void => {
    if (keep !== "npc") npcPlacer.cancel();
    if (keep !== "object") objectPlacer.cancel();
    if (keep !== "item") itemPlacer.cancel();
    selection?.deselect();
    refreshInspectorEnabled();
  };

  /**
   * Turn the Shift-hover debug inspector off whenever any editor tool is
   * active — otherwise the inspector's panel pops up and steals Shift
   * from the placer's "about to delete" UX. Re-enables once everything is
   * disarmed. Call after any arm/cancel/toggle across the tool set.
   */
  const refreshInspectorEnabled = (): void => {
    const anyArmed =
      npcPlacer.isArmed() ||
      objectPlacer.isArmed() ||
      itemPlacer.isArmed() ||
      eyedropper.isArmed();
    // Also turn off the Shift-hover debug inspector while a placement is
    // selected — Shift is reserved for the gizmo's free-angle modifier
    // and we don't want a tile-data popup distracting from the edit.
    const selecting = selection?.hasSelection() ?? false;
    inspector.setEnabled(!anyArmed && !selecting);
  };

  toolPanel = new ToolPanel({
    onArmEntity: (tab, entry) => {
      cancelOthers(tab);
      modelPlacers[tab].arm(entry.id, entry.name);
      refreshInspectorEnabled();
    },
    onCancel: () => cancelOthers(),
    onClear: (target) => {
      if (target === "npc" || target === "all") npcPlacer.clearAll();
      if (target === "object" || target === "all") objectPlacer.clearAll();
      if (target === "item" || target === "all") itemPlacer.clearAll();
    },
    onEyedropperArm: (armed) => {
      if (armed) {
        // Disarm every other tool — the eyedropper's whole job is to
        // consume the next click exclusively.
        cancelOthers();
        eyedropper.arm();
      } else {
        eyedropper.disarm();
      }
      refreshInspectorEnabled();
    },
    onChangeNpcAnimation: (npcId, name, animationId) => {
      // Re-arm with the override; the placer's arm() re-fetches (cached
      // per (id, animId)) and the ghost updates on the next hover.
      npcPlacer.arm(npcId, name, animationId);
      refreshInspectorEnabled();
    },
    onSnapToTileToggle: (snap) => {
      // Applies to every model-backed tool. TilePainter is grid-based by
      // construction, so we leave it alone.
      forEachModelPlacer((p) => p.setSnapToTile(snap));
    },
    onScreenshot: () => takeScreenshot(),
  });

  // Panel renders the animation-picker once an NPC's bake resolves and
  // exposes its menu. Objects/items don't populate this yet.
  npcPlacer.onArmedAnimationInfo = (info) => toolPanel.showNpcAnimationPicker(info);

  // Fire on both the button toggle and keyboard shortcut so the panel's
  // armed-state pill stays in sync.
  eyedropper.onArmChanged = (armed) => toolPanel.setEyedropperArmed(armed);
  eyedropper.onPick = (result) => {
    // Fetch the entity name from the matching catalog for the armed-state
    // banner. We already have the id; the name is just for display.
    const name = result.name ?? `#${result.id}`;
    cancelOthers(result.kind);
    modelPlacers[result.kind].arm(result.id, name);
    toolPanel.onPickedEntity(result.kind, result.id, name);
    refreshInspectorEnabled();
  };
  eyedropper.onMiss = () => {
    // Keep the eyedropper armed and let the user try again. Only log.
    console.info("[eyedropper] no matchable entity under cursor");
  };

  // "I" toggles the eyedropper — same behaviour as clicking the panel's
  // pick button. Skipped when typing in a form input.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "i" && e.key !== "I") return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (eyedropper.isArmed()) {
      eyedropper.disarm();
    } else {
      // Mirror the panel button's arming path so all the other tools get
      // cancelled first.
      cancelOthers();
      eyedropper.arm();
    }
    refreshInspectorEnabled();
  });

  // Rotation feedback from placers → panel banner. Only fires when one of
  // the model placers is armed and the user hits R.
  forEachModelPlacer((p) => {
    p.onRotationChanged = (rot) => toolPanel.setRotation(rot);
  });

  // Selection: click-to-select user-placed entities. Owns the OutlinePass
  // composer, so the tick loop renders via `selection.render()` rather
  // than the bare `renderer.render(...)`. Construction must come after
  // every placer has registered its click listener so selection's bubble
  // handler runs last and can defer to armed placers.
  selection = new Selection({
    scene,
    camera,
    renderer,
    canvas: renderer.domElement,
    getPlacers: () => [npcPlacer, objectPlacer, itemPlacer],
    isAnyToolArmed: () =>
      npcPlacer.isArmed() ||
      objectPlacer.isArmed() ||
      itemPlacer.isArmed() ||
      eyedropper.isArmed(),
    onDraggingChanged: (dragging) => {
      // Pause orbit during gizmo drag — otherwise mouse-look fires while
      // the user is dragging a translate/rotate handle.
      controls.enabled = !dragging;
    },
  });
  // Refresh the debug-inspector gate whenever selection state changes —
  // selecting silences the Shift-hover panel; deselecting restores it.
  selection.onSelectionChanged = (info) => {
    refreshInspectorEnabled();
    inspectorPanel.handleSelectionChanged(info);
  };
  selection.onPoseChanged = (info) => inspectorPanel.handlePoseChanged(info);
  selection.onGizmoModeChanged = (mode) => inspectorPanel.handleGizmoModeChanged(mode);
  // Drop the selection if the placer reports its mesh was removed (shift-
  // click delete or `clearAll`) — outlining a vanished mesh is a crash
  // waiting to happen.
  forEachModelPlacer((p) => {
    p.onMeshRemoved = (mesh) => selection!.notifyMeshRemoved(mesh);
  });

  // Inspector panel — listens to selection events and pushes property
  // edits back through the placer's mutation methods.
  const inspectorPanel = new InspectorPanel({ selection });

  // Escape cancels place mode regardless of focus — panel handles Escape
  // when focus is on the search box, this covers canvas-focused case.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toolPanel.cancelArmed();
  });

  // Finalize the streaming loader now that scene + inspector + planeCap
  // machinery all exist. `startLoad` was forward-declared above so the
  // initial `Promise.allSettled` can call it.
  startLoad = async (regionId: number): Promise<LoadedRegion | null> => {
    const existing = regions.get(regionId);
    if (existing) return existing;
    const inflight = loading.get(regionId);
    if (inflight) return inflight;
    if (failed.has(regionId)) return null;

    regionPhase.set(regionId, "fetching");
    updateHud();
    const p = setupRegion(regionId, centerRegionX, centerRegionZ, renderer, (phase) => {
      regionPhase.set(regionId, phase.phase);
      updateHud();
    })
      .then((lr) => {
        regions.set(regionId, lr);
        scene.add(lr.terrainGroup);
        scene.add(lr.locsGroup);
        applyPlaneCapTo(lr);
        inspector.addRegion({
          regionId: lr.regionId,
          terrainMeta: lr.region.terrainMeta,
          locsManifest: lr.region.locs,
          atlas: lr.region.atlas,
          terrainGroup: lr.terrainGroup,
          locsGroup: lr.locsGroup,
        });
        eyedropper.addRegion({
          regionId: lr.regionId,
          locsManifest: lr.region.locs,
          terrainGroup: lr.terrainGroup,
          locsGroup: lr.locsGroup,
        });
        if (BUILD_ID === undefined) BUILD_ID = lr.region.terrainMeta.buildId;
        return lr;
      })
      .catch((err: unknown) => {
        // 404s come back as "region X has no map data" (ocean / off-map) —
        // expected and cheap to record. Other errors (500, extractor crash)
        // also land here; the dev-server terminal has the underlying trace.
        console.warn(`[stream] region ${regionId} skipped:`, err);
        failed.add(regionId);
        return null;
      })
      .finally(() => {
        loading.delete(regionId);
        regionPhase.delete(regionId);
        updateHud();
      });
    loading.set(regionId, p);
    return p;
  };

  // Initial kickoff — block until the center region (+ neighbors in the
  // best case) has shown up so the first paint isn't empty.
  const initialResults = await Promise.allSettled(initialIds.map((id) => startLoad(id)));
  const centerLoaded = regions.has(CENTER_REGION_ID);
  if (!centerLoaded) {
    const centerReason = initialResults.find(
      (_, i) => initialIds[i] === CENTER_REGION_ID,
    );
    throw new Error(
      `center region ${CENTER_REGION_ID} unavailable (${
        centerReason?.status === "rejected" ? String(centerReason.reason) : "see console"
      }). In dev, the viewer auto-extracts; check the terminal for extractor errors. For a production build, run \`pnpm extract --region ${CENTER_REGION_ID}\` first.`,
    );
  }
  applyPlaneCap();

  const startTime = performance.now();
  let lastTickMs = startTime;
  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpMove = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

  // Region streaming — check which regions should be loaded around the
  // camera. Cheap work; we throttle it anyway so we don't spam the
  // middleware on every frame. Only fires when the camera's under-region
  // actually changes (or at most ~3 Hz as a safety net).
  let lastStreamRegionId = cameraRegionId();
  let lastStreamCheckMs = startTime;
  const streamCheck = (nowMs: number): void => {
    const camId = cameraRegionId();
    if (camId === lastStreamRegionId && nowMs - lastStreamCheckMs < 333) return;
    lastStreamRegionId = camId;
    lastStreamCheckMs = nowMs;
    for (const id of desiredRegionIds()) void startLoad(id);
    updateHud();
  };

  const tick = (): void => {
    const nowMs = performance.now();
    const dt = Math.min(0.1, (nowMs - lastTickMs) / 1000);
    lastTickMs = nowMs;

    if (keysHeld.size > 0) {
      camera.getWorldDirection(tmpForward);
      tmpForward.y = 0;
      if (tmpForward.lengthSq() > 1e-8) tmpForward.normalize();
      tmpRight.crossVectors(tmpForward, WORLD_UP).normalize();

      tmpMove.set(0, 0, 0);
      if (keysHeld.has("w")) tmpMove.add(tmpForward);
      if (keysHeld.has("s")) tmpMove.sub(tmpForward);
      if (keysHeld.has("d")) tmpMove.add(tmpRight);
      if (keysHeld.has("a")) tmpMove.sub(tmpRight);
      if (keysHeld.has(" ")) tmpMove.y += 1;
      if (keysHeld.has("control")) tmpMove.y -= 1;

      if (tmpMove.lengthSq() > 0) {
        tmpMove.normalize();
        const camHeight = Math.max(TILE_SIZE * 2, camera.position.y);
        const speed = camHeight * 1.2;
        const sprint = keysHeld.has("shift") ? 3 : 1;
        tmpMove.multiplyScalar(speed * sprint * dt);
        camera.position.add(tmpMove);
        controls.target.add(tmpMove);
      }
    }

    controls.update();
    streamCheck(nowMs);
    // Animate every region's locs. Each region owns its geometry buffers,
    // so the ticks don't interfere across regions — same elapsed time drives
    // them all, matching the OSRS client's global animation clock.
    for (const lr of regions.values()) {
      if (lr.animated.length > 0) tickLocAnimations(lr.animated, nowMs - startTime);
    }
    // Placed NPCs cycle their idle `standingAnimation` in place. Object
    // placer has no animation today but the tick is a no-op over an
    // empty placements list, cheap enough to call unconditionally.
    npcPlacer.tick(nowMs);
    objectPlacer.tick(nowMs);
    skybox.update(camera.position, nowMs - startTime);
    selection.render();
    requestAnimationFrame(tick);
  };
  tick();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    selection.setSize(window.innerWidth, window.innerHeight);
  });
}

main().catch((e) => {
  console.error(e);
  setHud(`error: ${(e as Error).message}`);
});
