import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TILE_SIZE, TILES_PER_SIDE } from "@rsmap/shared";
import { loadRegion } from "./loader.js";
import { buildTerrainMeshes } from "./terrain/buildTerrainMesh.js";
import { placeLocs } from "./locs/placeLocs.js";
import { DebugInspector } from "./debug/inspector.js";

// Match OSRS's sRGB-passthrough convention — the original client never did
// gamma/linear-space conversions. With Three's default color management on,
// our sRGB-authored vertex colors would be treated as linear, re-encoded
// to sRGB on output, and appear washed-out yellow. Disabling puts every
// byte in "what you send is what you display" mode.
THREE.ColorManagement.enabled = false;

const REGION_ID = Number(new URLSearchParams(location.search).get("region") ?? "12850");
const MAX_PLANE = 3;

const hud = document.getElementById("hud")!;
const setHud = (text: string): void => {
  hud.textContent = text;
};

async function main(): Promise<void> {
  setHud(`loading region ${REGION_ID}…`);

  const canvas = document.getElementById("app")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvas.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f1a);
  // Fog makes the far side of the region fade out nicely.
  // Fog is distance-based so it works regardless of axis convention.
  scene.fog = new THREE.Fog(0x0b0f1a, TILE_SIZE * 32, TILE_SIZE * 140);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    1,
    TILE_SIZE * 200,
  );

  // Extractor emits (+X east, +Y up, +Z south). Tiles span [0..63] in
  // cache Y → world Z spans [0 .. −8064]. Camera at +Z (south of scene)
  // looking −Z gives north-at-top, east-on-right.
  const regionCenter = new THREE.Vector3(
    (TILES_PER_SIDE * TILE_SIZE) / 2,
    0,
    -(TILES_PER_SIDE * TILE_SIZE) / 2,
  );
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
  controls.maxPolarAngle = Math.PI * 0.49; // don't dip below ground

  // Lights: a soft sky/ground hemisphere plus a directional "sun".
  scene.add(new THREE.HemisphereLight(0xd0e3ff, 0x3b2a1a, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(1, 1.4, 0.6);
  scene.add(sun);

  // Kick off region load while the scene is set up.
  const region = await loadRegion(REGION_ID);

  // Load the shared atlas texture. `NearestFilter` keeps the chunky RS look
  // instead of smearing adjacent cells together under linear filtering.
  const atlasTexture = await new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(region.atlasUrl, resolve, undefined, reject);
  });
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  // With ColorManagement.enabled = false the colorSpace flag is a no-op.
  // We leave it as NoColorSpace so Three doesn't silently convert later if
  // color management gets re-enabled.
  atlasTexture.colorSpace = THREE.NoColorSpace;
  // Three.js's default `flipY = true` vertically mirrors the PNG at upload,
  // which would put cell 0 (top-left of the canvas) at UV V=1. Our cell-index
  // math assumes canvas top-left = UV (0, 0), so disable the flip.
  atlasTexture.flipY = false;

  const terrainGroup = buildTerrainMeshes(
    region.terrainMeta,
    region.terrainPositions,
    region.terrainColors,
    region.terrainUvs,
    atlasTexture,
  );
  scene.add(terrainGroup);

  const locsGroup = placeLocs(
    region.locs,
    region.locsPositions,
    region.locsColors,
    region.locsUvs,
    region.terrainMeta,
    region.terrainHeights,
    atlasTexture,
  );
  scene.add(locsGroup);

  // Plane cap — OSRS roof-removal. Default 1: ground + bridges visible,
  // upper stories + roofs hidden. `[` goes down a floor, `]` goes up.
  // Shows cumulative: every plane ≤ cap is visible, so cap=3 shows all.
  let planeCap = 1;
  const applyPlaneCap = (): void => {
    for (const child of terrainGroup.children) {
      const p = (child.userData as { plane?: number }).plane;
      if (p !== undefined) child.visible = p <= planeCap;
    }
    for (const child of locsGroup.children) {
      const p = (child.userData as { plane?: number }).plane;
      if (p !== undefined) child.visible = p <= planeCap;
    }
    updateHud();
  };
  const hudBase = `region ${region.terrainMeta.regionId}  build ${region.terrainMeta.buildId}\n` +
    `terrain: ${region.terrainMeta.totalVertexCount} verts   locs: ${region.locs.placements.length} placements / ${region.locs.blocks.length} blocks`;
  const updateHud = (): void => {
    setHud(`${hudBase}\nvisible: plane 0..${planeCap}   [ / ] to change`);
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "[" && planeCap > 0) {
      planeCap--;
      applyPlaneCap();
    } else if (e.key === "]" && planeCap < MAX_PLANE) {
      planeCap++;
      applyPlaneCap();
    }
  });
  applyPlaneCap();

  // Debug inspector — shift-hover to see cache data for the thing under
  // the cursor. Debug bundles are fetched lazily on first shift.
  new DebugInspector(
    { camera, renderer, terrainGroup, locsGroup },
    REGION_ID,
    region.locs,
    region.terrainMeta,
    region.atlas,
  );

  // Simple render loop.
  const tick = (): void => {
    controls.update();
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
