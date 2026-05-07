import * as THREE from "three";
import type { Selection, GizmoMode, SelectionInfo } from "./selection.js";
import type { PlacedRef } from "./placerTypes.js";
import type { LocHit } from "./locResolve.js";

/**
 * Floating, draggable inspector for the currently-selected placement.
 *
 * Mirrors the gizmo's pose into numeric inputs (X / Z / rotation) and
 * exposes per-type fields:
 *   - NPC: animation override dropdown (driven by the NPC def's
 *     `availableAnimations`).
 *   - Translate / Rotate gizmo-mode toggle (mirrors keyboard T / R).
 *   - Delete + Duplicate buttons (also accessible via shortcuts in #8).
 *
 * The panel re-renders on every `Selection.onSelectionChanged` and updates
 * the position/rotation fields on `Selection.onPoseChanged` (so live gizmo
 * drags reflect in the numeric fields without a full re-render).
 *
 * Anchored bottom-right by default; the title bar is a drag handle. Hidden
 * when nothing is selected.
 */

export interface InspectorPanelHost {
  selection: Selection;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #inspectorPanel {
      position: fixed; right: 8px; bottom: 8px; width: 280px;
      background: rgba(0,0,0,0.88); color: #d5dce8;
      border: 1px solid #2a334a; border-radius: 4px;
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 25; display: none; flex-direction: column;
    }
    #inspectorPanel.visible { display: flex; }
    #inspectorPanel .head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 8px; border-bottom: 1px solid #2a334a;
      color: #5fdcff; font-weight: bold; cursor: grab; user-select: none;
    }
    #inspectorPanel .head.dragging { cursor: grabbing; }
    #inspectorPanel .head .id-tag {
      font-weight: normal; color: #8f9bb5; margin-left: 6px;
    }
    #inspectorPanel .head .close {
      background: transparent; border: none; color: #8f9bb5;
      font: inherit; cursor: pointer; padding: 0 4px;
    }
    #inspectorPanel .head .close:hover { color: #e6e8ec; }
    #inspectorPanel .body {
      padding: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    #inspectorPanel .row {
      display: flex; align-items: center; gap: 6px;
    }
    #inspectorPanel .row label {
      width: 36px; color: #8f9bb5; flex-shrink: 0;
    }
    #inspectorPanel input[type="number"], #inspectorPanel select {
      flex: 1; min-width: 0;
      background: #10131d; color: #e6e8ec;
      border: 1px solid #2a334a; border-radius: 3px;
      padding: 3px 6px; font: inherit; outline: none;
    }
    #inspectorPanel input[type="number"]:focus,
    #inspectorPanel select:focus { border-color: #5fdcff; }
    #inspectorPanel .row .ro {
      flex: 1; color: #d5dce8; padding: 3px 6px;
      background: #10131d; border: 1px solid #1f2638; border-radius: 3px;
      font-variant-numeric: tabular-nums;
    }
    #inspectorPanel .step-btns {
      display: flex; gap: 4px;
    }
    #inspectorPanel button.action {
      background: #14192a; border: 1px solid #2a334a; color: #d5dce8;
      font: inherit; padding: 3px 8px; border-radius: 3px; cursor: pointer;
    }
    #inspectorPanel button.action:hover { background: #1a2138; border-color: #5fdcff; }
    #inspectorPanel button.action.danger { border-color: #5a3030; color: #d8a0a0; }
    #inspectorPanel button.action.danger:hover { border-color: #a04848; color: #e8c0c0; }
    #inspectorPanel button.action.toggle.active {
      background: #1a3a4a; border-color: #5fdcff; color: #d4f4ff;
    }
    #inspectorPanel .actions {
      display: flex; gap: 6px; margin-top: 4px;
    }
    #inspectorPanel .actions > button { flex: 1; }
    #inspectorPanel .hint {
      color: #8f9bb5; font-size: 10.5px; line-height: 1.4;
      padding: 4px 6px; background: rgba(8,10,16,0.5);
      border-left: 2px solid #2a334a; border-radius: 2px;
    }
    #inspectorPanel .hint b { color: #d5dce8; }
  `;
  document.head.appendChild(style);
}

export class InspectorPanel {
  private readonly host: InspectorPanelHost;
  private readonly root: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly body: HTMLDivElement;

  private xInput!: HTMLInputElement;
  private zInput!: HTMLInputElement;
  private rotInput!: HTMLInputElement;
  private translateBtn!: HTMLButtonElement;
  private rotateBtn!: HTMLButtonElement;
  /** Suppresses the input listener while we programmatically update the
   *  field values from a gizmo drag. Without this, `setValue` would round-
   *  trip back through `applyPose` and we'd race ourselves. */
  private suppressInput = false;

  constructor(host: InspectorPanelHost) {
    this.host = host;
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "inspectorPanel";
    this.root.innerHTML = `
      <div class="head">
        <span class="title">selection</span>
        <button class="close" type="button" title="deselect (esc)">×</button>
      </div>
      <div class="body"></div>
    `;
    document.body.appendChild(this.root);
    this.head = this.root.querySelector<HTMLDivElement>(".head")!;
    this.body = this.root.querySelector<HTMLDivElement>(".body")!;

    this.root
      .querySelector<HTMLButtonElement>(".close")!
      .addEventListener("click", () => host.selection.deselect());

    this.wireDrag();
  }

  /** Subscriber-style entry points called from main's wiring layer. The
   *  panel is a passive view — main fans `Selection.onXxx` events out to
   *  these methods so other listeners (HUD gating) stay in the loop. */
  handleSelectionChanged(info: SelectionInfo | null): void {
    if (!info) {
      this.root.classList.remove("visible");
      return;
    }
    if (info.kind === "placed") {
      this.renderPlaced(info.ref);
    } else {
      this.renderBaked(info.regionId, info.locHit);
    }
    this.root.classList.add("visible");
  }

  handlePoseChanged(info: SelectionInfo): void {
    // Only placed-selection poses change live (baked has no gizmo).
    if (info.kind !== "placed") return;
    this.updateFromPose(info.ref);
  }

  handleGizmoModeChanged(mode: GizmoMode): void {
    this.applyModeButtons(mode);
  }

  private renderPlaced(ref: PlacedRef): void {
    const { mesh } = ref;
    const titleEl = this.head.querySelector<HTMLSpanElement>(".title")!;
    titleEl.textContent = `${kindLabel(ref.kind)}: ${stripOsrsTags(ref.name)}`;
    titleEl.title = ref.name;

    // Replace any prior id-tag.
    this.head.querySelector(".id-tag")?.remove();
    const idTag = document.createElement("span");
    idTag.className = "id-tag";
    idTag.textContent = `#${ref.id}`;
    titleEl.after(idTag);

    this.body.innerHTML = "";

    // --- Position (XZ — Y is terrain-clamped, no input).
    const xRow = makeNumberRow("X", mesh.position.x, (v) => this.applyPose({ x: v }));
    const zRow = makeNumberRow("Z", mesh.position.z, (v) => this.applyPose({ z: v }));
    this.xInput = xRow.input;
    this.zInput = zRow.input;
    this.body.appendChild(xRow.row);
    this.body.appendChild(zRow.row);

    // --- Rotation (free-angle degrees + 45° steppers).
    const rotRow = document.createElement("div");
    rotRow.className = "row";
    rotRow.innerHTML = `<label>rot°</label>`;
    const rotInput = document.createElement("input");
    rotInput.type = "number";
    rotInput.step = "1";
    rotInput.value = String(Math.round(radToDeg(mesh.rotation.y)));
    rotInput.addEventListener("input", () => {
      if (this.suppressInput) return;
      const deg = Number(rotInput.value);
      if (Number.isFinite(deg)) this.applyPose({ rotationRad: degToRad(deg) });
    });
    rotInput.addEventListener("keydown", (e) => e.stopPropagation());
    rotRow.appendChild(rotInput);
    const stepLeft = document.createElement("button");
    stepLeft.className = "action";
    stepLeft.type = "button";
    stepLeft.textContent = "−45°";
    stepLeft.addEventListener("click", () => this.stepRotation(-Math.PI / 4));
    const stepRight = document.createElement("button");
    stepRight.className = "action";
    stepRight.type = "button";
    stepRight.textContent = "+45°";
    stepRight.addEventListener("click", () => this.stepRotation(Math.PI / 4));
    const stepWrap = document.createElement("div");
    stepWrap.className = "step-btns";
    stepWrap.appendChild(stepLeft);
    stepWrap.appendChild(stepRight);
    rotRow.appendChild(stepWrap);
    this.rotInput = rotInput;
    this.body.appendChild(rotRow);

    // --- Gizmo mode toggle (mirrors T / R hotkeys).
    const modeRow = document.createElement("div");
    modeRow.className = "row";
    modeRow.innerHTML = `<label>gizmo</label>`;
    const tBtn = document.createElement("button");
    tBtn.className = "action toggle";
    tBtn.type = "button";
    tBtn.textContent = "translate (T)";
    tBtn.addEventListener("click", () => this.host.selection.setGizmoMode("translate"));
    const rBtn = document.createElement("button");
    rBtn.className = "action toggle";
    rBtn.type = "button";
    rBtn.textContent = "rotate (R)";
    rBtn.addEventListener("click", () => this.host.selection.setGizmoMode("rotate"));
    const modeWrap = document.createElement("div");
    modeWrap.className = "step-btns";
    modeWrap.style.flex = "1";
    modeWrap.appendChild(tBtn);
    modeWrap.appendChild(rBtn);
    modeRow.appendChild(modeWrap);
    this.translateBtn = tBtn;
    this.rotateBtn = rBtn;
    this.body.appendChild(modeRow);
    this.applyModeButtons("translate");

    // --- NPC animation override (only when the def has alternates).
    if (
      ref.kind === "npc" &&
      ref.availableAnimations &&
      ref.availableAnimations.length > 1
    ) {
      const animRow = document.createElement("div");
      animRow.className = "row";
      animRow.innerHTML = `<label>anim</label>`;
      const select = document.createElement("select");
      for (const a of ref.availableAnimations) {
        const opt = document.createElement("option");
        opt.value = String(a.id);
        opt.textContent = `${a.label} (#${a.id})`;
        if (a.id === ref.animationId) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        const animId = Number(select.value);
        if (!Number.isFinite(animId)) return;
        const sel = this.host.selection.getSelected();
        if (!sel || sel.kind !== "placed" || !sel.placer.swapAnimation) return;
        void sel.placer.swapAnimation(sel.ref.mesh, animId).then(() => {
          this.host.selection.refresh();
        });
      });
      select.addEventListener("keydown", (e) => e.stopPropagation());
      animRow.appendChild(select);
      this.body.appendChild(animRow);
    }

    // --- Delete + Duplicate.
    const actions = document.createElement("div");
    actions.className = "actions";
    const dupBtn = document.createElement("button");
    dupBtn.className = "action";
    dupBtn.type = "button";
    dupBtn.textContent = "duplicate";
    dupBtn.title = "duplicate at same pose (cmd/ctrl+D)";
    dupBtn.addEventListener("click", () => {
      const sel = this.host.selection.getSelected();
      if (sel?.kind === "placed") sel.placer.duplicate(sel.ref.mesh);
    });
    const delBtn = document.createElement("button");
    delBtn.className = "action danger";
    delBtn.type = "button";
    delBtn.textContent = "delete";
    delBtn.title = "delete (delete / backspace)";
    delBtn.addEventListener("click", () => this.host.selection.deleteSelection());
    actions.appendChild(dupBtn);
    actions.appendChild(delBtn);
    this.body.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.innerHTML =
      `<b>T</b>/<b>R</b> gizmo mode · <b>shift</b> free-angle rotate · ` +
      `<b>arrows</b> nudge tile · <b>shift+arrows</b> 1u · <b>esc</b> deselect`;
    this.body.appendChild(hint);
  }

  /** Update existing input values from a fresh pose without re-building
   *  the DOM. Called from `onPoseChanged` so live gizmo drags don't
   *  flicker by replacing focused inputs. */
  private updateFromPose(ref: PlacedRef): void {
    if (!this.root.classList.contains("visible")) return;
    const { mesh } = ref;
    this.suppressInput = true;
    if (this.xInput && document.activeElement !== this.xInput) {
      this.xInput.value = mesh.position.x.toFixed(2);
    }
    if (this.zInput && document.activeElement !== this.zInput) {
      this.zInput.value = mesh.position.z.toFixed(2);
    }
    if (this.rotInput && document.activeElement !== this.rotInput) {
      this.rotInput.value = String(Math.round(radToDeg(mesh.rotation.y)));
    }
    this.suppressInput = false;
  }

  private applyModeButtons(mode: GizmoMode): void {
    if (!this.translateBtn || !this.rotateBtn) return;
    this.translateBtn.classList.toggle("active", mode === "translate");
    this.rotateBtn.classList.toggle("active", mode === "rotate");
  }

  /** Push a delta-pose through the placer's `updatePose`. Caller passes
   *  only the fields they're changing; everything else stays at the
   *  current mesh value. */
  private applyPose(patch: { x?: number; z?: number; rotationRad?: number }): void {
    const sel = this.host.selection.getSelected();
    if (!sel || sel.kind !== "placed") return;
    const mesh = sel.ref.mesh;
    const next = new THREE.Vector3(
      patch.x ?? mesh.position.x,
      mesh.position.y,
      patch.z ?? mesh.position.z,
    );
    const rot = patch.rotationRad ?? mesh.rotation.y;
    sel.placer.updatePose(mesh, next, rot);
  }

  private stepRotation(delta: number): void {
    const sel = this.host.selection.getSelected();
    if (!sel || sel.kind !== "placed") return;
    const mesh = sel.ref.mesh;
    // Snap the post-step value to the nearest 45° so chained steps stay
    // tidy even if the user free-angled mid-edit. Without the snap, a
    // 17°-then-+45° sequence ends at 62° rather than 45°.
    const snapped = Math.round((mesh.rotation.y + delta) / (Math.PI / 4)) * (Math.PI / 4);
    sel.placer.updatePose(mesh, mesh.position, snapped);
    if (this.rotInput) this.rotInput.value = String(Math.round(radToDeg(snapped)));
  }

  /**
   * Read-only inspector for a baked-loc selection. v1 supports Delete only —
   * the placement gets tombstoned in `pendingEdits` so the next "commit"
   * removes it from the bundle. Editing position/rotation isn't wired up
   * (v1 scope: delete-baked + add-fresh, no baked-loc moves). Use the
   * Object placer to add a fresh placement at the new location instead.
   */
  private renderBaked(regionId: number, locHit: LocHit): void {
    const titleEl = this.head.querySelector<HTMLSpanElement>(".title")!;
    const placement = locHit.placement;
    titleEl.textContent = `baked loc #${locHit.locId}`;
    titleEl.title = `baked loc ${locHit.locId} in region ${regionId}`;

    this.head.querySelector(".id-tag")?.remove();
    const idTag = document.createElement("span");
    idTag.className = "id-tag";
    idTag.textContent = `region ${regionId}`;
    titleEl.after(idTag);

    this.body.innerHTML = "";

    // Read-only summary rows.
    const lines: Array<[string, string]> = [
      ["plane", String(placement.plane)],
      ["tile", `(${placement.x}, ${placement.z})`],
      ["type", String(placement.origType)],
      ["rot", `${placement.origRotation} (${placement.origRotation * 90}°)`],
    ];
    if (locHit.placementIdHex !== null) {
      lines.push(["id", locHit.placementIdHex]);
    }
    for (const [label, value] of lines) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<label>${label}</label><span class="ro">${value}</span>`;
      this.body.appendChild(row);
    }

    if (locHit.instancedSiblingCount > 1) {
      const note = document.createElement("div");
      note.className = "hint";
      note.innerHTML =
        `<b>1 of ${locHit.instancedSiblingCount}</b> identical placements share ` +
        `this InstancedMesh. The outline is a known v1 limitation; deletion ` +
        `still targets exactly the clicked instance.`;
      this.body.appendChild(note);
    }

    // Delete: tombstones the placement via the pending-edits store.
    const actions = document.createElement("div");
    actions.className = "actions";
    const delBtn = document.createElement("button");
    delBtn.className = "action danger";
    delBtn.type = "button";
    delBtn.textContent = "delete";
    delBtn.title = "tombstone for next commit (delete / backspace)";
    if (locHit.placementIdHex === null) {
      delBtn.disabled = true;
      delBtn.title = "this bundle has no placementIds — re-extract to enable";
    }
    delBtn.addEventListener("click", () => this.host.selection.deleteSelection());
    actions.appendChild(delBtn);
    this.body.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.innerHTML =
      `Edits stay in-session until you click <b>commit</b>. ` +
      `Reload without committing to discard.`;
    this.body.appendChild(hint);

    // Clear placed-only field refs so live-pose handlers (`updateFromPose`)
    // no-op cleanly if they fire after a baked re-render — TS narrowing
    // can't see this so we reassign explicitly.
    this.xInput = undefined as unknown as HTMLInputElement;
    this.zInput = undefined as unknown as HTMLInputElement;
    this.rotInput = undefined as unknown as HTMLInputElement;
    this.translateBtn = undefined as unknown as HTMLButtonElement;
    this.rotateBtn = undefined as unknown as HTMLButtonElement;
  }

  /** Drag-the-head-bar to move the panel. Standard PointerEvent dance —
   *  capture pointer on down, follow on move, release on up. */
  private wireDrag(): void {
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragging = false;
    this.head.addEventListener("pointerdown", (e) => {
      // Don't start a drag when clicking the close button.
      if ((e.target as HTMLElement).closest(".close")) return;
      dragging = true;
      this.head.classList.add("dragging");
      const rect = this.root.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      this.head.setPointerCapture(e.pointerId);
    });
    this.head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      // Pin via top/left so we override the default bottom-right anchor
      // once the user has dragged. `right`/`bottom` cleared so they don't
      // fight the new top/left.
      this.root.style.right = "auto";
      this.root.style.bottom = "auto";
      this.root.style.left = `${x}px`;
      this.root.style.top = `${y}px`;
    });
    const stopDrag = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      this.head.classList.remove("dragging");
      this.head.releasePointerCapture(e.pointerId);
    };
    this.head.addEventListener("pointerup", stopDrag);
    this.head.addEventListener("pointercancel", stopDrag);
  }
}

function makeNumberRow(
  label: string,
  initial: number,
  onChange: (v: number) => void,
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement("div");
  row.className = "row";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.value = initial.toFixed(2);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  // Prevent canvas hotkeys (WASD pan, R rotate, T mode) while editing.
  input.addEventListener("keydown", (e) => e.stopPropagation());
  row.appendChild(lbl);
  row.appendChild(input);
  return { row, input };
}

function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

function kindLabel(kind: string): string {
  if (kind === "npc") return "NPC";
  if (kind === "object") return "object";
  if (kind === "item") return "item";
  return kind;
}

/** Strip `<col=…>` / `</col>` tags so the title bar shows the bare name.
 *  Full color rendering would need the same parser as ToolPanel; for the
 *  inspector header a plain label reads better. */
function stripOsrsTags(raw: string): string {
  return raw.replace(/<[^>]*>/g, "");
}
