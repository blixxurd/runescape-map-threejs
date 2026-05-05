import {
  loadNpcCatalog,
  loadObjectCatalog,
  loadItemCatalog,
  loadSpotAnimCatalog,
  loadSequenceCatalog,
  searchEntries,
  type NamedEntry,
  type NpcCatalogEntry,
  type ObjectCatalogEntry,
  type ItemCatalogEntry,
  type SpotAnimCatalogEntry,
  type SequenceCatalogEntry,
} from "./entityCatalog.js";
import { animationName, knownNamedAnimations } from "./animationNames.js";

/**
 * Tabbed side panel for the editor tools: NPCs, Objects, Items.
 *
 * Each tab drives a host-side ModelPlacer. The panel itself is a dumb view
 * over two pieces of state: the active tab and the catalog contents.
 * Interactions bubble out through the `host` callbacks — the panel never
 * touches the scene or the placer internals.
 */
export type ModelTab = "npc" | "object" | "item" | "spotanim";

export interface ToolPanelHost {
  /** User clicked a result in one of the model-backed tabs. */
  onArmEntity(tab: ModelTab, entry: NamedEntry): void;
  /** User clicked cancel or pressed Escape while armed. */
  onCancel(): void;
  /** User clicked "clear all" for a specific tool. Unknown = every tool. */
  onClear(target: ModelTab | "all"): void;
  /** User toggled the world-pick eyedropper. */
  onEyedropperArm(armed: boolean): void;
  /** User picked a different animation for the currently-armed NPC.
   *  Host re-arms the NPC placer with `animationId` so subsequent
   *  placements cycle the new sequence. */
  onChangeNpcAnimation(npcId: number, name: string, animationId: number): void;
  /** User toggled the "free placement" mode. `false` snaps placements to
   *  tile centers (the default); `true` drops the snap and lets users
   *  place anywhere the cursor lands. */
  onSnapToTileToggle(snap: boolean): void;
  /** User clicked the screenshot button (or pressed P). */
  onScreenshot(): void;
}

type AnyCatalog = NpcCatalogEntry[] | ObjectCatalogEntry[] | ItemCatalogEntry[] | SpotAnimCatalogEntry[];

interface TabState {
  catalog: AnyCatalog | null;
  error: string | null;
  query: string;
  armedId: number | null;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #toolPanel {
      position: fixed; top: 8px; right: 8px; width: 300px;
      background: rgba(0,0,0,0.85); color: #d5dce8;
      border: 1px solid #2a334a; border-radius: 4px;
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 20; display: flex; flex-direction: column;
    }
    #toolPanel.collapsed .body { display: none; }
    #toolPanel .head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 8px; border-bottom: 1px solid #2a334a;
      color: #7aa6d6; font-weight: bold; cursor: default;
    }
    #toolPanel .head .title { letter-spacing: 0.5px; }
    #toolPanel .head .head-actions { display: flex; gap: 4px; }
    #toolPanel .head button.head-btn {
      background: transparent; border: 1px solid #2a334a; color: #8f9bb5;
      font: inherit; cursor: pointer; padding: 1px 6px; border-radius: 3px;
    }
    #toolPanel .head button.head-btn:hover { color: #e6e8ec; border-color: #7aa6d6; }
    #toolPanel .head button.head-btn.active {
      background: #2d4b2d; color: #e8f5e8; border-color: #4c6b4c;
    }
    #toolPanel .head .collapse {
      background: transparent; border: none; color: #8f9bb5;
      font: inherit; cursor: pointer; padding: 0 4px;
    }
    #toolPanel .head .collapse:hover { color: #e6e8ec; }
    #toolPanel .tabs {
      display: flex; border-bottom: 1px solid #2a334a;
    }
    #toolPanel .tabs button {
      flex: 1; padding: 6px 2px;
      background: transparent; border: none; color: #8f9bb5;
      font: inherit; cursor: pointer; border-bottom: 2px solid transparent;
    }
    #toolPanel .tabs button:hover { color: #e6e8ec; }
    #toolPanel .tabs button.active {
      color: #e6e8ec; border-bottom-color: #7aa6d6;
    }
    #toolPanel .body {
      padding: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    #toolPanel .panel { display: none; flex-direction: column; gap: 6px; }
    #toolPanel .panel.active { display: flex; }
    #toolPanel input.search {
      background: #10131d; color: #e6e8ec;
      border: 1px solid #2a334a; border-radius: 3px;
      padding: 4px 6px; font: inherit; outline: none;
    }
    #toolPanel input.search:focus { border-color: #7aa6d6; }
    #toolPanel .status { color: #8f9bb5; min-height: 14px; }
    #toolPanel .armed {
      background: #2d4b2d; color: #e8f5e8; padding: 4px 6px; border-radius: 3px;
      display: flex; justify-content: space-between; align-items: center;
      gap: 6px;
    }
    #toolPanel .armed button {
      background: transparent; border: 1px solid #4c6b4c; color: #e8f5e8;
      font: inherit; padding: 1px 6px; border-radius: 3px; cursor: pointer;
    }
    #toolPanel .results {
      max-height: 320px; overflow-y: auto;
      border: 1px solid #1c2235; border-radius: 3px;
      background: rgba(8,10,16,0.6);
    }
    #toolPanel .results .row-r {
      padding: 3px 6px; cursor: pointer;
      display: flex; justify-content: space-between; gap: 6px;
      border-bottom: 1px solid #14192a;
    }
    #toolPanel .results .row-r:last-child { border-bottom: none; }
    #toolPanel .results .row-r:hover { background: #1a2138; }
    #toolPanel .results .row-r.armed { background: #2d4b2d; color: #e8f5e8; }
    #toolPanel .results .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #toolPanel .results .meta { color: #8f9bb5; flex-shrink: 0; font-size: 10.5px; }
    #toolPanel button.action {
      background: #14192a; border: 1px solid #2a334a; color: #d5dce8;
      font: inherit; padding: 4px 8px; border-radius: 3px; cursor: pointer;
    }
    #toolPanel button.action:hover { background: #1a2138; border-color: #7aa6d6; }
    #toolPanel button.primary {
      background: #2d4b2d; border-color: #4c6b4c; color: #e8f5e8;
    }
    #toolPanel button.primary:hover { background: #3a5e3a; }
    #toolPanel .hint {
      color: #8f9bb5; font-size: 10.5px; line-height: 1.5;
      padding: 4px 6px; background: rgba(8,10,16,0.5);
      border-left: 2px solid #2a334a; border-radius: 2px;
    }
    #toolPanel .hint b { color: #d5dce8; }
    #toolPanel .empty { padding: 6px; color: #8f9bb5; }
  `;
  document.head.appendChild(style);
}

export class ToolPanel {
  private readonly host: ToolPanelHost;
  private readonly root: HTMLDivElement;
  private readonly panels: Record<ModelTab, HTMLDivElement>;
  private readonly resultsEls: Record<ModelTab, HTMLDivElement>;
  private readonly searchInputs: Record<ModelTab, HTMLInputElement>;
  private readonly statusEls: Record<ModelTab, HTMLDivElement>;
  private readonly armedBanners: Record<ModelTab, HTMLDivElement>;
  private readonly tabBtns: Record<ModelTab, HTMLButtonElement>;
  private readonly eyedropperBtn: HTMLButtonElement;
  private readonly freePlaceBtn: HTMLButtonElement;

  private activeTab: ModelTab = "npc";
  private readonly tabStates: Record<ModelTab, TabState> = {
    npc: { catalog: null, error: null, query: "", armedId: null },
    object: { catalog: null, error: null, query: "", armedId: null },
    item: { catalog: null, error: null, query: "", armedId: null },
    spotanim: { catalog: null, error: null, query: "", armedId: null },
  };

  constructor(host: ToolPanelHost) {
    this.host = host;
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "toolPanel";
    this.root.innerHTML = `
      <div class="head">
        <span class="title">editor</span>
        <div class="head-actions">
          <button class="head-btn free-place" type="button" title="free placement — ignore tile snap">
            free
          </button>
          <button class="head-btn eyedropper" type="button" title="pick from world (I)">
            pick
          </button>
          <button class="head-btn screenshot" type="button" title="screenshot (P)">
            snap
          </button>
          <button class="collapse" type="button" title="collapse">–</button>
        </div>
      </div>
      <div class="tabs">
        <button data-tab="npc" class="active">NPCs</button>
        <button data-tab="object">Objects</button>
        <button data-tab="item">Items</button>
        <button data-tab="spotanim">FX</button>
      </div>
      <div class="body">
        <div class="panel panel-npc active" data-tab="npc">
          <input class="search" type="text" placeholder="search NPCs…" autocomplete="off" />
          <div class="armed" style="display:none"></div>
          <div class="status">loading…</div>
          <div class="results"></div>
          <div class="hint"><b>click</b> a name to arm, <b>click terrain</b> to place. <b>R</b> rotates. <b>shift+click</b> a placed NPC to delete. <b>esc</b> cancels.</div>
        </div>
        <div class="panel panel-object" data-tab="object">
          <input class="search" type="text" placeholder="search objects…" autocomplete="off" />
          <div class="armed" style="display:none"></div>
          <div class="status">catalog not loaded — type to start</div>
          <div class="results"></div>
          <div class="hint">walls, scenery, doors, crates — all here. <b>R</b> rotates 45°, <b>shift+R</b> the other way (so fences can run diagonally across a tile).</div>
        </div>
        <div class="panel panel-item" data-tab="item">
          <input class="search" type="text" placeholder="search items…" autocomplete="off" />
          <div class="armed" style="display:none"></div>
          <div class="status">catalog not loaded — switch tab to start</div>
          <div class="results"></div>
          <div class="hint">ground items use the inventory model. <b>R</b> rotates.</div>
        </div>
        <div class="panel panel-spotanim" data-tab="spotanim">
          <input class="search" type="text" placeholder="search effects…" autocomplete="off" />
          <div class="armed" style="display:none"></div>
          <div class="status">catalog not loaded — switch tab to start</div>
          <div class="results"></div>
          <div class="hint">spot anims = projectiles, spell impacts, gfx-on-NPC. one-shot animations freeze on their last frame.</div>
        </div>
        <div class="actions">
          <button class="action" data-clear="npc" type="button">clear NPCs</button>
          <button class="action" data-clear="object" type="button">clear objects</button>
          <button class="action" data-clear="item" type="button">clear items</button>
          <button class="action" data-clear="spotanim" type="button">clear FX</button>
          <button class="action" data-clear="all" type="button">clear all</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);

    this.tabBtns = {
      npc: this.root.querySelector<HTMLButtonElement>('.tabs button[data-tab="npc"]')!,
      object: this.root.querySelector<HTMLButtonElement>('.tabs button[data-tab="object"]')!,
      item: this.root.querySelector<HTMLButtonElement>('.tabs button[data-tab="item"]')!,
      spotanim: this.root.querySelector<HTMLButtonElement>('.tabs button[data-tab="spotanim"]')!,
    };
    this.panels = {
      npc: this.root.querySelector<HTMLDivElement>(".panel-npc")!,
      object: this.root.querySelector<HTMLDivElement>(".panel-object")!,
      item: this.root.querySelector<HTMLDivElement>(".panel-item")!,
      spotanim: this.root.querySelector<HTMLDivElement>(".panel-spotanim")!,
    };
    this.resultsEls = {
      npc: this.panels.npc.querySelector<HTMLDivElement>(".results")!,
      object: this.panels.object.querySelector<HTMLDivElement>(".results")!,
      item: this.panels.item.querySelector<HTMLDivElement>(".results")!,
      spotanim: this.panels.spotanim.querySelector<HTMLDivElement>(".results")!,
    };
    this.searchInputs = {
      npc: this.panels.npc.querySelector<HTMLInputElement>(".search")!,
      object: this.panels.object.querySelector<HTMLInputElement>(".search")!,
      item: this.panels.item.querySelector<HTMLInputElement>(".search")!,
      spotanim: this.panels.spotanim.querySelector<HTMLInputElement>(".search")!,
    };
    this.statusEls = {
      npc: this.panels.npc.querySelector<HTMLDivElement>(".status")!,
      object: this.panels.object.querySelector<HTMLDivElement>(".status")!,
      item: this.panels.item.querySelector<HTMLDivElement>(".status")!,
      spotanim: this.panels.spotanim.querySelector<HTMLDivElement>(".status")!,
    };
    this.armedBanners = {
      npc: this.panels.npc.querySelector<HTMLDivElement>(".armed")!,
      object: this.panels.object.querySelector<HTMLDivElement>(".armed")!,
      item: this.panels.item.querySelector<HTMLDivElement>(".armed")!,
      spotanim: this.panels.spotanim.querySelector<HTMLDivElement>(".armed")!,
    };
    this.eyedropperBtn = this.root.querySelector<HTMLButtonElement>(".eyedropper")!;
    this.freePlaceBtn = this.root.querySelector<HTMLButtonElement>(".free-place")!;
    this.root
      .querySelector<HTMLButtonElement>(".screenshot")!
      .addEventListener("click", () => this.host.onScreenshot());

    this.wireEvents();
    void this.loadCatalog("npc");
  }

  private wireEvents(): void {
    for (const tab of ["npc", "object", "item", "spotanim"] as const) {
      this.tabBtns[tab].addEventListener("click", () => this.setTab(tab));
    }
    this.root
      .querySelector<HTMLButtonElement>(".collapse")!
      .addEventListener("click", () => this.root.classList.toggle("collapsed"));

    for (const tab of ["npc", "object", "item", "spotanim"] as const) {
      const input = this.searchInputs[tab];
      input.addEventListener("input", () => {
        this.tabStates[tab].query = input.value;
        this.renderResults(tab);
      });
      // Swallow canvas hotkeys while typing in the search box so R doesn't
      // rotate the placer and WASD doesn't drift the camera.
      input.addEventListener("keydown", (e) => e.stopPropagation());
      input.addEventListener("keyup", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") this.cancelArmed();
      });
    }

    this.root
      .querySelectorAll<HTMLButtonElement>("button.action[data-clear]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = btn.dataset.clear as ModelTab | "all";
          this.host.onClear(target);
        });
      });

    this.eyedropperBtn.addEventListener("click", () => {
      const willArm = !this.eyedropperBtn.classList.contains("active");
      this.host.onEyedropperArm(willArm);
    });

    this.freePlaceBtn.addEventListener("click", () => {
      const willFree = !this.freePlaceBtn.classList.contains("active");
      this.freePlaceBtn.classList.toggle("active", willFree);
      // When active we're in free-place mode → snap is OFF.
      this.host.onSnapToTileToggle(!willFree);
    });
  }

  /** Host calls this when the eyedropper state flips (either button click
   *  or keyboard shortcut). Keeps the button visually in sync. */
  setEyedropperArmed(armed: boolean): void {
    this.eyedropperBtn.classList.toggle("active", armed);
  }

  /** Host calls this after the eyedropper resolves a pick and arms the
   *  corresponding placer. We switch to the owning tab, look up the name
   *  from the cached catalog (fall back to a generic label), and render
   *  the armed banner so the UI matches the placer's real state. */
  onPickedEntity(tab: ModelTab, id: number, fallbackName: string): void {
    this.setTab(tab);
    const state = this.tabStates[tab];
    // Catalog may not have finished loading yet (user picked a baked loc
    // before ever opening the Objects tab). In that case kick it off and
    // fill the banner with the fallback name for now.
    const entry =
      state.catalog?.find((e) => e.id === id) ?? ({ id, name: fallbackName } as NamedEntry);
    this.armEntry(tab, entry);
    // Scroll the results so the armed entry is visible once the catalog
    // loads (if it wasn't already).
    if (!state.catalog) {
      void this.loadCatalog(tab).then(() => {
        const resolved = this.tabStates[tab].catalog?.find((e) => e.id === id);
        if (resolved) this.armEntry(tab, resolved);
      });
    }
  }

  private setTab(tab: ModelTab): void {
    this.activeTab = tab;
    for (const [k, btn] of Object.entries(this.tabBtns)) {
      btn.classList.toggle("active", k === tab);
    }
    for (const [k, p] of Object.entries(this.panels)) {
      p.classList.toggle("active", k === tab);
    }
    // Lazy catalog load on first view of a data-driven tab.
    if (tab === "object" && !this.tabStates.object.catalog) {
      void this.loadCatalog("object");
    }
    if (tab === "item" && !this.tabStates.item.catalog) {
      void this.loadCatalog("item");
    }
    if (tab === "spotanim" && !this.tabStates.spotanim.catalog) {
      void this.loadCatalog("spotanim");
    }
    // Switching tabs cancels whatever was armed on the previous one —
    // prevents "I'm on Items but my clicks still place NPCs" confusion.
    this.cancelArmed();
  }

  private async loadCatalog(tab: ModelTab): Promise<void> {
    const loader =
      tab === "npc"
        ? loadNpcCatalog
        : tab === "object"
          ? loadObjectCatalog
          : tab === "item"
            ? loadItemCatalog
            : loadSpotAnimCatalog;
    const label =
      tab === "npc" ? "NPCs" : tab === "object" ? "objects" : tab === "item" ? "items" : "FX";
    this.statusEls[tab].textContent = "loading catalog…";
    try {
      const catalog = (await loader()) as AnyCatalog;
      this.tabStates[tab].catalog = catalog;
      this.statusEls[tab].textContent = `${catalog.length} ${label} — type to search`;
      this.renderResults(tab);
    } catch (err) {
      this.tabStates[tab].error = (err as Error).message;
      this.statusEls[tab].textContent = `catalog error: ${this.tabStates[tab].error}`;
    }
  }

  private renderResults(tab: ModelTab): void {
    const state = this.tabStates[tab];
    if (!state.catalog) return;
    const results = searchEntries(state.catalog as NamedEntry[], state.query, 80);
    const root = this.resultsEls[tab];
    root.innerHTML = "";
    for (const e of results) {
      const row = document.createElement("div");
      row.className = "row-r" + (e.id === state.armedId ? " armed" : "");
      const name = document.createElement("span");
      name.className = "name";
      // Cache names can embed `<col=RRGGBB>…</col>` — render as styled
      // spans rather than showing the raw tag text.
      name.innerHTML = renderOsrsText(e.name);
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = metaLabel(tab, e);
      row.appendChild(name);
      row.appendChild(meta);
      row.addEventListener("click", () => this.armEntry(tab, e));
      root.appendChild(row);
    }
    if (results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "no matches";
      root.appendChild(empty);
    }
  }

  private armEntry(tab: ModelTab, entry: NamedEntry): void {
    // Cancel any other armed tab — only one armed thing at a time.
    this.cancelArmed();
    this.tabStates[tab].armedId = entry.id;
    this.host.onArmEntity(tab, entry);
    const banner = this.armedBanners[tab];
    banner.style.display = "flex";
    banner.innerHTML = `
      <span>placing: <b>${renderOsrsText(entry.name)}</b> <span style="color:#8f9bb5">#${entry.id}</span></span>
      <button type="button">cancel</button>
    `;
    (banner.querySelector("button") as HTMLButtonElement).addEventListener(
      "click",
      () => this.cancelArmed(),
    );
    this.renderResults(tab);
  }

  /** Called by the host when a placement succeeds and place-mode should
   *  end. */
  onPlacedModel(): void {
    this.cancelArmed();
  }

  /** Called from main.ts when the user presses Escape anywhere, or when a
   *  fetch-triggered placement fails. */
  cancelArmed(): void {
    for (const tab of ["npc", "object", "item", "spotanim"] as const) {
      const s = this.tabStates[tab];
      if (s.armedId !== null) {
        s.armedId = null;
        this.armedBanners[tab].style.display = "none";
        this.armedBanners[tab].innerHTML = "";
      }
    }
    this.host.onCancel();
    this.renderResults("npc");
    this.renderResults("object");
    this.renderResults("item");
  }

  /** Host tells us the NPC placer finished loading and surfaced the
   *  available animation menu. We add a `<select>` into the NPC banner
   *  so the user can cycle through standing / walking / rotate variants.
   *  Re-arming with a new animation clears and re-creates the banner, so
   *  this method is called again each time — the select is rebuilt in
   *  place. */
  showNpcAnimationPicker(info: {
    id: number;
    activeAnimationId?: number;
    available: Array<{ id: number; label: string }>;
  }): void {
    const state = this.tabStates.npc;
    if (state.armedId !== info.id) return; // user re-armed something else
    const banner = this.armedBanners.npc;
    banner.querySelector(".animation-picker")?.remove();

    const pickerRoot = document.createElement("div");
    pickerRoot.className = "animation-picker";
    pickerRoot.style.marginTop = "4px";
    pickerRoot.style.display = "flex";
    pickerRoot.style.flexDirection = "column";
    pickerRoot.style.gap = "4px";
    pickerRoot.style.fontSize = "10.5px";

    const armedName = (): string =>
      banner.querySelector<HTMLElement>("b")?.textContent ?? `#${info.id}`;
    const applyAnim = (animId: number): void => {
      this.host.onChangeNpcAnimation(info.id, armedName(), animId);
    };

    // --- Row 1: dropdown of the NPC def's declared animations.
    // Only render when there's an actual choice; some NPCs only have
    // `standingAnimation` and a picker would be noise.
    if (info.available.length > 1) {
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";
      row.innerHTML = `<span style="color:#b3c7a8">anim:</span>`;
      const select = document.createElement("select");
      styleSelect(select);
      for (const a of info.available) {
        const opt = document.createElement("option");
        opt.value = String(a.id);
        opt.textContent = `${a.label} (#${a.id})`;
        if (a.id === info.activeAnimationId) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => applyAnim(Number(select.value)));
      select.addEventListener("keydown", (e) => e.stopPropagation());
      row.appendChild(select);
      pickerRoot.appendChild(row);
    }

    // --- Row 2: collapsible "more…" search over every sequence in the
    // cache. Free-form: users can try emotes/attacks/skilling animations
    // that aren't referenced by the NPC def. Mismatched skeletons will
    // render as a static pose or warp oddly — not our job to police, let
    // the user explore.
    const moreToggle = document.createElement("button");
    moreToggle.type = "button";
    moreToggle.textContent = "more animations ▾";
    moreToggle.style.background = "transparent";
    moreToggle.style.border = "1px solid #4c6b4c";
    moreToggle.style.color = "#b3c7a8";
    moreToggle.style.font = "inherit";
    moreToggle.style.padding = "2px 6px";
    moreToggle.style.borderRadius = "3px";
    moreToggle.style.cursor = "pointer";
    moreToggle.style.alignSelf = "flex-start";
    pickerRoot.appendChild(moreToggle);

    const searchPanel = document.createElement("div");
    searchPanel.style.display = "none";
    searchPanel.style.flexDirection = "column";
    searchPanel.style.gap = "4px";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "name or #id (e.g. 'fire', '711')…";
    styleInput(searchInput);
    searchInput.addEventListener("keydown", (e) => e.stopPropagation());
    const results = document.createElement("div");
    results.style.maxHeight = "160px";
    results.style.overflowY = "auto";
    results.style.background = "rgba(8,10,16,0.6)";
    results.style.border = "1px solid #1c2235";
    results.style.borderRadius = "3px";
    searchPanel.appendChild(searchInput);
    searchPanel.appendChild(results);
    pickerRoot.appendChild(searchPanel);

    /** Render search results for the current query. When the full catalog
     *  hasn't loaded yet we fall back to just the named seed set; after
     *  the fetch completes we re-render against the combined catalog +
     *  names. */
    const render = (catalog: SequenceCatalogEntry[] | null): void => {
      const q = searchInput.value.trim().toLowerCase();
      const rows: Array<{ id: number; label: string; frameCount?: number }> = [];
      const seen = new Set<number>();
      // Seed: the static known-names table. We always want these visible
      // even before the full catalog arrives.
      for (const n of knownNamedAnimations()) {
        if (!matches(n.id, n.name, q)) continue;
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        rows.push({ id: n.id, label: n.name });
      }
      if (catalog) {
        for (const e of catalog) {
          if (seen.has(e.id)) continue;
          const name = animationName(e.id);
          const label = name ?? `#${e.id}`;
          if (!matches(e.id, label, q)) continue;
          seen.add(e.id);
          rows.push({ id: e.id, label, frameCount: e.frameCount });
          if (rows.length > 120) break;
        }
      }
      results.innerHTML = "";
      if (rows.length === 0) {
        const empty = document.createElement("div");
        empty.style.padding = "4px 6px";
        empty.style.color = "#8f9bb5";
        empty.textContent = catalog ? "no matches" : "loading catalog…";
        results.appendChild(empty);
        return;
      }
      for (const r of rows) {
        const row = document.createElement("div");
        row.style.padding = "2px 6px";
        row.style.cursor = "pointer";
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.borderBottom = "1px solid #14192a";
        row.style.color =
          r.id === info.activeAnimationId ? "#e8f5e8" : "#d5dce8";
        row.style.background =
          r.id === info.activeAnimationId ? "#2d4b2d" : "transparent";
        const name = document.createElement("span");
        name.textContent = r.label;
        name.style.overflow = "hidden";
        name.style.textOverflow = "ellipsis";
        name.style.whiteSpace = "nowrap";
        const meta = document.createElement("span");
        meta.style.color = "#8f9bb5";
        meta.style.flexShrink = "0";
        meta.textContent =
          r.frameCount !== undefined
            ? `${r.frameCount}f · #${r.id}`
            : `#${r.id}`;
        row.addEventListener("mouseenter", () => {
          if (r.id !== info.activeAnimationId) row.style.background = "#1a2138";
        });
        row.addEventListener("mouseleave", () => {
          if (r.id !== info.activeAnimationId)
            row.style.background = "transparent";
        });
        row.addEventListener("click", () => applyAnim(r.id));
        row.appendChild(name);
        row.appendChild(meta);
        results.appendChild(row);
      }
    };

    // Kick off the catalog load lazily — only when the user expands the
    // section. ~8k entries, ~100 KB JSON; no point fetching until needed.
    let catalog: SequenceCatalogEntry[] | null = null;
    let expanded = false;
    let catalogRequested = false;
    moreToggle.addEventListener("click", () => {
      expanded = !expanded;
      searchPanel.style.display = expanded ? "flex" : "none";
      moreToggle.textContent = expanded
        ? "more animations ▴"
        : "more animations ▾";
      if (expanded && !catalogRequested) {
        catalogRequested = true;
        render(catalog);
        void loadSequenceCatalog()
          .then((c) => {
            catalog = c;
            render(catalog);
          })
          .catch(() => {
            // leave the seed-set view in place on catalog failure
          });
      } else if (expanded) {
        render(catalog);
      }
    });
    searchInput.addEventListener("input", () => render(catalog));

    banner.appendChild(pickerRoot);
  }

  /** Host tells us rotation changed via R keypress. Reflected in the banner
   *  so the user sees the pending orientation before clicking. */
  setRotation(rot: number): void {
    for (const tab of ["npc", "object", "item", "spotanim"] as const) {
      const s = this.tabStates[tab];
      if (s.armedId === null) continue;
      const banner = this.armedBanners[tab];
      const rotSpan = banner.querySelector<HTMLSpanElement>(".rot");
      if (rotSpan) {
        rotSpan.textContent = `· rot ${rot * 45}°`;
      } else {
        const rotEl = document.createElement("span");
        rotEl.className = "rot";
        rotEl.style.color = "#8f9bb5";
        rotEl.style.marginLeft = "6px";
        rotEl.textContent = `· rot ${rot * 45}°`;
        const label = banner.querySelector<HTMLSpanElement>("span");
        if (label) label.appendChild(rotEl);
      }
    }
  }
}

function metaLabel(tab: ModelTab, e: NamedEntry): string {
  if (tab === "npc") {
    const n = e as NpcCatalogEntry;
    const cb = n.combatLevel >= 0 ? `lvl ${n.combatLevel}` : "";
    return [cb, `#${n.id}`].filter(Boolean).join(" · ");
  }
  if (tab === "object") {
    const o = e as ObjectCatalogEntry;
    const typeName = modelTypeName(o.modelType);
    const size = o.sizeX !== 1 || o.sizeY !== 1 ? `${o.sizeX}×${o.sizeY}` : "";
    return [typeName, size, `#${o.id}`].filter(Boolean).join(" · ");
  }
  if (tab === "spotanim") {
    const s = e as SpotAnimCatalogEntry;
    const animFlag = s.hasAnimation ? "anim" : "";
    return [animFlag, `#${s.id}`].filter(Boolean).join(" · ");
  }
  const it = e as ItemCatalogEntry;
  const flags = [it.members ? "mem" : "", it.stackable ? "stack" : ""].filter(Boolean).join("/");
  return [flags, `#${it.id}`].filter(Boolean).join(" · ");
}

function modelTypeName(t: number): string {
  if (t >= 0 && t <= 3) return "wall";
  if (t >= 4 && t <= 8) return "wall-dec";
  if (t === 9) return "diag-wall";
  if (t === 10 || t === 11) return "scenery";
  if (t === 22) return "floor";
  return `type ${t}`;
}

function styleSelect(el: HTMLSelectElement): void {
  el.style.background = "#10131d";
  el.style.color = "#e8f5e8";
  el.style.border = "1px solid #4c6b4c";
  el.style.borderRadius = "3px";
  el.style.padding = "1px 4px";
  el.style.font = "inherit";
  el.style.flex = "1";
}

function styleInput(el: HTMLInputElement): void {
  el.style.background = "#10131d";
  el.style.color = "#e6e8ec";
  el.style.border = "1px solid #2a334a";
  el.style.borderRadius = "3px";
  el.style.padding = "3px 6px";
  el.style.font = "inherit";
  el.style.outline = "none";
}

/** Return `true` if the query matches the sequence id or its friendly name.
 *  Accepts bare integers (with optional `#`) and case-insensitive substring
 *  matches on the label. Empty query matches everything. */
function matches(id: number, label: string, query: string): boolean {
  if (query.length === 0) return true;
  const digits = query.replace(/^#/, "");
  if (/^\d+$/.test(digits)) {
    return String(id).includes(digits);
  }
  return label.toLowerCase().includes(query);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

/**
 * Render a cache-sourced name with OSRS inline color tags (`<col=RRGGBB>…</col>`)
 * as safe HTML — the colored runs become styled `<span>`s, other bracket
 * shapes (stray `<br>`, `<shad=…>`) are stripped quietly. Returns an HTML
 * string the caller drops into `innerHTML`.
 *
 * Regex-gated hex in the inline `style` keeps this injection-free: only
 * `[0-9a-fA-F]` reaches the CSS, other characters can't ride in.
 */
function renderOsrsText(raw: string): string {
  let html = "";
  const colorStack: string[] = [];
  let i = 0;
  const emit = (text: string): void => {
    if (!text) return;
    const escaped = escapeHtml(text);
    if (colorStack.length === 0) {
      html += escaped;
    } else {
      html += `<span style="color:#${colorStack[colorStack.length - 1]}">${escaped}</span>`;
    }
  };
  while (i < raw.length) {
    const lt = raw.indexOf("<", i);
    if (lt === -1) {
      emit(raw.slice(i));
      break;
    }
    if (lt > i) emit(raw.slice(i, lt));
    const gt = raw.indexOf(">", lt + 1);
    if (gt === -1) {
      // Unterminated `<` — treat the rest as text so it shows up escaped
      // rather than disappearing.
      emit(raw.slice(lt));
      break;
    }
    const tag = raw.slice(lt + 1, gt);
    const colorMatch = /^col=([0-9a-fA-F]{3,8})$/.exec(tag);
    if (colorMatch) {
      colorStack.push(colorMatch[1]!);
    } else if (tag === "/col") {
      colorStack.pop();
    }
    // Unknown tags silently skipped.
    i = gt + 1;
  }
  return html;
}
