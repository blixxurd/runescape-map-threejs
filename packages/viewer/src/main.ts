import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TILE_SIZE, TILES_PER_SIDE } from "@rsmap/shared";
import { loadRegion } from "./loader.js";
import { buildTerrainMeshes } from "./terrain/buildTerrainMesh.js";
import { placeLocs } from "./locs/placeLocs.js";

const REGION_ID = Number(new URLSearchParams(location.search).get("region") ?? "12850");

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
  setHud(
    `region ${region.terrainMeta.regionId}  build ${region.terrainMeta.buildId}\n` +
      `terrain: ${region.terrainMeta.totalVertexCount} verts   locs: ${region.locs.placements.length} placements / ${region.locs.blocks.length} blocks`,
  );

  const terrainGroup = buildTerrainMeshes(
    region.terrainMeta,
    region.terrainPositions,
    region.terrainColors,
  );
  scene.add(terrainGroup);

  const locsGroup = placeLocs(
    region.locs,
    region.locsPositions,
    region.locsColors,
    region.terrainMeta,
    region.terrainHeights,
  );
  scene.add(locsGroup);

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
