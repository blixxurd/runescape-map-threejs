import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { LocsManifest } from "@rsmap/shared";
import { TILE_SIZE } from "@rsmap/shared";
import type { Placer, PlacedRef } from "./placerTypes.js";
import { resolveLocHit, type LocHit } from "./locResolve.js";
import type { SaveStore } from "../saves/saveStore.js";
import { SUNK_Y, hideInstancedSlot, hideMergedTriangles } from "../locs/hideLoc.js";

/**
 * Selection: click-to-select either a user-placed entity (NPC / object /
 * item / spotanim) OR a baked-world loc (scenery from the cache bundle).
 * Owns the cyan OutlinePass that highlights the current selection and
 * the click+Esc handlers that drive selection state.
 *
 * Two flavours:
 *   - `kind: "placed"` — full editor support: gizmo, numeric pose inputs,
 *     duplicate, animation override, arrow-key nudge.
 *   - `kind: "baked"` — read-only inspector + Delete (records a tombstone
 *     in `SaveStore` and zero-scales the InstancedMesh slot or zero-
 *     vertexes the merged-mesh triangles for instant feedback). Does not
 *     attach the TransformControls — moving baked locs is out of scope
 *     for v1; users delete + re-place via the Object placer instead.
 *
 * Activation model: when no placer is armed, plain click selects the
 * placement (placed first, baked-loc second) under the cursor; click on
 * bare terrain (or any miss) clears the selection. Shift-click is reserved
 * for the placer's quick-delete path — selection ignores it. Arming any
 * placer auto-deselects via main (selection.deselect() called from
 * cancelOthers).
 *
 * Render lifecycle: this class owns an `EffectComposer` because the
 * outline edge is drawn as a post-pass. Callers replace
 * `renderer.render(scene, camera)` with `selection.render()` and proxy
 * canvas resize through `selection.setSize(w, h)`.
 */

export type SelectionInfo =
  | { kind: "placed"; placer: Placer; ref: PlacedRef }
  | { kind: "baked"; regionId: number; locHit: LocHit };

/** Per-region context the selection raycaster needs. Mirrors the subset of
 *  `LoadedRegion` that's relevant for baked-loc clicks. */
export interface SelectionRegion {
  regionId: number;
  locsGroup: THREE.Group;
  locsManifest: LocsManifest;
}

export interface SelectionHost {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  /** Placers selection should raycast against. Called per click so it
   *  picks up freshly-constructed placers without us caching a stale
   *  reference. */
  getPlacers: () => Placer[];
  /** Loaded regions to also raycast against (for baked-loc clicks). Same
   *  per-call pattern — fresh stream-loaded regions show up automatically. */
  getRegions: () => SelectionRegion[];
  /** Active map save. Baked-loc Delete records a tombstone here. */
  saveStore: SaveStore;
  /** Returns true if some other tool (placer / eyedropper) is currently
   *  armed. Selection bails on click when true so it doesn't fight with
   *  placement clicks. */
  isAnyToolArmed: () => boolean;
  /** Fired with `true` when the gizmo grabs a handle, `false` on release.
   *  Host should disable orbit camera controls during a drag. */
  onDraggingChanged?: (dragging: boolean) => void;
}

export type GizmoMode = "translate" | "rotate";

export class Selection {
  private readonly host: SelectionHost;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly composer: EffectComposer;
  private readonly outlinePass: OutlinePass;
  private readonly transformControls: TransformControls;

  private current: SelectionInfo | null = null;
  private gizmoMode: GizmoMode = "translate";

  /**
   * Single-instance highlight ghost for baked-loc selections that hit an
   * `InstancedMesh` or merged-loc `Mesh`. OutlinePass would otherwise
   * outline every instance/triangle of the hit mesh — bad for the user.
   *
   * The ghost is a Mesh that mirrors *just* the clicked placement; we
   * temporarily hide the original (zero-scale the instance slot, or
   * zero-vertex the merged triangles) so the ghost stands in for it
   * without Z-fighting. On deselect we restore the original. On Delete
   * we keep the original hidden (the save-store remove makes the hide
   * permanent for the session) and just discard the ghost.
   */
  private outlineGhost: OutlineGhost | null = null;

  /** Notified when the current selection changes (becomes a new mesh, or
   *  becomes null). Inspector panel listens to this. */
  onSelectionChanged: ((info: SelectionInfo | null) => void) | null = null;
  /** Notified when the gizmo updates the selected mesh's pose. Inspector
   *  numeric inputs listen so they reflect the live drag. */
  onPoseChanged: ((info: SelectionInfo) => void) | null = null;
  /** Notified when the gizmo's mode flips between translate and rotate
   *  (via T / R keys). Inspector can highlight the active toggle. */
  onGizmoModeChanged: ((mode: GizmoMode) => void) | null = null;

  constructor(host: SelectionHost) {
    this.host = host;

    this.composer = new EffectComposer(host.renderer);
    this.composer.addPass(new RenderPass(host.scene, host.camera));

    const size = host.renderer.getSize(new THREE.Vector2());
    this.outlinePass = new OutlinePass(size, host.scene, host.camera);
    // Cyan edge tuned to read against the OSRS palette (warm browns +
    // mossy greens dominate). Hidden-edge tint is dimmer so occluded
    // outlines don't glow brighter than the visible ones when the
    // selected entity is partly behind scenery.
    this.outlinePass.edgeStrength = 5.0;
    this.outlinePass.edgeGlow = 0.4;
    this.outlinePass.edgeThickness = 1.0;
    this.outlinePass.visibleEdgeColor.set("#5fdcff");
    this.outlinePass.hiddenEdgeColor.set("#1a4a5a");
    this.composer.addPass(this.outlinePass);

    this.transformControls = new TransformControls(host.camera, host.canvas);
    this.transformControls.setSize(0.8);
    this.applyGizmoMode();
    // 45° rotation snap matches the placement R-key convention. Released
    // when the user holds Shift so free-angle drag is one modifier away.
    this.transformControls.setRotationSnap(Math.PI / 4);
    // The gizmo helper is a separate Object3D returned by `getHelper()` —
    // adding `transformControls` itself doesn't render the visual handles
    // in r169.
    host.scene.add(this.transformControls.getHelper());

    this.transformControls.addEventListener("dragging-changed", (e) => {
      host.onDraggingChanged?.(Boolean((e as { value: boolean }).value));
    });
    // `objectChange` fires only when the gizmo actually moves the mesh
    // (pointerMove + post-frame `update()` while dragging). The plain
    // `change` event is noisier — it also fires when `axis` resets to
    // `null` on pointer-up, which would re-trigger our handler with
    // `axis === null`, flip `preserveY` to false, and yank a Y-lifted
    // placement back to terrain at the end of the drag. Listening to
    // `objectChange` sidesteps that.
    this.transformControls.addEventListener("objectChange", () => {
      if (!this.current || this.current.kind !== "placed") return;
      // Y-only drag bypass: while the user holds the green Y handle the
      // gizmo's `axis` is exactly "Y" (TransformControls suppresses hover
      // updates while `dragging === true`, so the value sticks for the
      // whole drag). In that case skip the surface resample so the lift
      // sticks — `onPlacementUpdated` then carries the mesh's exact Y into
      // `SavedPlacement.y` via `SaveStore.updateFromMesh`. Other axes /
      // combined drags still resample so XZ motion settles on the new tile
      // or stack.
      const mesh = this.current.ref.mesh;
      const axis = (this.transformControls as { axis?: string | null }).axis;
      const preserveY = axis === "Y";
      this.current.placer.updatePose(
        mesh,
        mesh.position,
        mesh.rotation.y,
        preserveY,
      );
      this.onPoseChanged?.(this.current);
    });

    host.canvas.addEventListener("click", (e) => this.handleClick(e));
    window.addEventListener("keydown", (e) => this.handleKey(e));
    window.addEventListener("keyup", (e) => this.handleKeyUp(e));
  }

  /** Run the composer instead of `renderer.render(...)`. Color management
   *  stays disabled at the renderer level (sRGB passthrough — see main.ts
   *  comment), so we don't add an OutputPass. */
  render(): void {
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.outlinePass.setSize(width, height);
  }

  hasSelection(): boolean {
    return this.current !== null;
  }

  getSelected(): SelectionInfo | null {
    return this.current;
  }

  deselect(): void {
    if (this.current === null) return;
    this.current = null;
    this.clearOutlineGhost(true);
    this.outlinePass.selectedObjects = [];
    this.transformControls.detach();
    this.onSelectionChanged?.(null);
  }

  /** Discard the outline ghost. When `restore` is true, also undo the
   *  temporary hide on the source mesh — used on plain deselect. Skip
   *  restore on Delete so the placement stays hidden — permanently for
   *  the session, since nothing re-bakes the bundle (see
   *  `tombstoneBakedSelection`'s doc comment). */
  private clearOutlineGhost(restore: boolean): void {
    if (!this.outlineGhost) return;
    const g = this.outlineGhost;
    this.outlineGhost = null;
    if (restore) {
      if (g.kind === "instanced") {
        g.instMesh.setMatrixAt(g.instanceId, g.savedMatrix);
        g.instMesh.instanceMatrix.needsUpdate = true;
      } else {
        // Scatter restore: each entry of `savedTriOffsets` says where its
        // 9-float chunk in `savedPositions` belongs back in the merged
        // mesh's position buffer.
        const posAttr = g.mergedMesh.geometry.attributes.position as THREE.BufferAttribute;
        const dst = posAttr.array as Float32Array;
        for (let i = 0; i < g.savedTriOffsets.length; i++) {
          const t = g.savedTriOffsets[i]!;
          const dstOff = t * 9;
          const srcOff = i * 9;
          for (let k = 0; k < 9; k++) dst[dstOff + k] = g.savedPositions[srcOff + k]!;
        }
        posAttr.needsUpdate = true;
      }
    }
    g.ghost.removeFromParent();
    g.ghost.geometry.dispose();
  }

  /** Called by main when a placer reports a removed mesh. If that mesh
   *  was selected, clear the selection so we don't outline a vanished
   *  object. No-op for baked selections (they aren't owned by placers). */
  notifyMeshRemoved(mesh: THREE.Mesh): void {
    if (this.current?.kind === "placed" && this.current.ref.mesh === mesh) {
      this.deselect();
    }
  }

  /** Re-snapshot the current selection's `PlacedRef` and fire
   *  `onSelectionChanged` so listeners (the inspector) re-render against
   *  fresh placer state. Call after async mutations like `swapAnimation`.
   *  No-op for baked selections (no placer state to refresh). */
  refresh(): void {
    if (!this.current || this.current.kind !== "placed") return;
    const placed = this.current;
    const fresh = placed.placer.getPlacements().find((r) => r.mesh === placed.ref.mesh);
    if (!fresh) {
      // Shouldn't happen — placer would have fired onMeshRemoved — but
      // bail safely if the mesh vanished between mutation and refresh.
      this.deselect();
      return;
    }
    this.current = { kind: "placed", placer: placed.placer, ref: fresh };
    this.onSelectionChanged?.(this.current);
  }

  /** Delete the current selection through the kind-appropriate path:
   *  placed → placer.removeMesh, baked → tombstone in the save store +
   *  hide the slot/triangles. Used by the inspector panel's Delete
   *  button so the same button works for both selection kinds. */
  deleteSelection(): void {
    if (!this.current) return;
    if (this.current.kind === "placed") {
      this.current.placer.removeMesh(this.current.ref.mesh);
    } else {
      this.tombstoneBakedSelection();
    }
  }

  /** Set the gizmo mode programmatically. Inspector toggle calls this. */
  setGizmoMode(mode: GizmoMode): void {
    if (this.gizmoMode === mode) return;
    this.gizmoMode = mode;
    this.applyGizmoMode();
    this.onGizmoModeChanged?.(mode);
  }

  private applyGizmoMode(): void {
    this.transformControls.setMode(this.gizmoMode);
    if (this.gizmoMode === "translate") {
      // All three axes available. Dragging X/Z still triggers a terrain
      // re-clamp (placements settle on the new tile / new stack); dragging
      // Y bypasses the clamp and writes `position.y` straight through so
      // the user can lift a stack manually — see `updatePose`'s doc
      // comment in `modelPlacer.ts` for where that Y ends up persisted.
      // The bypass is implemented in the change handler below by checking
      // `transformControls.axis`.
      this.transformControls.showX = true;
      this.transformControls.showY = true;
      this.transformControls.showZ = true;
    } else {
      // Rotate around Y only — placements stand upright.
      this.transformControls.showX = false;
      this.transformControls.showY = true;
      this.transformControls.showZ = false;
    }
  }

  private handleClick(e: MouseEvent): void {
    if (this.host.isAnyToolArmed()) return;
    // Shift-click belongs to the placer's quick-delete path.
    if (e.shiftKey) return;

    this.updateNdc(e);
    this.raycaster.setFromCamera(this.ndc, this.host.camera);

    const placers = this.host.getPlacers();
    const regions = this.host.getRegions();
    // Raycast both placer groups and region locsGroups in one pass so the
    // closest hit wins regardless of which kind it is. Terrain is
    // intentionally excluded — clicking bare ground deselects.
    const targets: THREE.Object3D[] = placers.map((p) => p.getSceneGroup());
    for (const r of regions) targets.push(r.locsGroup);
    const hits = this.raycaster.intersectObjects(targets, true);

    for (const hit of hits) {
      // Ghost preview meshes share the placer group but aren't placements.
      if (hit.object.name.endsWith(":ghost")) continue;
      const owner = ownerForMesh(placers, hit.object);
      if (owner) {
        const ref = owner.getPlacements().find((r) => r.mesh === hit.object);
        if (!ref) continue;
        this.selectPlaced(owner, ref);
        return;
      }
      // Try baked-loc resolution — the hit might live under a region's
      // locsGroup (either an InstancedMesh or the merged-loc Mesh).
      const region = findOwningRegion(regions, hit.object);
      if (!region) continue;
      const locHit = resolveLocHit(hit, region.locsManifest);
      if (!locHit) continue;
      this.selectBaked(region.regionId, locHit);
      return;
    }

    // Click landed on terrain or empty space — clear.
    this.deselect();
  }

  private selectPlaced(placer: Placer, ref: PlacedRef): void {
    this.current = { kind: "placed", placer, ref };
    this.outlinePass.selectedObjects = [ref.mesh];
    this.transformControls.attach(ref.mesh);
    this.onSelectionChanged?.(this.current);
  }

  private selectBaked(regionId: number, locHit: LocHit): void {
    this.clearOutlineGhost(true);
    this.current = { kind: "baked", regionId, locHit };
    // Build a single-instance ghost so OutlinePass outlines just the
    // clicked placement, not every instance/triangle of the parent mesh.
    const ghost = makeOutlineGhost(locHit);
    if (ghost) {
      this.outlineGhost = ghost;
      this.outlinePass.selectedObjects = [ghost.ghost];
    } else {
      // Fallback: outline the whole parent mesh. Shouldn't happen with
      // current placeLocs but keeps selection working if the mesh shape
      // changes.
      this.outlinePass.selectedObjects = [locHit.mesh];
    }
    // No gizmo for baked locs — moving them is out of scope for v1.
    // Detach any prior gizmo so it doesn't linger from a previous
    // placed-selection.
    this.transformControls.detach();
    this.onSelectionChanged?.(this.current);
  }

  private handleKey(e: KeyboardEvent): void {
    // Escape always deselects, regardless of focus.
    if (e.key === "Escape" && this.current !== null) {
      this.deselect();
      return;
    }
    if (this.current === null) return;
    // Skip per-selection hotkeys when the user is typing in a form field —
    // otherwise typing "T" or pressing Backspace in a search box flips
    // the gizmo or deletes the selected entity.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      // Shift-snap toggle still applies — gizmo drag is canvas-driven and
      // shouldn't care where focus is.
      if (e.key === "Shift") this.transformControls.setRotationSnap(null);
      return;
    }
    if (e.key === "t" || e.key === "T") {
      this.setGizmoMode("translate");
      return;
    }
    if (e.key === "r" || e.key === "R") {
      this.setGizmoMode("rotate");
      return;
    }
    if (e.key === "Shift") {
      // Free-angle while held — null disables snap entirely.
      this.transformControls.setRotationSnap(null);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      // Backspace doubles as browser back-nav on some setups; cancel the
      // default so we never lose the page.
      e.preventDefault();
      if (this.current.kind === "placed") {
        this.current.placer.removeMesh(this.current.ref.mesh);
      } else {
        this.tombstoneBakedSelection();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
      // Cmd/Ctrl+D defaults to "bookmark page" — preventDefault for both
      // mac (cmd) and windows/linux (ctrl) so we always run duplicate.
      // No baked-loc duplicate: cloning a baked placement would need a new
      // placement-ID synth path that v1 doesn't have. Use the Object placer
      // to add a fresh placement instead.
      if (this.current.kind !== "placed") return;
      e.preventDefault();
      this.current.placer.duplicate(this.current.ref.mesh);
      return;
    }
    if (e.key.startsWith("Arrow")) {
      // Nudge is a placed-only feature (it goes through `placer.updatePose`).
      if (this.current.kind !== "placed") return;
      e.preventDefault();
      this.nudge(e.key, e.shiftKey);
      return;
    }
  }

  /**
   * Record the baked selection as a "remove" in the save store and hide it
   * from the scene immediately — the hide is permanent for the session
   * (and for any future load of this save) since nothing re-bakes the
   * bundle. Visual feedback differs by mesh kind:
   *   - InstancedMesh: zero-scale + sink the matrix at this slot. Cheap;
   *     the slot stays allocated and re-render produces no fragments.
   *   - merged Mesh: zero out the affected triangles' vertex positions in
   *     place. The merged buffer is owned by the mesh (placeLocs mints a
   *     fresh Float32Array), so direct mutation is safe.
   */
  private tombstoneBakedSelection(): void {
    if (!this.current || this.current.kind !== "baked") return;
    const { regionId, locHit } = this.current;
    if (locHit.placementIdHex === null) {
      // Bundle predates the placementIds blob — can't tombstone. Surface
      // a console warning rather than silently noop'ing so the user knows
      // why their delete didn't take.
      console.warn(
        `[selection] cannot delete baked loc — region ${regionId} bundle has no placementIds (re-extract to upgrade)`,
      );
      return;
    }
    this.host.saveStore.addRemove(regionId, locHit.placementIdHex);
    // The outline ghost has already hidden the source instance/triangles
    // for visual feedback (see selectBaked). For Delete we keep that hide
    // in place — drop the ghost without restoring.
    this.clearOutlineGhost(false);
    // Defensive — if no ghost was active for this hit (fallback path),
    // do the hide ourselves so the deletion still has visual feedback.
    if (!this.outlineGhost) {
      if (locHit.mesh instanceof THREE.InstancedMesh && locHit.instanceId !== null) {
        hideInstancedSlot(locHit.mesh, locHit.instanceId);
      } else if (locHit.mesh instanceof THREE.Mesh) {
        hideMergedTriangles(locHit.mesh, locHit.placementIdx);
      }
    }
    // Now clear the rest of the selection state without re-restoring.
    this.current = null;
    this.outlinePass.selectedObjects = [];
    this.transformControls.detach();
    this.onSelectionChanged?.(null);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === "Shift") {
      this.transformControls.setRotationSnap(Math.PI / 4);
    }
  }

  /** Move the selection by ±TILE_SIZE on X / Z, with Shift dropping the
   *  step to a single world unit for fine alignment. World axes:
   *    ↑ = north (−Z), ↓ = south (+Z), ← = west (−X), → = east (+X).
   *  Placed-only — caller already narrowed. */
  private nudge(key: string, shift: boolean): void {
    if (!this.current || this.current.kind !== "placed") return;
    const step = shift ? 1 : TILE_SIZE;
    const mesh = this.current.ref.mesh;
    const next = mesh.position.clone();
    if (key === "ArrowLeft") next.x -= step;
    else if (key === "ArrowRight") next.x += step;
    else if (key === "ArrowUp") next.z -= step;
    else if (key === "ArrowDown") next.z += step;
    else return;
    this.current.placer.updatePose(mesh, next, mesh.rotation.y);
    this.onPoseChanged?.(this.current);
  }

  private updateNdc(e: MouseEvent): void {
    const rect = this.host.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  }
}

/** Resolve which placer owns a hit mesh. The placer groups are flat (one
 *  level: group → mesh), so a direct child check is enough. */
function ownerForMesh(placers: Placer[], obj: THREE.Object3D): Placer | null {
  for (const p of placers) {
    if (obj.parent === p.getSceneGroup()) return p;
  }
  return null;
}

/** Walk up the scene graph until we hit a node whose `userData.regionId`
 *  matches one of the loaded regions. Each region's locsGroup carries
 *  this stamp (set in `main.setupRegion`). Returns null if the hit
 *  belongs to no known region. */
function findOwningRegion(
  regions: SelectionRegion[],
  obj: THREE.Object3D,
): SelectionRegion | null {
  let p: THREE.Object3D | null = obj;
  while (p) {
    const rid = (p.userData as { regionId?: number }).regionId;
    if (rid !== undefined) {
      const r = regions.find((x) => x.regionId === rid);
      if (r) return r;
    }
    p = p.parent;
  }
  return null;
}


/** Outline-ghost record — see Selection.outlineGhost. Discriminated by
 *  source mesh kind so restore knows whether to re-set an instance matrix
 *  or write back triangle vertices. */
type OutlineGhost =
  | {
      kind: "instanced";
      ghost: THREE.Mesh;
      instMesh: THREE.InstancedMesh;
      instanceId: number;
      savedMatrix: THREE.Matrix4;
    }
  | {
      kind: "merged";
      ghost: THREE.Mesh;
      mergedMesh: THREE.Mesh;
      /** Snapshot of the affected triangles' position floats, packed
       *  contiguously (`savedTriOffsets[i]` records where the i-th
       *  9-float chunk belongs back in `mergedMesh.geometry.position`). */
      savedPositions: Float32Array;
      savedTriOffsets: Uint32Array;
    };

/**
 * Build a single-instance outline ghost for a baked-loc hit and
 * temporarily hide the source so the ghost stands in cleanly. Returns
 * null if the hit doesn't fit either supported mesh shape (defensive —
 * shouldn't happen with current placeLocs output).
 */
function makeOutlineGhost(locHit: LocHit): OutlineGhost | null {
  // Outline-ghost material: colorWrite + depthWrite off, fully transparent
  // — the mesh stays in the scene graph for OutlinePass to traverse, but
  // contributes no fragments to the main render so we don't double-draw
  // over the underlying loc geometry. OutlinePass uses an override
  // material + its own depth pre-pass, so it picks up the silhouette
  // regardless of what the regular material does.
  const ghostMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
    side: THREE.DoubleSide,
  });

  if (locHit.mesh instanceof THREE.InstancedMesh && locHit.instanceId !== null) {
    const inst = locHit.mesh;
    const savedMatrix = new THREE.Matrix4();
    inst.getMatrixAt(locHit.instanceId, savedMatrix);

    // Ghost = a non-instanced Mesh with the same geometry, parented under
    // the same group as the InstancedMesh so the regional offset (set on
    // locsGroup) carries automatically. Apply the saved matrix as the
    // ghost's local pose.
    const ghost = new THREE.Mesh(inst.geometry.clone(), ghostMat);
    ghost.matrixAutoUpdate = false;
    ghost.matrix.copy(savedMatrix);
    ghost.matrixWorldNeedsUpdate = true;
    ghost.name = `selection-ghost:${inst.name}:${locHit.instanceId}`;
    inst.parent?.add(ghost);

    // Hide the source slot so the ghost doesn't double up.
    hideInstancedSlot(inst, locHit.instanceId);

    return {
      kind: "instanced",
      ghost,
      instMesh: inst,
      instanceId: locHit.instanceId,
      savedMatrix,
    };
  }

  if (locHit.mesh instanceof THREE.Mesh) {
    const mergedMesh = locHit.mesh;
    const placementByTri = (mergedMesh.userData as { placementByTri?: Uint32Array })
      .placementByTri;
    if (!placementByTri) return null;

    // Find every triangle in this merged mesh that belongs to the clicked
    // placement. There's no guarantee they're contiguous in the buffer
    // (placeLocs concatenates by placement, but blocks may share verts);
    // walk the whole array to be safe.
    const targetIdx = locHit.placementIdx;
    const triOffsetsList: number[] = [];
    for (let t = 0; t < placementByTri.length; t++) {
      if (placementByTri[t] === targetIdx) triOffsetsList.push(t);
    }
    if (triOffsetsList.length === 0) return null;

    const srcPos = (mergedMesh.geometry.attributes.position as THREE.BufferAttribute)
      .array as Float32Array;
    const srcCol = (mergedMesh.geometry.attributes.color as THREE.BufferAttribute)
      .array as Uint8Array;
    const srcUv = (mergedMesh.geometry.attributes.uv as THREE.BufferAttribute)
      .array as Float32Array;

    const ghostFloats = new Float32Array(triOffsetsList.length * 9);
    const ghostColors = new Uint8Array(triOffsetsList.length * 12);
    const ghostUvs = new Float32Array(triOffsetsList.length * 6);
    // Snapshot the affected positions so restore can put them back. Stored
    // as a single flat Float32Array; `savedTriOffsets` records where each
    // chunk lived in the source buffer.
    const savedPositions = new Float32Array(triOffsetsList.length * 9);
    const savedTriOffsets = new Uint32Array(triOffsetsList.length);

    for (let i = 0; i < triOffsetsList.length; i++) {
      const t = triOffsetsList[i]!;
      const srcOff = t * 9;
      const srcColOff = t * 12;
      const srcUvOff = t * 6;
      const dstOff = i * 9;
      const dstColOff = i * 12;
      const dstUvOff = i * 6;
      for (let k = 0; k < 9; k++) {
        ghostFloats[dstOff + k] = srcPos[srcOff + k]!;
        savedPositions[dstOff + k] = srcPos[srcOff + k]!;
      }
      for (let k = 0; k < 12; k++) ghostColors[dstColOff + k] = srcCol[srcColOff + k]!;
      for (let k = 0; k < 6; k++) ghostUvs[dstUvOff + k] = srcUv[srcUvOff + k]!;
      savedTriOffsets[i] = t;
    }

    const ghostGeom = new THREE.BufferGeometry();
    ghostGeom.setAttribute("position", new THREE.BufferAttribute(ghostFloats, 3));
    ghostGeom.setAttribute("color", new THREE.BufferAttribute(ghostColors, 4, true));
    ghostGeom.setAttribute("uv", new THREE.BufferAttribute(ghostUvs, 2));
    const ghost = new THREE.Mesh(ghostGeom, ghostMat);
    ghost.name = `selection-ghost:${mergedMesh.name}:${targetIdx}`;
    mergedMesh.parent?.add(ghost);

    // Hide the source triangles so the ghost stands in cleanly. We can't
    // use the same flat-snapshot trick for restore because the affected
    // tri offsets are scattered — store both arrays and restore one
    // triangle at a time.
    const dstPos = srcPos;
    for (const t of triOffsetsList) {
      const off = t * 9;
      dstPos[off + 0] = 0; dstPos[off + 1] = SUNK_Y; dstPos[off + 2] = 0;
      dstPos[off + 3] = 0; dstPos[off + 4] = SUNK_Y; dstPos[off + 5] = 0;
      dstPos[off + 6] = 0; dstPos[off + 7] = SUNK_Y; dstPos[off + 8] = 0;
    }
    (mergedMesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // Pack a custom restore record — `savedPositions` is *parallel to
    // savedTriOffsets*, so restore must use those offsets, not a single
    // slice. We expose them through the OutlineGhost record; the
    // clearOutlineGhost path knows to scatter-restore.
    return {
      kind: "merged",
      ghost,
      mergedMesh,
      savedPositions,
      savedTriOffsets,
    };
  }

  return null;
}


