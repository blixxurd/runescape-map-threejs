import * as THREE from "three";
import { TILE_SIZE } from "@rsmap/shared";

/**
 * Non-persistent tile painter. Snaps click positions to the 128-unit OSRS
 * tile grid and drops a flat 128×128 quad of the selected color at the
 * raycast Y, offset slightly above terrain. A single shared material with
 * negative polygon-offset wins the depth test against the baked terrain
 * below it, so coplanar placement doesn't flicker.
 *
 * For sloped tiles the quad stays flat (we don't resample corner heights)
 * so tiles drawn on hillsides look slightly inset from the terrain edges.
 * Good enough for a "prototype a room layout" workflow; sloped-tile
 * correctness would require rebuilding the underlying terrain geometry,
 * which is out of scope for the non-persistent tool.
 *
 * Shift-click removes the painted tile under the cursor.
 */

export interface TilePainterHost {
  scene: THREE.Scene;
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  getTerrainObjects: () => THREE.Object3D[];
}

interface PaintedTile {
  mesh: THREE.Mesh;
  tileX: number;
  tileZ: number;
}

/**
 * World (x, z) → tile (tileX, tileZ) in the cache's convention.
 *
 * Cache tile coords run with +Z = north, but our world has +Z = south. So
 * `tileZ = floor(-worldZ / TILE_SIZE)`. Kept in one place because this is
 * the exact same math the main.ts streaming loader uses for region
 * placement — get it wrong and paint lands one tile off.
 */
function tileFromWorld(worldX: number, worldZ: number): { tileX: number; tileZ: number } {
  return {
    tileX: Math.floor(worldX / TILE_SIZE),
    tileZ: Math.floor(-worldZ / TILE_SIZE),
  };
}

export class TilePainter {
  private readonly host: TilePainterHost;
  private readonly group = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly placed: PaintedTile[] = [];

  private activeColor = new THREE.Color("#ffb347");
  private armed = false;

  onPlacementsChanged: ((count: number) => void) | null = null;

  constructor(host: TilePainterHost) {
    this.host = host;
    this.group.name = "paint";
    this.group.userData.role = "paint";
    host.scene.add(this.group);

    host.canvas.addEventListener("click", (e) => this.handleClick(e));
    host.canvas.addEventListener("contextmenu", (e) => {
      if (!this.armed) return;
      e.preventDefault();
      this.disarm();
    });
  }

  arm(): void {
    this.armed = true;
    this.host.canvas.style.cursor = "crosshair";
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.host.canvas.style.cursor = "";
  }

  isArmed(): boolean {
    return this.armed;
  }

  setColor(hex: string): void {
    this.activeColor.set(hex);
  }

  clearAll(): void {
    for (const p of this.placed) {
      this.group.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
      (p.mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.placed.length = 0;
    this.onPlacementsChanged?.(0);
  }

  private handleClick(e: MouseEvent): void {
    if (e.shiftKey) {
      this.deleteAt(e);
      return;
    }
    if (!this.armed) return;

    const hit = this.raycastTerrain(e);
    if (!hit) return;

    const { tileX, tileZ } = tileFromWorld(hit.point.x, hit.point.z);
    // Replace existing paint on the same tile rather than stacking quads.
    const existing = this.placed.findIndex((p) => p.tileX === tileX && p.tileZ === tileZ);
    if (existing >= 0) {
      const prev = this.placed[existing]!;
      this.group.remove(prev.mesh);
      (prev.mesh.material as THREE.Material).dispose();
      (prev.mesh.geometry as THREE.BufferGeometry).dispose();
      this.placed.splice(existing, 1);
    }

    const geom = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE);
    // PlaneGeometry is oriented XY by default — rotate into the XZ plane so
    // it lies flat on terrain. `rotation.x = -π/2` maps +Y → +Z.
    geom.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: this.activeColor.clone(),
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });

    const mesh = new THREE.Mesh(geom, mat);
    // Tile center — half a tile east of SW corner, half a tile south of NW.
    const worldCenterX = tileX * TILE_SIZE + TILE_SIZE / 2;
    const worldCenterZ = -(tileZ * TILE_SIZE + TILE_SIZE / 2);
    // Use the hit Y directly: for flat tiles this is exact, for sloped
    // tiles this is an approximation that can drift up to ~half a tile
    // high depending on where the click landed.
    mesh.position.set(worldCenterX, hit.point.y, worldCenterZ);
    mesh.userData = { kind: "paint", tileX, tileZ };
    this.group.add(mesh);
    this.placed.push({ mesh, tileX, tileZ });
    this.onPlacementsChanged?.(this.placed.length);
  }

  private deleteAt(e: MouseEvent): void {
    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);
    const hits = this.raycaster.intersectObjects(this.group.children, false);
    if (hits.length === 0) return;
    const target = hits[0]!.object as THREE.Mesh;
    const idx = this.placed.findIndex((p) => p.mesh === target);
    if (idx < 0) return;
    this.group.remove(target);
    (target.geometry as THREE.BufferGeometry).dispose();
    (target.material as THREE.Material).dispose();
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
}
