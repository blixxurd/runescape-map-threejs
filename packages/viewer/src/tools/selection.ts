import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { TILE_SIZE } from "@rsmap/shared";
import type { Placer, PlacedRef } from "./placerTypes.js";

/**
 * Selection v1: click-to-select user-placed entities (NPCs / objects /
 * items). Owns the cyan OutlinePass that highlights the current selection
 * and the click+Esc handlers that drive selection state.
 *
 * Activation model: when no placer is armed, plain click selects the
 * placement under the cursor; click on bare terrain (or any miss) clears
 * the selection. Shift-click is reserved for the placer's quick-delete
 * path — selection ignores it. Arming any placer auto-deselects via main
 * (selection.deselect() called from cancelOthers).
 *
 * Render lifecycle: this class owns an `EffectComposer` because the
 * outline edge is drawn as a post-pass. Callers replace
 * `renderer.render(scene, camera)` with `selection.render()` and proxy
 * canvas resize through `selection.setSize(w, h)`.
 */

export interface SelectionInfo {
  placer: Placer;
  ref: PlacedRef;
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
    this.transformControls.addEventListener("change", () => {
      if (!this.current) return;
      // Have the placer apply terrain Y-clamp + contour redeform; the
      // mesh's position/rotation were already mutated by the gizmo, so
      // we just feed them back through.
      const mesh = this.current.ref.mesh;
      this.current.placer.updatePose(mesh, mesh.position, mesh.rotation.y);
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
    this.outlinePass.selectedObjects = [];
    this.transformControls.detach();
    this.onSelectionChanged?.(null);
  }

  /** Called by main when a placer reports a removed mesh. If that mesh
   *  was selected, clear the selection so we don't outline a vanished
   *  object. */
  notifyMeshRemoved(mesh: THREE.Mesh): void {
    if (this.current?.ref.mesh === mesh) this.deselect();
  }

  /** Re-snapshot the current selection's `PlacedRef` and fire
   *  `onSelectionChanged` so listeners (the inspector) re-render against
   *  fresh placer state. Call after async mutations like `swapAnimation`. */
  refresh(): void {
    if (!this.current) return;
    const fresh = this.current.placer
      .getPlacements()
      .find((r) => r.mesh === this.current!.ref.mesh);
    if (!fresh) {
      // Shouldn't happen — placer would have fired onMeshRemoved — but
      // bail safely if the mesh vanished between mutation and refresh.
      this.deselect();
      return;
    }
    this.current = { placer: this.current.placer, ref: fresh };
    this.onSelectionChanged?.(this.current);
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
      // XZ ground-plane only; Y is owned by the terrain sampler.
      this.transformControls.showX = true;
      this.transformControls.showY = false;
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
    const groups = placers.map((p) => p.getSceneGroup());
    const hits = this.raycaster.intersectObjects(groups, true);

    for (const hit of hits) {
      // Ghost preview meshes share the placer group but aren't placements.
      if (hit.object.name.endsWith(":ghost")) continue;
      const owner = ownerForMesh(placers, hit.object);
      if (!owner) continue;
      const ref = owner.getPlacements().find((r) => r.mesh === hit.object);
      if (!ref) continue;
      this.select(owner, ref);
      return;
    }

    // Click landed on terrain or empty space — clear.
    this.deselect();
  }

  private select(placer: Placer, ref: PlacedRef): void {
    this.current = { placer, ref };
    this.outlinePass.selectedObjects = [ref.mesh];
    this.transformControls.attach(ref.mesh);
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
      this.current.placer.removeMesh(this.current.ref.mesh);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
      // Cmd/Ctrl+D defaults to "bookmark page" — preventDefault for both
      // mac (cmd) and windows/linux (ctrl) so we always run duplicate.
      e.preventDefault();
      this.current.placer.duplicate(this.current.ref.mesh);
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      this.nudge(e.key, e.shiftKey);
      return;
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (e.key === "Shift") {
      this.transformControls.setRotationSnap(Math.PI / 4);
    }
  }

  /** Move the selection by ±TILE_SIZE on X / Z, with Shift dropping the
   *  step to a single world unit for fine alignment. World axes:
   *    ↑ = north (−Z), ↓ = south (+Z), ← = west (−X), → = east (+X). */
  private nudge(key: string, shift: boolean): void {
    if (!this.current) return;
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
