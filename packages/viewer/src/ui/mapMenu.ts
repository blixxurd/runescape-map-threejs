import { parseSaveBundle, slugify } from "@rsmap/shared/save-file";
import type { SaveClient } from "../saves/saveClient.js";
import type { SaveStore } from "../saves/saveStore.js";

/**
 * Head-bar map control: shows the active save's name plus a dirty dot, and
 * opens a dropdown with New / Open / Save / Save as / Export / Import /
 * Delete.
 *
 * Every destructive action (New, Open, Delete, Import) confirms first when
 * the store is dirty. The control disables itself when no dev server is
 * present — a static build can render a map but can't persist one.
 */

export interface MapMenuOptions {
  store: SaveStore;
  client: SaveClient;
  /** Reload every loaded region from disk (vanilla bundles). */
  reloadRegions: () => Promise<void>;
  /** Status line for feedback ("saved", "load failed: …"). */
  setStatus: (msg: string) => void;
}

export class MapMenu {
  private readonly opts: MapMenuOptions;
  private readonly button = document.createElement("button");
  private readonly dropdown = document.createElement("div");
  private available = false;
  /** `SaveStore.load()` deliberately doesn't round-trip `createdAt` — the
   *  menu holds it externally across save/load/save-as so a re-save keeps
   *  the original creation timestamp instead of stamping "now" every time. */
  private createdAt: string | null = null;

  constructor(opts: MapMenuOptions) {
    this.opts = opts;
    this.button.className = "head-btn map-btn";
    this.button.type = "button";
    this.button.title = "map saves";
    this.button.addEventListener("click", () => void this.toggle());
    this.dropdown.className = "map-dropdown";
    this.dropdown.style.display = "none";
    opts.store.onChange = () => this.refresh();
    void opts.client.isAvailable().then((ok) => {
      this.available = ok;
      this.refresh();
    });
  }

  mount(slot: HTMLElement): void {
    slot.appendChild(this.button);
    slot.appendChild(this.dropdown);
    this.refresh();
  }

  refresh(): void {
    const { name } = this.opts.store.getIdentity();
    const dirty = this.opts.store.isDirty() ? " •" : "";
    this.button.textContent = `map: ${name ?? "untitled"}${dirty}`;
    this.button.disabled = !this.available;
    this.button.title = this.available
      ? "map saves"
      : "saves need the dev server (pnpm dev)";
  }

  private async toggle(): Promise<void> {
    if (this.dropdown.style.display === "block") {
      this.dropdown.style.display = "none";
      return;
    }
    this.dropdown.replaceChildren();
    const add = (label: string, onClick: () => void | Promise<void>): void => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "map-item";
      item.textContent = label;
      item.addEventListener("click", () => {
        this.dropdown.style.display = "none";
        void onClick();
      });
      this.dropdown.appendChild(item);
    };

    add("New map", () => this.newMap());
    add("Save", () => this.save());
    add("Save as…", () => this.saveAs());
    add("Export", () => this.exportFile());
    add("Import", () => this.importFile());
    if (this.opts.store.getIdentity().slug) add("Delete", () => this.deleteActive());

    const saves = await this.opts.client.list().catch(() => []);
    if (saves.length > 0) {
      const sep = document.createElement("div");
      sep.className = "map-sep";
      sep.textContent = "open";
      this.dropdown.appendChild(sep);
      for (const s of saves) {
        add(`${s.name} (${s.regions.length} region${s.regions.length === 1 ? "" : "s"})`, () =>
          this.open(s.slug),
        );
      }
    }
    this.dropdown.style.display = "block";
  }

  private confirmDiscard(): boolean {
    if (!this.opts.store.isDirty()) return true;
    return window.confirm("Discard unsaved changes to the current map?");
  }

  private async newMap(): Promise<void> {
    if (!this.confirmDiscard()) return;
    this.opts.store.clear();
    this.createdAt = null;
    await this.opts.reloadRegions();
    this.opts.setStatus("new map");
  }

  private async open(slug: string): Promise<void> {
    if (!this.confirmDiscard()) return;
    try {
      const bundle = await this.opts.client.read(slug);
      this.opts.store.clear();
      this.opts.store.load(bundle);
      this.createdAt = bundle.manifest.createdAt;
      await this.opts.reloadRegions();
      localStorage.setItem("rsmap.lastSave", slug);
      this.opts.setStatus(`opened ${bundle.manifest.name}`);
    } catch (err) {
      this.opts.setStatus(`open failed: ${(err as Error).message}`);
    }
  }

  private async save(): Promise<void> {
    const { slug, name } = this.opts.store.getIdentity();
    if (!slug || !name) return this.saveAs();
    await this.writeAs(name, slug);
  }

  private async saveAs(): Promise<void> {
    const suggested = this.opts.store.getIdentity().name ?? "untitled";
    const name = window.prompt("Save map as:", suggested);
    if (!name) return;
    const slug = slugify(name);
    const existing = await this.opts.client.list().catch(() => []);
    if (
      existing.some((s) => s.slug === slug) &&
      slug !== this.opts.store.getIdentity().slug &&
      !window.confirm(`"${slug}" already exists. Overwrite?`)
    ) {
      return;
    }
    this.createdAt = null;
    await this.writeAs(name, slug);
  }

  private async writeAs(name: string, slug: string): Promise<void> {
    try {
      const bundle = this.opts.store.serialize({
        name,
        slug,
        createdAt: this.createdAt ?? undefined,
      });
      await this.opts.client.write(bundle);
      // Only after a successful write do we adopt the new identity and mark
      // clean — a failed write must leave the store exactly as dirty as it
      // was, so nothing is silently lost.
      this.createdAt = bundle.manifest.createdAt;
      this.opts.store.setIdentity(slug, name);
      this.opts.store.markClean();
      localStorage.setItem("rsmap.lastSave", slug);
      const { regions, placements, removes } = this.opts.store.stats();
      this.opts.setStatus(
        `saved ${name} — ${placements} placement(s), ${removes} remove(s), ${regions} region(s)`,
      );
    } catch (err) {
      this.opts.setStatus(`save failed: ${(err as Error).message}`);
    }
  }

  private exportFile(): void {
    const { slug, name } = this.opts.store.getIdentity();
    const bundle = this.opts.store.serialize({
      name: name ?? "untitled",
      slug: slug ?? "untitled",
      createdAt: this.createdAt ?? undefined,
    });
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${bundle.manifest.slug}.rsmap.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private importFile(): void {
    if (!this.confirmDiscard()) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (text) => {
        try {
          // `SaveClient.read` validates on the network path; validate here
          // too before trusting an arbitrary file off disk.
          const parsed = parseSaveBundle(JSON.parse(text) as unknown);
          this.opts.store.clear();
          this.opts.store.load(parsed);
          this.createdAt = parsed.manifest.createdAt;
          await this.opts.reloadRegions();
          this.opts.setStatus(`imported ${parsed.manifest.name} (unsaved)`);
        } catch (err) {
          this.opts.setStatus(`import failed: ${(err as Error).message}`);
        }
      });
    });
    input.click();
  }

  private async deleteActive(): Promise<void> {
    const { slug, name } = this.opts.store.getIdentity();
    if (!slug) return;
    if (!window.confirm(`Delete save "${name ?? slug}"? This removes it from disk.`)) return;
    try {
      await this.opts.client.remove(slug);
      if (localStorage.getItem("rsmap.lastSave") === slug) {
        localStorage.removeItem("rsmap.lastSave");
      }
      this.opts.store.clear();
      this.createdAt = null;
      await this.opts.reloadRegions();
      this.opts.setStatus(`deleted ${slug}`);
    } catch (err) {
      this.opts.setStatus(`delete failed: ${(err as Error).message}`);
    }
  }
}
