import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TILE_SIZE, TILES_PER_SIDE } from "@rsmap/shared";
import { loadRegion, type LoadPhase, type RegionData } from "./loader.js";
import { buildTerrainMeshes } from "./terrain/buildTerrainMesh.js";
import { placeLocs, tickLocAnimations, type LocAnimationState } from "./locs/placeLocs.js";
import { DebugInspector } from "./debug/inspector.js";
import { createNightSky } from "./sky/nightSky.js";

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

  const regionX = (regionId >> 8) & 0xff;
  const regionZ = regionId & 0xff;
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
  // Fog covers the extent of the loaded grid (REGION_SPAN × (2*radius+1)).
  // The far end matches the diagonal across the grid so the far edge of a
  // corner region doesn't pop in. Near is kept close to the center so
  // neighbors fade gradually rather than all appearing at once.
  const gridDiag = REGION_SPAN * (2 * NEIGHBOR_RADIUS + 1) * Math.SQRT2;
  scene.fog = new THREE.Fog(0x0b0f1a, REGION_SPAN * 0.5, gridDiag);

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

  const centerRegionX = (CENTER_REGION_ID >> 8) & 0xff;
  const centerRegionZ = CENTER_REGION_ID & 0xff;

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
    return (rx << 8) | rz;
  };

  /** Ids we want loaded right now: (2r+1)² square around the camera's
   *  current region, clamped to the 256×256 cache grid. */
  const desiredRegionIds = (): number[] => {
    const centerId = cameraRegionId();
    const crx = (centerId >> 8) & 0xff;
    const crz = centerId & 0xff;
    const ids: number[] = [];
    for (let dz = -NEIGHBOR_RADIUS; dz <= NEIGHBOR_RADIUS; dz++) {
      for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx++) {
        const rx = crx + dx;
        const rz = crz + dz;
        if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) continue;
        ids.push((rx << 8) | rz);
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

  // Night sky sits on the camera's position so its dome follows the view.
  // It doesn't care about region count.
  const nightSky = createNightSky();
  scene.add(nightSky.mesh);

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
        `\nvisible: plane 0..${planeCap}   [ / ] to change   B: aurora sky ${nightSky.mesh.visible ? "on" : "off"}\n` +
        `WASD pan · Space/Ctrl up·down · Shift sprint · drag rotate · scroll zoom`,
    );
  };
  // Build id is surfaced once we've loaded the first region (all regions
  // share the pinned extractor build). Until then the HUD shows `?`.
  let BUILD_ID: number | undefined;
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "[" && planeCap > 0) {
      planeCap--;
      applyPlaneCap();
    } else if (e.key === "]" && planeCap < MAX_PLANE) {
      planeCap++;
      applyPlaneCap();
    } else if (e.key === "b" || e.key === "B") {
      nightSky.mesh.visible = !nightSky.mesh.visible;
      updateHud();
    }
  });

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
    nightSky.update(camera.position, nowMs - startTime);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

main().catch((e) => {
  console.error(e);
  setHud(`error: ${(e as Error).message}`);
});
