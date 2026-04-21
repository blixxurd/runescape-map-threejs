import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TILE_SIZE, TILES_PER_SIDE } from "@rsmap/shared";
import { loadRegion, type RegionData } from "./loader.js";
import { buildTerrainMeshes } from "./terrain/buildTerrainMesh.js";
import { placeLocs, tickLocAnimations, type LocAnimationState } from "./locs/placeLocs.js";
import { DebugInspector, type RegionInfo } from "./debug/inspector.js";
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
): Promise<LoadedRegion> {
  const region = await loadRegion(regionId);

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

  // Compute the 3×3 (or (2r+1)²) region ids centered on the URL region and
  // load each. A region that 404s (ocean, missing bundle) is skipped with
  // a console warning rather than failing the whole load.
  const centerRegionX = (CENTER_REGION_ID >> 8) & 0xff;
  const centerRegionZ = CENTER_REGION_ID & 0xff;
  const candidateIds: number[] = [];
  for (let dz = -NEIGHBOR_RADIUS; dz <= NEIGHBOR_RADIUS; dz++) {
    for (let dx = -NEIGHBOR_RADIUS; dx <= NEIGHBOR_RADIUS; dx++) {
      const rx = centerRegionX + dx;
      const rz = centerRegionZ + dz;
      if (rx < 0 || rx > 0xff || rz < 0 || rz > 0xff) continue;
      candidateIds.push((rx << 8) | rz);
    }
  }

  const results = await Promise.allSettled(
    candidateIds.map((id) => setupRegion(id, centerRegionX, centerRegionZ, renderer)),
  );
  const loaded: LoadedRegion[] = [];
  const missing: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      loaded.push(r.value);
    } else {
      missing.push(candidateIds[i]!);
      console.warn(`[main] region ${candidateIds[i]} skipped:`, r.reason);
    }
  }
  if (loaded.length === 0) {
    throw new Error(
      `no regions loaded — center ${CENTER_REGION_ID} missing from /regions/; run \`pnpm extract\` first`,
    );
  }

  for (const lr of loaded) {
    scene.add(lr.terrainGroup);
    scene.add(lr.locsGroup);
  }

  // Night sky sits on the camera's position so its dome follows the view.
  // It doesn't care about region count.
  const nightSky = createNightSky();
  scene.add(nightSky.mesh);

  // Plane cap — OSRS roof-removal. Default 1: ground + bridges visible,
  // upper stories + roofs hidden. Applied uniformly across every loaded
  // region. `[` goes down a floor, `]` goes up. Cumulative: cap=3 shows all.
  let planeCap = 1;
  const applyPlaneCap = (): void => {
    for (const lr of loaded) {
      for (const child of lr.terrainGroup.children) {
        const p = (child.userData as { plane?: number }).plane;
        if (p !== undefined) child.visible = p <= planeCap;
      }
      for (const child of lr.locsGroup.children) {
        const p = (child.userData as { plane?: number }).plane;
        if (p !== undefined) child.visible = p <= planeCap;
      }
    }
    updateHud();
  };

  const centerRegion = loaded.find((r) => r.regionId === CENTER_REGION_ID) ?? loaded[0]!;
  const totalPlacements = loaded.reduce((n, lr) => n + lr.region.locs.placements.length, 0);
  const totalVerts = loaded.reduce((n, lr) => n + lr.region.terrainMeta.totalVertexCount, 0);
  const hudBase =
    `center ${centerRegion.regionId}  build ${centerRegion.region.terrainMeta.buildId}\n` +
    `${loaded.length}/${candidateIds.length} regions loaded` +
    (missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "") +
    `\nterrain: ${totalVerts} verts   locs: ${totalPlacements} placements`;
  const updateHud = (): void => {
    setHud(
      `${hudBase}\nvisible: plane 0..${planeCap}   [ / ] to change   B: aurora sky ${nightSky.mesh.visible ? "on" : "off"}\n` +
        `WASD pan · Space/Ctrl up·down · Shift sprint · drag rotate · scroll zoom`,
    );
  };
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
  applyPlaneCap();

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

  // Debug inspector — one map entry per loaded region so a hit on any
  // region's terrain/loc mesh resolves against the right cache data.
  const regionInfos: RegionInfo[] = loaded.map((lr) => ({
    regionId: lr.regionId,
    terrainMeta: lr.region.terrainMeta,
    locsManifest: lr.region.locs,
    atlas: lr.region.atlas,
    terrainGroup: lr.terrainGroup,
    locsGroup: lr.locsGroup,
  }));
  new DebugInspector({ camera, renderer }, regionInfos);

  const startTime = performance.now();
  let lastTickMs = startTime;
  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpMove = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
    // Animate every region's locs. Each region owns its geometry buffers,
    // so the ticks don't interfere across regions — same elapsed time drives
    // them all, matching the OSRS client's global animation clock.
    for (const lr of loaded) {
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
