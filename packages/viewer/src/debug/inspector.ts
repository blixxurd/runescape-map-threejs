import * as THREE from "three";
import type {
  TerrainDebug,
  LocsDebug,
  LocsManifest,
  TerrainMeta,
  TextureAtlas,
} from "@rsmap/shared";
import { TILES_PER_SIDE } from "@rsmap/shared";

/**
 * Shift-hover debug inspector, multi-region aware.
 *
 * Input flow:
 *   - Track Shift key state + mouse position.
 *   - When Shift is held, raycast the cursor ray into every loaded region's
 *     terrain + loc groups.
 *   - Walk the hit object up until we find a group tagged with a
 *     `userData.regionId` — that tells us which region the hit belongs to.
 *   - Resolve the first hit against that region's cache data:
 *       · terrain mesh → `triangleTiles[faceIndex + planeOffset]` → (tileX, tileZ)
 *       · InstancedMesh (loc) → `instanceId` → placement index via userData.
 *   - Render a pre-formatted string into the absolute-positioned panel.
 *
 * Per-region debug bundles (terrain.debug.json, locs.debug.json,
 * triangleTiles.bin) are lazy-loaded on demand: the first hit in a region
 * triggers its fetch. Regions you never hover never pay the download cost.
 */

/**
 * Everything `main.ts` gives the inspector to describe one loaded region.
 * Groups are the raycast targets (already offset to world coords); meta
 * provides the schema to decode a hit's faceIndex/instanceId.
 */
export interface RegionInfo {
  regionId: number;
  terrainMeta: TerrainMeta;
  locsManifest: LocsManifest;
  atlas: TextureAtlas;
  terrainGroup: THREE.Group;
  locsGroup: THREE.Group;
}

interface LoadedDebugBundle {
  terrainDebug: TerrainDebug;
  locsDebug: LocsDebug;
  triangleTiles: Uint16Array;
  /** Per-plane triangle start offsets within the region's concatenated stream. */
  planeTriStarts: number[];
}

export interface InspectorSceneRefs {
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
}

export class DebugInspector {
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private shiftHeld = false;
  private panel: HTMLElement;
  private toast: HTMLElement;
  private lastPasteBlock: string | null = null;
  private readonly regionsById: Map<number, RegionInfo>;
  private readonly debugById: Map<number, LoadedDebugBundle> = new Map();
  private readonly loadingById: Map<number, Promise<LoadedDebugBundle>> = new Map();
  private readonly raycastTargets: THREE.Object3D[];

  constructor(private readonly refs: InspectorSceneRefs, regions: readonly RegionInfo[]) {
    this.panel = document.getElementById("inspector")!;
    this.toast = document.getElementById("copyToast")!;
    this.regionsById = new Map(regions.map((r) => [r.regionId, r]));
    this.raycastTargets = [];
    for (const r of regions) {
      this.raycastTargets.push(r.terrainGroup, r.locsGroup);
    }
    this.installListeners();
  }

  /**
   * Register a region loaded after construction — used by the streaming
   * loader in main.ts. No-op if already present (region ids are unique
   * and stable).
   */
  addRegion(info: RegionInfo): void {
    if (this.regionsById.has(info.regionId)) return;
    this.regionsById.set(info.regionId, info);
    this.raycastTargets.push(info.terrainGroup, info.locsGroup);
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
    (navigator.clipboard?.writeText(text) ?? Promise.reject("no clipboard API"))
      .then(() => showToast("copied ✓", true))
      .catch((err: unknown) => {
        console.warn("[inspector] copy failed", err);
        showToast("copy failed", false);
      });
  }

  /**
   * Walk up from a raycast hit until we find the region-tagged group.
   * Returns null if the hit came from something that isn't in a region
   * (e.g. the night sky).
   */
  private regionForObject(obj: THREE.Object3D): RegionInfo | null {
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const rid = (cur.userData as { regionId?: number }).regionId;
      if (rid !== undefined) return this.regionsById.get(rid) ?? null;
      cur = cur.parent;
    }
    return null;
  }

  private async ensureDebugBundle(region: RegionInfo): Promise<LoadedDebugBundle> {
    const cached = this.debugById.get(region.regionId);
    if (cached) return cached;
    const inflight = this.loadingById.get(region.regionId);
    if (inflight) return inflight;
    const load = this.fetchBundle(region).then((b) => {
      this.debugById.set(region.regionId, b);
      this.loadingById.delete(region.regionId);
      return b;
    });
    this.loadingById.set(region.regionId, load);
    return load;
  }

  private async fetchBundle(region: RegionInfo): Promise<LoadedDebugBundle> {
    const base = `/regions/${region.regionId}`;
    const [terrainDebug, locsDebug, triBuf] = await Promise.all([
      fetch(`${base}/terrain.debug.json`).then((r) => r.json() as Promise<TerrainDebug>),
      fetch(`${base}/locs.debug.json`).then((r) => r.json() as Promise<LocsDebug>),
      fetch(`${base}/${region.terrainMeta.triangleTilesFile}`).then((r) => r.arrayBuffer()),
    ]);
    const triangleTiles = new Uint16Array(triBuf);
    const planeTriStarts: number[] = [];
    let acc = 0;
    for (const range of region.terrainMeta.planeRanges) {
      planeTriStarts.push(acc);
      acc += range.vertexCount / 3;
    }
    return { terrainDebug, locsDebug, triangleTiles, planeTriStarts };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.shiftHeld) return;
    const rect = this.refs.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.update(e.clientX, e.clientY);
  }

  private update(clientX: number, clientY: number): void {
    this.raycaster.setFromCamera(this.mouse, this.refs.camera as THREE.PerspectiveCamera);
    const hits = this.raycaster.intersectObjects(this.raycastTargets, true);

    this.panel.style.left = `${clientX}px`;
    this.panel.style.top = `${clientY}px`;
    this.panel.style.display = "block";

    if (hits.length === 0) {
      this.panel.innerHTML = `<span class="k">hit:</span> <span class="v">none</span>`;
      this.lastPasteBlock = null;
      return;
    }
    const hit = hits[0]!;
    const region = this.regionForObject(hit.object);
    if (!region) {
      this.panel.innerHTML = `<span class="k">hit:</span> <span class="v">${hit.object.type} (no region)</span>`;
      this.lastPasteBlock = null;
      return;
    }

    // Ensure per-region debug bundle is loaded before decoding the hit.
    // The first hover over a given region shows a "loading…" flash; subsequent
    // hovers are synchronous.
    const cached = this.debugById.get(region.regionId);
    if (!cached) {
      this.panel.textContent = `loading debug data for region ${region.regionId}…`;
      this.ensureDebugBundle(region).then(() => {
        // Re-raycast — the mouse could have moved since this fetch started,
        // so redo the hit test rather than reusing the stale `hit`.
        if (this.shiftHeld) this.update(clientX, clientY);
      });
      return;
    }

    const obj = hit.object;
    // Three mesh variants live in the scene and they all extend Mesh, so the
    // dispatch order matters:
    //   1. InstancedMesh → a still-instanced loc block (animated or
    //      multi-instance).
    //   2. Plain Mesh with `userData.isMergedLocs` → one of the per-plane
    //      merged singleton-loc meshes. Resolve via `placementByTri` since
    //      there's no instanceId to look up.
    //   3. Plain Mesh → terrain (one per plane per region).
    if (obj instanceof THREE.InstancedMesh) {
      this.renderLocHit(hit, region, cached);
    } else if ((obj.userData as { isMergedLocs?: boolean }).isMergedLocs) {
      this.renderMergedLocHit(hit, region, cached);
    } else if (obj instanceof THREE.Mesh) {
      this.renderTerrainHit(hit, region, cached);
    } else {
      this.panel.innerHTML = `<span class="k">hit:</span> <span class="v">${obj.type}</span>`;
      this.lastPasteBlock = null;
    }
  }

  private renderTerrainHit(
    hit: THREE.Intersection,
    region: RegionInfo,
    bundle: LoadedDebugBundle,
  ): void {
    const name = hit.object.name;
    const match = /^terrain:plane(\d+)$/.exec(name);
    if (!match) {
      this.panel.innerHTML = `<span class="k">terrain:</span> ${name}`;
      return;
    }
    const plane = Number(match[1]);
    const planeTriStart = bundle.planeTriStarts[plane] ?? 0;
    const faceIdx = hit.faceIndex ?? 0;
    const globalTri = planeTriStart + faceIdx;
    const tileLinear = bundle.triangleTiles[globalTri] ?? 0;
    const tileX = tileLinear % TILES_PER_SIDE;
    const tileZ = Math.floor(tileLinear / TILES_PER_SIDE);

    const tile = bundle.terrainDebug.tiles.find(
      (t) => t.plane === plane && t.x === tileX && t.z === tileZ,
    );
    if (!tile) {
      this.panel.innerHTML = `<span class="k">terrain:</span> region=${region.regionId} plane=${plane} tile=(${tileX}, ${tileZ}) <i>no debug entry</i>`;
      this.lastPasteBlock = null;
      return;
    }
    const udef = tile.underlayId > 0 ? bundle.terrainDebug.underlays[tile.underlayId] : undefined;
    const odef = tile.overlayId > 0 ? bundle.terrainDebug.overlays[tile.overlayId] : undefined;
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
<span class="k">region:</span> <span class="v">${region.regionId}</span>  <span class="k">plane:</span> <span class="v">${plane}</span>  <span class="k">tile:</span> <span class="v">(${tileX}, ${tileZ})</span>
<span class="k">world:</span> <span class="v">(${hitPos.x.toFixed(0)}, ${hitPos.y.toFixed(0)}, ${hitPos.z.toFixed(0)})</span>
<span class="k">underlay:</span> <span class="v">${tile.underlayId}</span>  <span class="k">tex:</span> <span class="v">${underlayTexId}</span>
  raw ${rgbSw(udef?.rawRgb)}  hue=${udef?.hue ?? "—"} sat=${udef?.saturation ?? "—"} lum=${udef?.lightness ?? "—"} mul=${udef?.hueMultiplier ?? "—"}
<span class="k">overlay:</span> <span class="v">${tile.overlayId}</span>  <span class="k">tex:</span> <span class="v">${overlayTexId}</span>
  shape=${tile.overlayShape} rot=${tile.overlayRotation}  hideUnder=${odef?.hideUnderlay ?? "—"}
<span class="k">blended HSL16:</span> <span class="v">0x${hsl.toString(16)}</span>  h=${hsl_hue} s=${hsl_sat} l=${hsl_lum}
<span class="k">settings:</span> <span class="v">${tile.settings}</span>`;

    this.lastPasteBlock = [
      `[region ${region.regionId} / terrain tile]`,
      `plane=${plane}  tile=(${tileX}, ${tileZ})  world=(${hitPos.x.toFixed(0)}, ${hitPos.y.toFixed(0)}, ${hitPos.z.toFixed(0)})`,
      `underlay=${tile.underlayId} tex=${underlayTexId}  rawRGB=${hex(udef?.rawRgb)}  hue=${udef?.hue ?? "-"} sat=${udef?.saturation ?? "-"} lum=${udef?.lightness ?? "-"} mul=${udef?.hueMultiplier ?? "-"}`,
      `overlay=${tile.overlayId} tex=${overlayTexId}  shape=${tile.overlayShape} rot=${tile.overlayRotation}  hideUnder=${odef?.hideUnderlay ?? "-"}  packedHsl=${odef?.packedHsl !== undefined ? "0x" + odef.packedHsl.toString(16) : "-"}`,
      `blendedHSL=0x${hsl.toString(16)}  h=${hsl_hue} s=${hsl_sat} l=${hsl_lum}  settings=${tile.settings}`,
      `bundle: build=${region.terrainMeta.buildId} cache=${region.terrainMeta.sourceCacheId}`,
    ].join("\n");
  }

  private renderLocHit(
    hit: THREE.Intersection,
    region: RegionInfo,
    bundle: LoadedDebugBundle,
  ): void {
    const inst = hit.object as THREE.InstancedMesh;
    const instanceId = hit.instanceId ?? 0;
    const blockIdx = (inst.userData as { blockIndex?: number }).blockIndex;
    const placementIdxs = (inst.userData as { placementIdxs?: number[] }).placementIdxs;
    if (blockIdx === undefined || !placementIdxs) {
      this.panel.innerHTML = `<span class="k">loc:</span> ${inst.name}`;
      return;
    }
    const placementIdx = placementIdxs[instanceId] ?? -1;
    this.renderLocByPlacement(
      placementIdx,
      region,
      bundle,
      `${instanceId} / ${inst.count}`,
    );
  }

  /**
   * Merged-loc hits have no `instanceId` — instead each triangle in the
   * merged mesh remembers the placement it came from, stored on userData
   * at build time. Look up faceIndex → placement, then reuse the shared
   * loc renderer.
   */
  private renderMergedLocHit(
    hit: THREE.Intersection,
    region: RegionInfo,
    bundle: LoadedDebugBundle,
  ): void {
    const mesh = hit.object;
    const map = (mesh.userData as { placementByTri?: Uint32Array }).placementByTri;
    const faceIdx = hit.faceIndex;
    if (!map || faceIdx === undefined || faceIdx === null) {
      this.panel.innerHTML = `<span class="k">loc (merged):</span> ${mesh.name}`;
      this.lastPasteBlock = null;
      return;
    }
    const placementIdx = map[faceIdx] ?? -1;
    this.renderLocByPlacement(placementIdx, region, bundle, "merged");
  }

  /**
   * Shared loc-panel renderer. Takes a fully resolved placement index and
   * an opaque "instance label" to show in the UI (`"3 / 12"` for instanced,
   * `"merged"` for merged). Kept out of `renderLocHit` / `renderMergedLocHit`
   * so those two paths can't drift apart.
   */
  private renderLocByPlacement(
    placementIdx: number,
    region: RegionInfo,
    bundle: LoadedDebugBundle,
    instanceLabel: string,
  ): void {
    const placement = region.locsManifest.placements[placementIdx];
    if (!placement) {
      this.panel.innerHTML = `<span class="k">loc:</span> no placement at ${placementIdx}`;
      this.lastPasteBlock = null;
      return;
    }
    const blockIdx = placement.blockIndex;
    const block = region.locsManifest.blocks[blockIdx];
    const dbg = bundle.locsDebug.blocks[blockIdx];
    if (!block) {
      this.panel.innerHTML = `<span class="k">loc:</span> placement=${placementIdx} no block`;
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

    const animLine = block.animation
      ? `  anim: ${block.animation.frameCount} frames, ticks=[${block.animation.frameTicks.join(",")}], frameStep=${block.animation.frameStep}`
      : "";

    this.panel.innerHTML = `<b>loc</b>
<span class="k">region:</span> <span class="v">${region.regionId}</span>  <span class="k">locId:</span> <span class="v">${block.locId}</span>${dbg?.name ? `  "${dbg.name}"` : ""}
<span class="k">tile:</span> <span class="v">(${placement.x}, ${placement.z})</span>  <span class="k">plane:</span> <span class="v">${placement.plane}</span>
<span class="k">cache type:</span> <span class="v">${placement.origType}</span> (${origTypeName})  <span class="k">rot:</span> <span class="v">${placement.origRotation}</span>
<span class="k">model type:</span> <span class="v">${block.modelType}</span> (${modelTypeName})  <span class="k">baked rot:</span> <span class="v">${block.bakedRotation}</span>
<span class="k">block:</span> <span class="v">${blockIdx}</span>  <span class="k">instance:</span> <span class="v">${instanceLabel}</span>
<span class="k">faces:</span> <span class="v">${dbg?.faceCount ?? "?"}</span>  <span class="k">textured:</span> <span class="v">${dbg?.texturedFaceCount ?? "?"}</span>  <span class="k">distinctColors:</span> <span class="v">${dbg?.distinctFaceColors ?? "?"}</span>${animLine ? `\n<span class="k">animation:</span> <span class="v">${block.animation!.frameCount} frames</span>  <span class="k">ticks:</span> <span class="v">[${block.animation!.frameTicks.join(",")}]</span>  <span class="k">frameStep:</span> <span class="v">${block.animation!.frameStep}</span>` : ""}`;

    this.lastPasteBlock = [
      `[region ${region.regionId} / loc]`,
      `locId=${block.locId}${dbg?.name ? `  "${dbg.name}"` : ""}  tile=(${placement.x}, ${placement.z})  plane=${placement.plane}`,
      `cache: type=${placement.origType} (${origTypeName})  rot=${placement.origRotation}`,
      `model: type=${block.modelType} (${modelTypeName})  bakedRot=${block.bakedRotation}  block=${blockIdx}  instance=${instanceLabel}`,
      `geometry: faces=${dbg?.faceCount ?? "?"}  textured=${dbg?.texturedFaceCount ?? "?"}  distinctColors=${dbg?.distinctFaceColors ?? "?"}${animLine}`,
      `bundle: build=${region.terrainMeta.buildId} cache=${region.terrainMeta.sourceCacheId}`,
    ].join("\n");
  }
}
