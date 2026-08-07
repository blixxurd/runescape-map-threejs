import { parseSaveBundle, slugify } from "@rsmap/shared/save-file";
import type { SaveClient } from "../saves/saveClient.js";
import type { SaveStore } from "../saves/saveStore.js";
import type { importLegacyEdits } from "../saves/importLegacyEdits.js";

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
  /** THROWAWAY (see importLegacyEdits.ts). Wired only while migrating the
   *  pre-saves overlay; both this and the module go away afterwards. */
  importLegacy?: (
    overlay: unknown,
    run: typeof importLegacyEdits,
  ) => Promise<{ imported: number; skipped: number }>;
}

export class MapMenu {
  private readonly opts: MapMenuOptions;
  private readonly button = document.createElement("button");
  private readonly dropdown = document.createElement("div");
  private available = false;
  /** Guards `toggle()`'s async dropdown build (it awaits `client.list()`
   *  before it can render). Without this, two clicks landing inside that
   *  await window each rebuild and append their own "open" section,
   *  leaving every save listed twice. */
  private opening = false;
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
    // A second click landing here while the first is still awaiting
    // `client.list()` below must not start a second build — see the
    // `opening` field's doc comment.
    if (this.opening) return;
    this.opening = true;
    try {
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
      if (this.opts.importLegacy) add("Import legacy edits…", () => this.importLegacy());
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
    } finally {
      this.opening = false;
    }
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
    // `fresh: true` tells `writeAs` to stamp a brand-new `createdAt` rather
    // than reuse `this.createdAt` — but only once the write actually
    // succeeds. Resetting `this.createdAt` here, before the write, would
    // lose the *current* save's original timestamp the moment a
    // still-in-flight or failed "Save as…" left it null: a later plain
    // "Save" of the same slug would then stamp `createdAt: now` over a
    // save that still exists on disk with its real, older timestamp.
    await this.writeAs(name, slug, { fresh: true });
  }

  private async writeAs(name: string, slug: string, opts: { fresh?: boolean } = {}): Promise<void> {
    try {
      const bundle = this.opts.store.serialize({
        name,
        slug,
        createdAt: opts.fresh ? undefined : (this.createdAt ?? undefined),
      });
      await this.opts.client.write(bundle);
      // Only after a successful write do we adopt the new identity, the
      // (possibly fresh) createdAt, and mark clean — a failed write must
      // leave the store exactly as dirty as it was, so nothing is silently
      // lost, and `this.createdAt` must keep pointing at whatever save is
      // still the one on disk.
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
          // `load()` deliberately leaves the store clean — autoload and
          // Open both rely on that. An imported file is different: it
          // hasn't been written anywhere the app knows about (Export's
          // download isn't tracked, and `rsmap.lastSave`/`localStorage`
          // still point at whatever was open before), so treat it as an
          // unsaved edit from the moment it lands — the dirty dot, the
          // beforeunload prompt, and the next confirmDiscard() must all
          // reflect that this map is one refresh away from disappearing.
          this.opts.store.markDirty();
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

  /** THROWAWAY (see importLegacyEdits.ts). One-shot file-picker path for
   *  converting `packages/extractor/edits/<id>.json` into live placements
   *  on the active map — the overlay lives outside `public/`, so it's read
   *  through a plain file input rather than a dev-server endpoint. */
  private importLegacy(): void {
    if (!this.opts.importLegacy) return;
    if (!this.confirmDiscard()) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then(async (text) => {
        const { importLegacyEdits } = await import("../saves/importLegacyEdits.js");
        try {
          const result = await this.opts.importLegacy!(
            JSON.parse(text) as unknown,
            importLegacyEdits,
          );
          this.opts.setStatus(
            `legacy import: ${result.imported} placed, ${result.skipped} skipped — save it now`,
          );
        } catch (err) {
          this.opts.setStatus(`legacy import failed: ${(err as Error).message}`);
        }
      });
    });
    input.click();
  }

  private async deleteActive(): Promise<void> {
    const { slug, name } = this.opts.store.getIdentity();
    if (!slug) return;
    // Two separate things can be lost here: unsaved edits sitting on top
    // of the on-disk save (confirmDiscard, same gate as New/Open/Import),
    // and the on-disk save itself (the delete confirm below). Deleting the
    // file doesn't imply the user meant to throw away in-memory changes
    // too, so both must be confirmed independently.
    if (!this.confirmDiscard()) return;
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
