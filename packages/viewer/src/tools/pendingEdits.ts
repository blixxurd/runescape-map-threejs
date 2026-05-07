import type { EditsOverlayAdd } from "@rsmap/shared";

/**
 * In-memory diff vs. the currently-baked region bundle. Lives for the
 * length of a viewer session — closing the tab without committing throws
 * pending edits away (the `beforeunload` warning in main.ts gives the user
 * a chance to abort).
 *
 * "Commit" semantics are intentional: edits accumulate here without ever
 * touching disk, the user clicks the toolbar button to fire one batched
 * `POST /api/dev/commit-edits` per affected region, and successful commits
 * empty the store for that region while the bundle reloads.
 *
 * Add identity: adds are tracked by their `EditsOverlayAdd` object
 * reference (Set, not array). Callers (ModelPlacer hook) keep a stable
 * reference and mutate the add's fields in place when the placement's
 * pose changes — `snapshot()` then sees the latest values without the
 * caller needing to thread a stable id through. This avoids index-shift
 * bookkeeping when one add gets removed mid-session.
 */
export interface RegionDiff {
  /** Hex placement IDs to tombstone. */
  removes: string[];
  adds: EditsOverlayAdd[];
}

export class PendingEdits {
  private readonly removesByRegion = new Map<number, Set<string>>();
  private readonly addsByRegion = new Map<number, Set<EditsOverlayAdd>>();

  /** Notified after every mutation so the toolbar can enable/disable the
   *  commit button + update its "(N changes)" badge. */
  onChange: (() => void) | null = null;

  addRemove(regionId: number, placementIdHex: string): void {
    let set = this.removesByRegion.get(regionId);
    if (!set) {
      set = new Set();
      this.removesByRegion.set(regionId, set);
    }
    if (set.has(placementIdHex)) return;
    set.add(placementIdHex);
    this.onChange?.();
  }

  /** Undo a previously-recorded remove (e.g. user pressed Cmd+Z if we ever
   *  wire that up — not in v1, but the store supports it cheaply). */
  removeRemove(regionId: number, placementIdHex: string): boolean {
    const set = this.removesByRegion.get(regionId);
    if (!set || !set.has(placementIdHex)) return false;
    set.delete(placementIdHex);
    if (set.size === 0) this.removesByRegion.delete(regionId);
    this.onChange?.();
    return true;
  }

  /** Register a new add. Caller retains the `EditsOverlayAdd` reference and
   *  mutates `tileX/tileZ/rotation` in place when the placement's pose
   *  changes — the same reference is held in the Set, so snapshot() picks
   *  up the latest values automatically. */
  addAdd(regionId: number, add: EditsOverlayAdd): void {
    let set = this.addsByRegion.get(regionId);
    if (!set) {
      set = new Set();
      this.addsByRegion.set(regionId, set);
    }
    set.add(add);
    this.onChange?.();
  }

  /** Drop an add by its tracked reference. Returns false if the add wasn't
   *  registered for that region (shouldn't happen, but keeps callers safe). */
  deleteAdd(regionId: number, add: EditsOverlayAdd): boolean {
    const set = this.addsByRegion.get(regionId);
    if (!set || !set.has(add)) return false;
    set.delete(add);
    if (set.size === 0) this.addsByRegion.delete(regionId);
    this.onChange?.();
    return true;
  }

  /** Manually fire onChange — callers use this when an add's fields were
   *  mutated in place and consumers (e.g. the commit-button badge) need
   *  to re-read the count. */
  notifyChange(): void {
    this.onChange?.();
  }

  isPending(): boolean {
    for (const s of this.removesByRegion.values()) if (s.size > 0) return true;
    for (const a of this.addsByRegion.values()) if (a.size > 0) return true;
    return false;
  }

  /** Total number of pending changes across all regions, for UI badges. */
  count(): number {
    let n = 0;
    for (const s of this.removesByRegion.values()) n += s.size;
    for (const a of this.addsByRegion.values()) n += a.size;
    return n;
  }

  /** Read-only snapshot keyed by region. Returns a fresh map each call so
   *  callers can iterate while we mutate (e.g. clear-on-success during
   *  commit). Add objects in the snapshot are SHARED references with the
   *  store — mutating them will also affect a later snapshot, which is
   *  intentional for the "drag committed placement" case but means you
   *  shouldn't deep-clone before sending: `JSON.stringify(snapshot)` on
   *  the wire is the right safe boundary. Empty regions are omitted. */
  snapshot(): Map<number, RegionDiff> {
    const out = new Map<number, RegionDiff>();
    for (const [regionId, set] of this.removesByRegion) {
      if (set.size === 0) continue;
      out.set(regionId, { removes: Array.from(set), adds: [] });
    }
    for (const [regionId, set] of this.addsByRegion) {
      if (set.size === 0) continue;
      const existing = out.get(regionId);
      if (existing) existing.adds = Array.from(set);
      else out.set(regionId, { removes: [], adds: Array.from(set) });
    }
    return out;
  }

  /** Clear pending edits for one region (called after a successful commit
   *  for that region). Doesn't fire onChange if there was nothing pending. */
  clear(regionId: number): void {
    const hadRemoves = this.removesByRegion.delete(regionId);
    const hadAdds = this.addsByRegion.delete(regionId);
    if (hadRemoves || hadAdds) this.onChange?.();
  }

  /** Region IDs with at least one pending change. Used by the commit
   *  flow to know which regions to POST. */
  affectedRegions(): number[] {
    const set = new Set<number>();
    for (const [r, s] of this.removesByRegion) if (s.size > 0) set.add(r);
    for (const [r, a] of this.addsByRegion) if (a.size > 0) set.add(r);
    return Array.from(set);
  }
}
