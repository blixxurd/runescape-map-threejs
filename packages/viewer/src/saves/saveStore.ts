import * as THREE from "three";
import {
  SAVE_SCHEMA,
  type SaveBundle,
  type SaveRegionFile,
  type SavedPlacement,
  type SavedPlacementKind,
  emptyRegionFile,
  isRegionFileEmpty,
} from "@rsmap/shared/save-file";
import type { Placer } from "../tools/placerTypes.js";
import { buildPlacementIndex, hideSlot } from "../locs/hideLoc.js";
import {
  regionLocalToWorld,
  regionOriginFor,
  worldToRegionId,
  worldToRegionLocal,
} from "./saveModel.js";

/**
 * The active map save, in memory.
 *
 * Two kinds of content: `removes` (baked locs hidden by placement id) and
 * `placements` (entities the user dropped, across all four placer kinds).
 * Both are stored per region in region-local coordinates, so the same save
 * loads identically regardless of which region the viewer centred on.
 *
 * The store owns no scene state beyond a mesh↔placement mapping. Applying
 * to a region and detaching from one are explicit calls made by main.ts's
 * streaming loader, because only it knows when a region's groups exist.
 *
 * Replaces the old `PendingEdits`: there is no separate "pending" concept
 * any more — the store IS the map, and `isDirty()` tracks whether it has
 * been written to disk since the last change.
 */

export interface SaveStoreHost {
  centerRegionX: number;
  centerRegionZ: number;
  /** Placer that owns a given entity kind, or null if unavailable. */
  placerFor: (kind: SavedPlacementKind) => Placer | null;
  /** Loaded region's scene handles, or undefined if it isn't loaded. */
  getLoadedRegion: (
    regionId: number,
  ) => { offsetX: number; offsetZ: number; locsGroup: THREE.Object3D } | undefined;
}

export interface TrackSpawnInfo {
  kind: SavedPlacementKind;
  id: number;
  plane: number;
  type?: number;
  animationOverride?: number | null;
}

interface RegionSlice {
  removes: Set<string>;
  placements: Set<SavedPlacement>;
}

export interface ApplyResult {
  hidden: number;
  spawned: number;
  /** Placements whose entity id wouldn't bake on this cache build. */
  skipped: number;
}

export class SaveStore {
  private readonly host: SaveStoreHost;
  private readonly byRegion = new Map<number, RegionSlice>();
  private readonly byMesh = new Map<THREE.Mesh, { regionId: number; data: SavedPlacement }>();
  /** Regions with an `applyToRegion` call currently in flight. Guards
   *  against a second apply starting for the same region before the first
   *  one's spawn chain finishes — see the comment in `applyToRegion`. */
  private readonly applying = new Set<number>();
  /** Bumped by `detachRegion` for the region it unloads. Lets an in-flight
   *  `applyToRegion` notice, after each await, that the region it's
   *  spawning into has since gone away — see `applyToRegion`. */
  private readonly generation = new Map<number, number>();
  private dirty = false;
  private slug: string | null = null;
  private name: string | null = null;

  /** Fired after every mutation so the map menu can refresh its label. */
  onChange: (() => void) | null = null;

  constructor(host: SaveStoreHost) {
    this.host = host;
  }

  getIdentity(): { slug: string | null; name: string | null } {
    return { slug: this.slug, name: this.name };
  }

  setIdentity(slug: string, name: string): void {
    this.slug = slug;
    this.name = name;
    this.onChange?.();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
    this.onChange?.();
  }

  stats(): { regions: number; placements: number; removes: number } {
    let placements = 0;
    let removes = 0;
    for (const slice of this.byRegion.values()) {
      placements += slice.placements.size;
      removes += slice.removes.size;
    }
    return { regions: this.byRegion.size, placements, removes };
  }

  private slice(regionId: number): RegionSlice {
    let s = this.byRegion.get(regionId);
    if (!s) {
      s = { removes: new Set(), placements: new Set() };
      this.byRegion.set(regionId, s);
    }
    return s;
  }

  private touched(): void {
    this.dirty = true;
    this.onChange?.();
  }

  private generationFor(regionId: number): number {
    return this.generation.get(regionId) ?? 0;
  }

  /** Region + local coords for a world position, or null when the position
   *  falls off the addressable cache grid. */
  private locate(
    position: THREE.Vector3,
  ): { regionId: number; local: { x: number; y: number; z: number } } | null {
    const regionId = worldToRegionId(
      position.x,
      position.z,
      this.host.centerRegionX,
      this.host.centerRegionZ,
    );
    if (regionId === null) return null;
    const origin = regionOriginFor(regionId, this.host.centerRegionX, this.host.centerRegionZ);
    return { regionId, local: worldToRegionLocal(position, origin) };
  }

  /** Record a newly placed mesh. Called from the placers' spawn hook. */
  trackSpawn(mesh: THREE.Mesh, info: TrackSpawnInfo): void {
    const located = this.locate(mesh.position);
    if (!located) {
      console.warn("[saves] placement outside the cache grid — not tracked");
      return;
    }
    const data: SavedPlacement = {
      kind: info.kind,
      id: info.id,
      plane: info.plane,
      x: located.local.x,
      y: located.local.y,
      z: located.local.z,
      rotationY: mesh.rotation.y,
    };
    if (info.type !== undefined) data.type = info.type;
    if (info.animationOverride !== undefined) {
      data.animationOverride = info.animationOverride;
    }
    this.slice(located.regionId).placements.add(data);
    this.byMesh.set(mesh, { regionId: located.regionId, data });
    this.touched();
  }

  /** Re-read a tracked mesh's pose after a gizmo drag, numeric edit, or
   *  arrow nudge — including re-attributing it to a different region when
   *  it crossed a seam. */
  updateFromMesh(mesh: THREE.Mesh): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    const located = this.locate(mesh.position);
    if (!located) return;
    if (located.regionId !== tracked.regionId) {
      this.slice(tracked.regionId).placements.delete(tracked.data);
      this.slice(located.regionId).placements.add(tracked.data);
      tracked.regionId = located.regionId;
    }
    tracked.data.x = located.local.x;
    tracked.data.y = located.local.y;
    tracked.data.z = located.local.z;
    tracked.data.rotationY = mesh.rotation.y;
    this.touched();
  }

  /** Forget a placement entirely (user deleted it). */
  untrack(mesh: THREE.Mesh): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    this.slice(tracked.regionId).placements.delete(tracked.data);
    this.byMesh.delete(mesh);
    this.touched();
  }

  /** Per-placement animation override changed via the inspector. */
  setAnimationOverride(mesh: THREE.Mesh, animationId: number): void {
    const tracked = this.byMesh.get(mesh);
    if (!tracked) return;
    tracked.data.animationOverride = animationId;
    this.touched();
  }

  addRemove(regionId: number, placementIdHex: string): void {
    const slice = this.slice(regionId);
    if (slice.removes.has(placementIdHex)) return;
    slice.removes.add(placementIdHex);
    this.touched();
  }

  removeRemove(regionId: number, placementIdHex: string): boolean {
    const slice = this.byRegion.get(regionId);
    if (!slice?.removes.delete(placementIdHex)) return false;
    this.touched();
    return true;
  }

  /**
   * Apply this save's slice of `regionId` to a freshly loaded region:
   * hide tombstoned baked locs, then re-materialize placements through
   * their placers. Safe to call when the save has nothing for the region.
   */
  async applyToRegion(regionId: number): Promise<ApplyResult> {
    const result: ApplyResult = { hidden: 0, spawned: 0, skipped: 0 };
    const slice = this.byRegion.get(regionId);
    if (!slice) return result;
    const loaded = this.host.getLoadedRegion(regionId);
    if (!loaded) return result;
    // Guard (a): bail if this region already has an apply in flight. Without
    // this, fast pan-away-and-back can start a second `applyToRegion` for
    // the same region while the first is still awaiting spawns, aliasing
    // one `SavedPlacement` to two meshes.
    if (this.applying.has(regionId)) return result;
    this.applying.add(regionId);
    // Snapshot the region's generation. `detachRegion` bumps it when the
    // region unloads. If it moves while we're mid-await below, this apply
    // is stale — the region left (and maybe came back) since we started,
    // so a mesh spawned under the old generation must not be registered:
    // nothing will ever call `detachRegion` for *this* spawn again, so a
    // registered stray would leak forever. Guard (b), checked after every
    // await in the spawn loop.
    const generation = this.generationFor(regionId);

    try {
      if (slice.removes.size > 0) {
        const index = buildPlacementIndex(loaded.locsGroup);
        if (index.size === 0) {
          console.warn(
            `[saves] region ${regionId} bundle has no placementIds — ${slice.removes.size} removes skipped (re-extract to upgrade)`,
          );
        }
        for (const hex of slice.removes) {
          const slot = index.get(hex);
          if (!slot) continue;
          hideSlot(slot);
          result.hidden++;
        }
      }

      const origin = { offsetX: loaded.offsetX, offsetZ: loaded.offsetZ };
      // Spawn sequentially per placement but let identical ids share one
      // fetch — the placer's own cache handles that, so a plain loop is
      // enough and keeps ordering deterministic.
      for (const data of slice.placements) {
        const placer = this.host.placerFor(data.kind);
        if (!placer) {
          result.skipped++;
          continue;
        }
        const world = regionLocalToWorld(data, origin);
        const mesh = await placer.spawnAt({
          id: data.id,
          position: world,
          rotationY: data.rotationY,
          plane: data.plane,
          animationOverride: data.animationOverride ?? null,
          notify: false,
        });
        if (!mesh) {
          result.skipped++;
          continue;
        }
        if (this.generationFor(regionId) !== generation) {
          // Region detached while `spawnAt` was in flight — discard the
          // orphaned mesh instead of registering it (see guard (b) above).
          placer.removeMesh(mesh);
          result.skipped++;
          continue;
        }
        this.byMesh.set(mesh, { regionId, data });
        result.spawned++;
      }
    } finally {
      this.applying.delete(regionId);
    }
    return result;
  }

  /**
   * Remove the meshes this save spawned for a region that is unloading.
   * Store data is untouched — re-entering the region respawns them.
   *
   * Ordering matters: `placer.removeMesh()` below fires the placer's
   * `onMeshRemoved` hook, which is wired to `saveStore.untrack(mesh)`.
   * That re-entrant call runs synchronously, inside this loop, before
   * `removeMesh` returns. If we called `removeMesh` first and deleted the
   * `byMesh` entry after, the re-entrant `untrack` would still find the
   * entry and delete the placement from `byRegion` — silently erasing
   * saved data just because its region streamed out on a routine pan.
   * Deleting `byMesh` FIRST makes the re-entrant `untrack` a no-op (its
   * own lookup misses), so only this method's own iteration removes the
   * mesh from the scene. Do not reorder these two lines.
   */
  detachRegion(regionId: number): void {
    this.generation.set(regionId, this.generationFor(regionId) + 1);
    for (const [mesh, tracked] of [...this.byMesh]) {
      if (tracked.regionId !== regionId) continue;
      this.byMesh.delete(mesh);
      const placer = this.host.placerFor(tracked.data.kind);
      placer?.removeMesh(mesh);
    }
  }

  /**
   * Drop every mesh and every record — "New map". Callers reload regions
   * afterwards to restore hidden baked locs.
   *
   * `removeMesh` can re-enter `untrack` here too (see `detachRegion`), but
   * it's harmless: we iterate a snapshot array (`[...this.byMesh]`) taken
   * before the loop starts, so a re-entrant `byMesh.delete()` during
   * iteration can't corrupt or skip entries in that snapshot, and
   * `byMesh.clear()` + `byRegion.clear()` after the loop drop everything
   * regardless of what the re-entrant call already removed.
   */
  clear(): void {
    for (const [mesh, tracked] of [...this.byMesh]) {
      this.host.placerFor(tracked.data.kind)?.removeMesh(mesh);
    }
    this.byMesh.clear();
    this.byRegion.clear();
    this.slug = null;
    this.name = null;
    this.dirty = false;
    this.onChange?.();
  }

  /** Replace store contents with a loaded save. Does not touch the scene —
   *  the caller reloads regions, and `applyToRegion` does the rest. */
  load(bundle: SaveBundle): void {
    this.byRegion.clear();
    this.byMesh.clear();
    for (const region of bundle.regions) {
      const slice = this.slice(region.regionId);
      for (const hex of region.removes) slice.removes.add(hex);
      for (const p of region.placements) slice.placements.add({ ...p });
    }
    this.slug = bundle.manifest.slug;
    this.name = bundle.manifest.name;
    this.dirty = false;
    this.onChange?.();
  }

  serialize(identity: { name: string; slug: string; createdAt?: string }): SaveBundle {
    const now = new Date().toISOString();
    const regions: SaveRegionFile[] = [];
    for (const [regionId, slice] of this.byRegion) {
      const file = emptyRegionFile(regionId);
      file.removes = [...slice.removes].sort();
      file.placements = [...slice.placements].map((p) => ({ ...p }));
      if (!isRegionFileEmpty(file)) regions.push(file);
    }
    regions.sort((a, b) => a.regionId - b.regionId);
    return {
      manifest: {
        schemaVersion: SAVE_SCHEMA,
        name: identity.name,
        slug: identity.slug,
        createdAt: identity.createdAt ?? now,
        updatedAt: now,
        regions: regions.map((r) => r.regionId),
      },
      regions,
    };
  }
}
