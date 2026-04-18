import * as THREE from "three";
import type {
  TerrainDebug,
  TerrainDebugTile,
  LocsDebug,
  LocsManifest,
  TerrainMeta,
  TextureAtlas,
} from "@rsmap/shared";
import { TILE_SIZE, TILES_PER_SIDE } from "@rsmap/shared";

/**
 * Shift-hover debug inspector.
 *
 * Input flow:
 *   - Track Shift key state + mouse position.
 *   - When Shift is held, raycast the cursor ray into the scene.
 *   - Resolve the first hit:
 *       · terrain mesh → use `triangleTiles[firstHit.faceIndex + planeOffset]`
 *         to get `(tileZ*64 + tileX)`, then look up the TerrainDebugTile.
 *       · InstancedMesh (loc) → map `firstHit.instanceId` via `inst.userData`
 *         back to a placement + block.
 *   - Render a pre-formatted string into the absolute-positioned panel.
 *
 * Everything is lazy-loaded: the debug JSONs (several MB) aren't fetched
 * until the user first holds Shift. Normal rendering has zero overhead.
 */

interface DebugBundle {
  terrainMeta: TerrainMeta;
  terrainDebug: TerrainDebug;
  triangleTiles: Uint16Array;
  locsManifest: LocsManifest;
  locsDebug: LocsDebug;
  atlas: TextureAtlas;
  /** Per-plane triangle start offsets in the single concatenated stream. */
  planeTriStarts: number[];
}

export interface InspectorSceneRefs {
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  terrainGroup: THREE.Group;
  locsGroup: THREE.Group;
}

export class DebugInspector {
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private shiftHeld = false;
  private bundle: DebugBundle | null = null;
  private loadingPromise: Promise<DebugBundle> | null = null;
  private panel: HTMLElement;
  private toast: HTMLElement;
  /** Most recent resolved hit, refreshed on every mousemove while inspecting.
   *  Stored so a shift-click click handler can copy it to clipboard without
   *  having to re-raycast. */
  private lastPasteBlock: string | null = null;

  constructor(
    private readonly refs: InspectorSceneRefs,
    private readonly regionId: number,
    private readonly locsManifest: LocsManifest,
    private readonly terrainMeta: TerrainMeta,
    private readonly atlas: TextureAtlas,
  ) {
    this.panel = document.getElementById("inspector")!;
    this.toast = document.getElementById("copyToast")!;
    this.installListeners();
  }

  private installListeners(): void {
    const dom = this.refs.renderer.domElement;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Shift") this.shiftHeld = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Shift") {
        this.shiftHeld = false;
        this.panel.style.display = "none";
      }
    });
    window.addEventListener("blur", () => {
      this.shiftHeld = false;
      this.panel.style.display = "none";
    });
    dom.addEventListener("mousemove", (e) => this.onMouseMove(e));
    // shift+click → copy the current paste-block. We listen on `click`
    // rather than `mousedown` so OrbitControls' camera drag (which grabs
    // mousedown) doesn't conflict; with shift held OrbitControls typically
    // does pan instead of rotate, but a plain click still fires.
    dom.addEventListener("click", (e) => {
      if (!e.shiftKey || !this.lastPasteBlock) return;
      e.preventDefault();
      e.stopPropagation();
      this.copyToClipboard(this.lastPasteBlock, e.clientX, e.clientY);
    });
  }

  private copyToClipboard(text: string, x: number, y: number): void {
    const showToast = (msg: string, ok: boolean): void => {
      this.toast.textContent = msg;
      this.toast.style.background = ok ? "#2d4b2d" : "#4b2d2d";
      this.toast.style.left = `${x}px`;
      this.toast.style.top = `${y}px`;
      this.toast.classList.add("show");
      setTimeout(() => this.toast.classList.remove("show"), 900);
    };
    // `navigator.clipboard` requires a secure context; Vite's dev server
    // on localhost qualifies. Fall back to a textarea + execCommand only
    // if absolutely needed.
    (navigator.clipboard?.writeText(text) ?? Promise.reject("no clipboard API"))
      .then(() => showToast("copied ✓", true))
      .catch((err: unknown) => {
        console.warn("[inspector] copy failed", err);
        showToast("copy failed", false);
      });
  }

  private async ensureLoaded(): Promise<DebugBundle> {
    if (this.bundle) return this.bundle;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.fetchBundle();
    this.bundle = await this.loadingPromise;
    return this.bundle;
  }

  private async fetchBundle(): Promise<DebugBundle> {
    const base = `/regions/${this.regionId}`;
    const [terrainDebug, locsDebug, triBuf] = await Promise.all([
      fetch(`${base}/terrain.debug.json`).then((r) => r.json() as Promise<TerrainDebug>),
      fetch(`${base}/locs.debug.json`).then((r) => r.json() as Promise<LocsDebug>),
      fetch(`${base}/${this.terrainMeta.triangleTilesFile}`).then((r) => r.arrayBuffer()),
    ]);
    const triangleTiles = new Uint16Array(triBuf);
    const planeTriStarts: number[] = [];
    let acc = 0;
    for (const range of this.terrainMeta.planeRanges) {
      planeTriStarts.push(acc);
      acc += range.vertexCount / 3;
    }
    return {
      terrainMeta: this.terrainMeta,
      terrainDebug,
      triangleTiles,
      locsManifest: this.locsManifest,
      locsDebug,
      atlas: this.atlas,
      planeTriStarts,
    };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.shiftHeld) return;
    const rect = this.refs.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

    // Kick off the lazy load without blocking the handler.
    if (!this.bundle) {
      this.ensureLoaded().then(() => this.update(e.clientX, e.clientY));
      this.panel.style.display = "block";
      this.panel.textContent = "loading debug data…";
      this.panel.style.left = `${e.clientX}px`;
      this.panel.style.top = `${e.clientY}px`;
      return;
    }
    this.update(e.clientX, e.clientY);
  }

  private update(clientX: number, clientY: number): void {
    if (!this.bundle) return;
    this.raycaster.setFromCamera(this.mouse, this.refs.camera as THREE.PerspectiveCamera);
    // Intersect terrain + loc groups. `recursive: true` descends into each
    // group's children so terrain Meshes and loc InstancedMeshes are hit.
    const hits = this.raycaster.intersectObjects([this.refs.terrainGroup, this.refs.locsGroup], true);

    this.panel.style.left = `${clientX}px`;
    this.panel.style.top = `${clientY}px`;
    this.panel.style.display = "block";

    if (hits.length === 0) {
      this.panel.innerHTML = `<span class="k">hit:</span> <span class="v">none</span>`;
      this.lastPasteBlock = null;
      return;
    }
    const hit = hits[0]!;
    const obj = hit.object;
    if (obj instanceof THREE.InstancedMesh) {
      this.renderLocHit(hit);
    } else if (obj instanceof THREE.Mesh) {
      this.renderTerrainHit(hit);
    } else {
      this.panel.innerHTML = `<span class="k">hit:</span> <span class="v">${obj.type}</span>`;
      this.lastPasteBlock = null;
    }
  }

  private renderTerrainHit(hit: THREE.Intersection): void {
    const b = this.bundle!;
    // Mesh name is `terrain:planeN`; extract the plane.
    const name = hit.object.name;
    const match = /^terrain:plane(\d+)$/.exec(name);
    if (!match) {
      this.panel.innerHTML = `<span class="k">terrain:</span> ${name}`;
      return;
    }
    const plane = Number(match[1]);
    const planeTriStart = b.planeTriStarts[plane] ?? 0;
    const faceIdx = hit.faceIndex ?? 0;
    const globalTri = planeTriStart + faceIdx;
    const tileLinear = b.triangleTiles[globalTri] ?? 0;
    const tileX = tileLinear % TILES_PER_SIDE;
    const tileZ = Math.floor(tileLinear / TILES_PER_SIDE);

    // Find the debug tile (linear search — not huge, 16k max, but we can
    // index later if this gets slow).
    const tile = b.terrainDebug.tiles.find(
      (t) => t.plane === plane && t.x === tileX && t.z === tileZ,
    );
    if (!tile) {
      this.panel.innerHTML = `<span class="k">terrain:</span> plane=${plane} tile=(${tileX}, ${tileZ}) <i>no debug entry</i>`;
      this.lastPasteBlock = null;
      return;
    }
    const udef = tile.underlayId > 0 ? b.terrainDebug.underlays[tile.underlayId] : undefined;
    const odef = tile.overlayId > 0 ? b.terrainDebug.overlays[tile.overlayId] : undefined;
    const underlayTexId = udef?.textureId ?? -1;
    const overlayTexId = odef?.textureId ?? -1;
    const hitPos = hit.point;
    const hex = (rgb?: number): string =>
      rgb !== undefined ? `#${rgb.toString(16).padStart(6, "0")}` : "—";
    const rgbSw = (rgb?: number): string =>
      rgb !== undefined
        ? `<span class="sw" style="background:${hex(rgb)}"></span>${hex(rgb)}`
        : "—";

    const hsl = tile.blendedHsl;
    const hsl_hue = (hsl >> 10) & 63;
    const hsl_sat = (hsl >> 7) & 7;
    const hsl_lum = hsl & 127;

    this.panel.innerHTML = `<b>terrain tile</b>
<span class="k">plane:</span> <span class="v">${plane}</span>  <span class="k">tile:</span> <span class="v">(${tileX}, ${tileZ})</span>
<span class="k">world:</span> <span class="v">(${hitPos.x.toFixed(0)}, ${hitPos.y.toFixed(0)}, ${hitPos.z.toFixed(0)})</span>
<span class="k">underlay:</span> <span class="v">${tile.underlayId}</span>  <span class="k">tex:</span> <span class="v">${underlayTexId}</span>
  raw ${rgbSw(udef?.rawRgb)}  hue=${udef?.hue ?? "—"} sat=${udef?.saturation ?? "—"} lum=${udef?.lightness ?? "—"} mul=${udef?.hueMultiplier ?? "—"}
<span class="k">overlay:</span> <span class="v">${tile.overlayId}</span>  <span class="k">tex:</span> <span class="v">${overlayTexId}</span>
  shape=${tile.overlayShape} rot=${tile.overlayRotation}  hideUnder=${odef?.hideUnderlay ?? "—"}
<span class="k">blended HSL16:</span> <span class="v">0x${hsl.toString(16)}</span>  h=${hsl_hue} s=${hsl_sat} l=${hsl_lum}
<span class="k">settings:</span> <span class="v">${tile.settings}</span>`;

    // Paste-friendly block: everything needed to identify the tile
    // unambiguously + debug its color/texture pipeline.
    this.lastPasteBlock = [
      `[region ${this.regionId} / terrain tile]`,
      `plane=${plane}  tile=(${tileX}, ${tileZ})  world=(${hitPos.x.toFixed(0)}, ${hitPos.y.toFixed(0)}, ${hitPos.z.toFixed(0)})`,
      `underlay=${tile.underlayId} tex=${underlayTexId}  rawRGB=${hex(udef?.rawRgb)}  hue=${udef?.hue ?? "-"} sat=${udef?.saturation ?? "-"} lum=${udef?.lightness ?? "-"} mul=${udef?.hueMultiplier ?? "-"}`,
      `overlay=${tile.overlayId} tex=${overlayTexId}  shape=${tile.overlayShape} rot=${tile.overlayRotation}  hideUnder=${odef?.hideUnderlay ?? "-"}  packedHsl=${odef?.packedHsl !== undefined ? "0x" + odef.packedHsl.toString(16) : "-"}`,
      `blendedHSL=0x${hsl.toString(16)}  h=${hsl_hue} s=${hsl_sat} l=${hsl_lum}  settings=${tile.settings}`,
      `bundle: build=${this.terrainMeta.buildId} cache=${this.terrainMeta.sourceCacheId}`,
    ].join("\n");
  }

  private renderLocHit(hit: THREE.Intersection): void {
    const b = this.bundle!;
    const inst = hit.object as THREE.InstancedMesh;
    const instanceId = hit.instanceId ?? 0;
    const blockIdx = (inst.userData as { blockIndex?: number }).blockIndex;
    const placementIdxs = (inst.userData as { placementIdxs?: number[] }).placementIdxs;
    if (blockIdx === undefined || !placementIdxs) {
      this.panel.innerHTML = `<span class="k">loc:</span> ${inst.name}`;
      return;
    }
    const placement = b.locsManifest.placements[placementIdxs[instanceId] ?? -1];
    const block = b.locsManifest.blocks[blockIdx];
    const dbg = b.locsDebug.blocks[blockIdx];
    if (!placement || !block) {
      this.panel.innerHTML = `<span class="k">loc:</span> ${inst.name} instance=${instanceId}`;
      this.lastPasteBlock = null;
      return;
    }

    const MODEL_TYPE_NAMES: Record<number, string> = {
      0: "WALL", 1: "WALL_TRI_CORNER", 2: "WALL_CORNER", 3: "WALL_RECT_CORNER",
      4: "WALL_DECORATION_INSIDE", 5: "WALL_DECORATION_OUTSIDE",
      6: "WALL_DECORATION_DIAGONAL_OUTSIDE", 7: "WALL_DECORATION_DIAGONAL_INSIDE",
      8: "WALL_DECORATION_DIAGONAL_DOUBLE", 9: "WALL_DIAGONAL",
      10: "NORMAL", 11: "NORMAL_DIAGIONAL",
      12: "ROOF_SLOPED", 13: "ROOF_SLOPED_OUTER_CORNER",
      14: "ROOF_SLOPED_INNER_CORNER", 15: "ROOF_SLOPED_HARD_INNER_CORNER",
      16: "ROOF_SLOPED_HARD_OUTER_CORNER", 17: "ROOF_FLAT",
      18: "ROOF_SLOPED_OVERHANG", 19: "ROOF_SLOPED_OVERHANG_OUTER_CORNER",
      20: "ROOF_SLOPED_OVERHANG_INNER_CORNER", 21: "ROOF_SLOPED_OVERHANG_HARD_OUTER_CORNER",
      22: "FLOOR_DECORATION",
    };
    const origTypeName = MODEL_TYPE_NAMES[placement.origType] ?? "?";
    const modelTypeName = MODEL_TYPE_NAMES[block.modelType] ?? "?";

    this.panel.innerHTML = `<b>loc</b>
<span class="k">locId:</span> <span class="v">${block.locId}</span>${dbg?.name ? `  "${dbg.name}"` : ""}
<span class="k">tile:</span> <span class="v">(${placement.x}, ${placement.z})</span>  <span class="k">plane:</span> <span class="v">${placement.plane}</span>
<span class="k">cache type:</span> <span class="v">${placement.origType}</span> (${origTypeName})  <span class="k">rot:</span> <span class="v">${placement.origRotation}</span>
<span class="k">model type:</span> <span class="v">${block.modelType}</span> (${modelTypeName})  <span class="k">baked rot:</span> <span class="v">${block.bakedRotation}</span>
<span class="k">block:</span> <span class="v">${blockIdx}</span>  <span class="k">instance:</span> <span class="v">${instanceId} / ${inst.count}</span>
<span class="k">faces:</span> <span class="v">${dbg?.faceCount ?? "?"}</span>  <span class="k">textured:</span> <span class="v">${dbg?.texturedFaceCount ?? "?"}</span>  <span class="k">distinctColors:</span> <span class="v">${dbg?.distinctFaceColors ?? "?"}</span>`;

    this.lastPasteBlock = [
      `[region ${this.regionId} / loc]`,
      `locId=${block.locId}${dbg?.name ? `  "${dbg.name}"` : ""}  tile=(${placement.x}, ${placement.z})  plane=${placement.plane}`,
      `cache: type=${placement.origType} (${origTypeName})  rot=${placement.origRotation}`,
      `model: type=${block.modelType} (${modelTypeName})  bakedRot=${block.bakedRotation}  block=${blockIdx}  instance=${instanceId}/${inst.count}`,
      `geometry: faces=${dbg?.faceCount ?? "?"}  textured=${dbg?.texturedFaceCount ?? "?"}  distinctColors=${dbg?.distinctFaceColors ?? "?"}`,
      `bundle: build=${this.terrainMeta.buildId} cache=${this.terrainMeta.sourceCacheId}`,
    ].join("\n");
  }
}
