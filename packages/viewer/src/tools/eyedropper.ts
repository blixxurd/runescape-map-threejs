import * as THREE from "three";
import type { LocsManifest } from "@rsmap/shared";
import type { PlacedMeshUserData } from "./placerTypes.js";

/**
 * "Pick from world" tool. Click on anything in the scene while armed and
 * the eyedropper resolves what was hit back to an entity id:
 *
 *   - A baked loc (baseline world scenery) → `{ kind: "object", id: locId }`.
 *     The loc manifest's placement/block tables translate the raycast hit
 *     — either `instanceId` on an InstancedMesh or the merged-loc triangle
 *     map — into the OSRS locId we'd need to arm the Object tool with.
 *   - A mesh the user already placed with the NPC or Object tool →
 *     `{ kind: "npc" | "object", id }`. These carry `userData.kind` / `id`
 *     set by ModelPlacer.
 *
 * Terrain triangles return `null` — eyedropping bare ground is intentionally
 * a miss, not "the first scenery hidden behind it".
 *
 * Host wiring:
 *   - Construct once, call `addRegion` as regions stream in (mirrors the
 *     debug inspector's lifecycle).
 *   - Call `arm()` / `disarm()` from the tool panel; `isArmed()` for UI.
 *   - `onPick` fires with the resolved identity on a successful click.
 *     The host decides what to do next (normally: arm the right placer).
 */

export type PickResult =
  | { kind: "npc"; id: number; name?: string }
  | { kind: "object"; id: number; name?: string };

export interface EyedropperRegion {
  regionId: number;
  locsManifest: LocsManifest;
  terrainGroup: THREE.Group;
  locsGroup: THREE.Group;
}

export interface EyedropperHost {
  camera: THREE.Camera;
  canvas: HTMLCanvasElement;
  /** Placer groups the eyedropper should also raycast against — lets the
   *  user pick up their own placements, not just baked world locs. */
  getPlacerGroups: () => THREE.Object3D[];
}

export class Eyedropper {
  private readonly host: EyedropperHost;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly regions = new Map<number, EyedropperRegion>();
  private armed = false;

  onPick: ((result: PickResult) => void) | null = null;
  onArmChanged: ((armed: boolean) => void) | null = null;
  onMiss: ((reason: string) => void) | null = null;

  constructor(host: EyedropperHost) {
    this.host = host;
    // Register in the capture phase so we intercept the click before the
    // placers' own click handlers run. Without this, arming the eyedropper
    // while another placer is also armed would double-act (place AND pick).
    host.canvas.addEventListener("click", (e) => this.handleClick(e), true);
    host.canvas.addEventListener(
      "contextmenu",
      (e) => {
        if (!this.armed) return;
        e.preventDefault();
        this.disarm();
      },
      true,
    );
  }

  addRegion(info: EyedropperRegion): void {
    this.regions.set(info.regionId, info);
  }

  arm(): void {
    if (this.armed) return;
    this.armed = true;
    this.host.canvas.style.cursor = "copy";
    this.onArmChanged?.(true);
  }

  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.host.canvas.style.cursor = "";
    this.onArmChanged?.(false);
  }

  isArmed(): boolean {
    return this.armed;
  }

  private handleClick(e: MouseEvent): void {
    if (!this.armed) return;
    // Block other click handlers so the placer under the eyedropper doesn't
    // simultaneously place at this tile.
    e.stopPropagation();
    e.preventDefault();

    const result = this.pickAt(e);
    if (!result) {
      this.onMiss?.("no matchable entity under cursor");
      // Stay armed so the user can try again without re-clicking the tool
      // button. Right-click still cancels.
      return;
    }
    this.disarm();
    this.onPick?.(result);
  }

  private pickAt(e: MouseEvent): PickResult | null {
    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);

    // Raycast over every loc group + every user-placed group. Terrain is
    // excluded on purpose — an eyedropper click on bare ground should miss,
    // not accidentally return the first scenery behind the terrain.
    const targets: THREE.Object3D[] = [];
    for (const r of this.regions.values()) targets.push(r.locsGroup);
    for (const g of this.host.getPlacerGroups()) targets.push(g);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return null;

    // Scan hits in order — the closest one usually wins, but we skip hits
    // on the ghost-preview meshes (they have no usable identity).
    for (const hit of hits) {
      const obj = hit.object;
      // Ghost meshes carry no kind/id; ModelPlacer names them `<kind>:ghost`.
      if (obj.name.endsWith(":ghost")) continue;
      const ud = obj.userData as Partial<PlacedMeshUserData>;

      // User-placed mesh: kind + id live directly on the mesh.
      if ((ud.kind === "npc" || ud.kind === "object") && typeof ud.id === "number") {
        return { kind: ud.kind, id: ud.id, name: ud.name };
      }

      // Baked loc mesh: walk up to the locsGroup to find the owning region,
      // then resolve instanceId (InstancedMesh) or faceIndex (merged) back
      // to the manifest's locId.
      const region = this.findOwningRegion(obj);
      if (!region) continue;
      const locId = resolveLocId(obj, region.locsManifest, hit);
      if (locId !== null) return { kind: "object", id: locId };
    }
    return null;
  }

  private findOwningRegion(obj: THREE.Object3D): EyedropperRegion | null {
    let p: THREE.Object3D | null = obj;
    while (p) {
      const rid = (p.userData as { regionId?: number }).regionId;
      if (rid !== undefined) {
        const r = this.regions.get(rid);
        if (r && r.locsGroup === p) return r;
      }
      p = p.parent;
    }
    return null;
  }

  private updateNdc(e: MouseEvent): void {
    const rect = this.host.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }
}

/** Raycast hit → locId via the loc manifest, for either the InstancedMesh
 *  or merged-loc variants built by placeLocs. */
function resolveLocId(
  obj: THREE.Object3D,
  manifest: LocsManifest,
  hit: THREE.Intersection,
): number | null {
  // InstancedMesh case: placeLocs sets `userData.placementIdxs`.
  const placementIdxs = (obj.userData as { placementIdxs?: number[] }).placementIdxs;
  if (placementIdxs && hit.instanceId !== undefined && hit.instanceId !== null) {
    const idx = placementIdxs[hit.instanceId];
    if (idx !== undefined) return locIdFromPlacement(manifest, idx);
  }

  // Merged-loc case: userData.placementByTri maps faceIndex → placement idx.
  const placementByTri = (obj.userData as { placementByTri?: Uint32Array }).placementByTri;
  if (placementByTri && hit.faceIndex !== undefined && hit.faceIndex !== null) {
    const idx = placementByTri[hit.faceIndex];
    if (idx !== undefined) return locIdFromPlacement(manifest, idx);
  }

  return null;
}

function locIdFromPlacement(manifest: LocsManifest, placementIdx: number): number | null {
  const placement = manifest.placements[placementIdx];
  if (!placement) return null;
  const block = manifest.blocks[placement.blockIndex];
  if (!block) return null;
  return block.locId;
}
