import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { REGION_SPAN } from "@rsmap/shared";
import { SAVE_SCHEMA } from "@rsmap/shared/save-file";
import type { SaveBundle, SavedPlacementKind } from "@rsmap/shared/save-file";
import { SaveStore } from "./saveStore.js";
import type { SaveStoreHost } from "./saveStore.js";
import type { Placer, PlacerKind } from "../tools/placerTypes.js";

const CX = 50;
const CZ = 50;
const EAST_REGION = (51 << 8) | 50;

function makeHost(overrides: Partial<SaveStoreHost> = {}): SaveStoreHost {
  return {
    centerRegionX: CX,
    centerRegionZ: CZ,
    placerFor: () => null,
    getLoadedRegion: () => undefined,
    ...overrides,
  };
}

function meshAt(x: number, y: number, z: number, rotY = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  return mesh;
}

describe("SaveStore tracking", () => {
  it("attributes a placement to the region under it and stores local coords", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(REGION_SPAN + 200, 15, -300);

    store.trackSpawn(mesh, { kind: "object", id: 1278, plane: 0, type: 10 });

    const bundle = store.serialize({ name: "T", slug: "t" });
    const region = bundle.regions.find((r) => r.regionId === EAST_REGION);
    expect(region?.placements[0]).toMatchObject({
      kind: "object",
      id: 1278,
      x: 200,
      y: 15,
      z: -300,
      type: 10,
    });
  });

  it("moves a placement between regions when it crosses a seam", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100);
    store.trackSpawn(mesh, { kind: "npc", id: 3105, plane: 0 });

    mesh.position.x = REGION_SPAN + 50;
    store.updateFromMesh(mesh);

    const bundle = store.serialize({ name: "T", slug: "t" });
    expect(bundle.regions.find((r) => r.regionId === 12850)).toBeUndefined();
    expect(
      bundle.regions.find((r) => r.regionId === EAST_REGION)?.placements[0]?.x,
    ).toBe(50);
  });

  it("drops a placement on untrack", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100);
    store.trackSpawn(mesh, { kind: "item", id: 995, plane: 0 });
    store.untrack(mesh);
    expect(store.serialize({ name: "T", slug: "t" }).regions).toHaveLength(0);
  });

  it("records rotation as a free angle", () => {
    const store = new SaveStore(makeHost());
    const mesh = meshAt(100, 0, -100, Math.PI / 4);
    store.trackSpawn(mesh, { kind: "object", id: 1278, plane: 0, type: 10 });
    expect(
      store.serialize({ name: "T", slug: "t" }).regions[0]!.placements[0]!.rotationY,
    ).toBeCloseTo(Math.PI / 4);
  });
});

describe("SaveStore dirty state", () => {
  it("starts clean and goes dirty on the first mutation", () => {
    const store = new SaveStore(makeHost());
    expect(store.isDirty()).toBe(false);
    store.addRemove(12850, "0000001a");
    expect(store.isDirty()).toBe(true);
  });

  it("fires onChange for every mutation", () => {
    const store = new SaveStore(makeHost());
    const spy = vi.fn();
    store.onChange = spy;
    store.addRemove(12850, "0000001a");
    store.trackSpawn(meshAt(0, 0, 0), { kind: "npc", id: 1, plane: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("is clean again after markClean", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.markClean();
    expect(store.isDirty()).toBe(false);
  });
});

describe("SaveStore serialization", () => {
  it("round-trips through serialize and load", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.trackSpawn(meshAt(300, 12, -400, 1.5), {
      kind: "object",
      id: 1278,
      plane: 0,
      type: 10,
    });
    const bundle = store.serialize({ name: "Lumbridge Raid", slug: "lumbridge-raid" });

    const reloaded = new SaveStore(makeHost());
    reloaded.load(bundle);

    const reserialized = reloaded.serialize({ name: "Lumbridge Raid", slug: "lumbridge-raid" });
    // Compare regions rather than the whole bundle: two serialize() calls
    // can straddle a clock tick, making `updatedAt` differ by a
    // millisecond even though nothing else changed.
    expect(reserialized.regions).toEqual(bundle.regions);
    expect(bundle.manifest.schemaVersion).toBe(SAVE_SCHEMA);
    expect(bundle.regions[0]!.removes).toEqual(["0000001a"]);
  });

  it("omits regions whose only content was removed", () => {
    const store = new SaveStore(makeHost());
    store.addRemove(12850, "0000001a");
    store.removeRemove(12850, "0000001a");
    expect(store.serialize({ name: "T", slug: "t" }).regions).toHaveLength(0);
  });
});

describe("SaveStore detachRegion re-entrancy", () => {
  // Task 7 wires ModelPlacer.onMeshRemoved -> saveStore.untrack(mesh), so
  // placer.removeMesh() re-enters the store synchronously. If detachRegion
  // deleted the byMesh entry AFTER calling removeMesh (as an earlier draft
  // of this class did), the re-entrant untrack() would still find the
  // tracked entry and delete the placement data from byRegion — silently
  // erasing a saved placement just because its region streamed out. The
  // fix is deleting byMesh BEFORE calling removeMesh so the re-entrant
  // untrack() finds nothing and returns early.
  it("keeps placement data when removeMesh re-enters untrack", () => {
    const mesh = meshAt(100, 0, -100);
    let reentrantUntrack: (() => void) | null = null;
    const placer: Placer = {
      kind: "npc" as PlacerKind,
      getSceneGroup: () => new THREE.Group(),
      getPlacements: () => [],
      updatePose: () => {},
      removeMesh: (m) => {
        expect(m).toBe(mesh);
        reentrantUntrack?.();
      },
      duplicate: () => {},
      spawnAt: async () => null,
      isArmed: () => false,
      cancel: () => {},
    };
    const store = new SaveStore(makeHost({ placerFor: () => placer }));
    reentrantUntrack = () => store.untrack(mesh);

    store.trackSpawn(mesh, { kind: "npc", id: 3105, plane: 0 });
    store.detachRegion(12850);

    const bundle = store.serialize({ name: "T", slug: "t" });
    expect(bundle.regions.find((r) => r.regionId === 12850)?.placements).toHaveLength(1);
  });
});

describe("SaveStore applyToRegion", () => {
  function locStub(locsGroup: THREE.Object3D = new THREE.Group()) {
    return { offsetX: 0, offsetZ: 0, locsGroup };
  }

  function stubPlacer(overrides: Partial<Placer> = {}): Placer {
    return {
      kind: "npc" as PlacerKind,
      getSceneGroup: () => new THREE.Group(),
      getPlacements: () => [],
      updatePose: () => {},
      removeMesh: () => {},
      duplicate: () => {},
      spawnAt: async () => null,
      isArmed: () => false,
      cancel: () => {},
      ...overrides,
    };
  }

  /** Minimal single-region bundle, enough to exercise `applyToRegion`
   *  without going through `trackSpawn` (which would dirty the store). */
  function bundleWith(
    regionId: number,
    placements: Array<{ kind: SavedPlacementKind; id: number }>,
    removes: string[] = [],
  ): SaveBundle {
    return {
      manifest: {
        schemaVersion: SAVE_SCHEMA,
        name: "T",
        slug: "t",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        regions: [regionId],
      },
      regions: [
        {
          schemaVersion: SAVE_SCHEMA,
          regionId,
          removes,
          placements: placements.map((p) => ({
            kind: p.kind,
            id: p.id,
            plane: 0,
            x: 100,
            y: 0,
            z: -100,
            rotationY: 0,
          })),
        },
      ],
    };
  }

  it("counts a placement as skipped when no placer owns its kind", async () => {
    const store = new SaveStore(
      makeHost({ getLoadedRegion: () => locStub(), placerFor: () => null }),
    );
    store.load(
      bundleWith(12850, [
        { kind: "npc", id: 1 },
        { kind: "object", id: 2 },
      ]),
    );

    const result = await store.applyToRegion(12850);

    expect(result).toEqual({ hidden: 0, spawned: 0, skipped: 2 });
  });

  it("spawns what it can, skips placements whose entity fails to bake, and does not go dirty", async () => {
    const placer = stubPlacer({
      spawnAt: async (opts) => (opts.id === 1 ? meshAt(100, 0, -100) : null),
    });
    const store = new SaveStore(
      makeHost({ getLoadedRegion: () => locStub(), placerFor: () => placer }),
    );
    store.load(
      bundleWith(12850, [
        { kind: "npc", id: 1 },
        { kind: "npc", id: 2 },
      ]),
    );
    expect(store.isDirty()).toBe(false);

    const result = await store.applyToRegion(12850);

    expect(result).toEqual({ hidden: 0, spawned: 1, skipped: 1 });
    // Re-materializing a saved placement is not an edit.
    expect(store.isDirty()).toBe(false);
  });

  it("guards against a second apply starting before the first finishes", async () => {
    let resolveSpawn: (mesh: THREE.Mesh | null) => void = () => {};
    const spawnPromise = new Promise<THREE.Mesh | null>((res) => {
      resolveSpawn = res;
    });
    const spawnAt = vi.fn(() => spawnPromise);
    const placer = stubPlacer({ spawnAt });
    const store = new SaveStore(
      makeHost({ getLoadedRegion: () => locStub(), placerFor: () => placer }),
    );
    store.load(bundleWith(12850, [{ kind: "npc", id: 1 }]));

    // Don't await the first call — start the second while the first is
    // still suspended on `await placer.spawnAt(...)`.
    const p1 = store.applyToRegion(12850);
    const p2 = store.applyToRegion(12850);
    resolveSpawn(meshAt(100, 0, -100));
    const [r1, r2] = await Promise.all([p1, p2]);

    // Only one spawn chain ever ran — the second call bailed at entry.
    expect(spawnAt).toHaveBeenCalledTimes(1);
    expect(r1).toEqual({ hidden: 0, spawned: 1, skipped: 0 });
    expect(r2).toEqual({ hidden: 0, spawned: 0, skipped: 0 });
  });

  it("does not double-spawn a placement whose mesh is already live when its region streams in", async () => {
    // Reproduces: user drags/nudges a tracked placement out of the loaded
    // grid. updateFromMesh re-keys it to the destination region while the
    // original mesh stays registered in byMesh. If that region only *now*
    // streams in (applyToRegion runs unconditionally on every region load,
    // main.ts:885), a naive spawn loop would materialize a second mesh for
    // the same SavedPlacement — aliasing one record to two live meshes.
    const spawnAt = vi.fn(async () => meshAt(0, 0, 0));
    const placer = stubPlacer({ spawnAt, removeMesh: vi.fn() });
    const store = new SaveStore(
      makeHost({ getLoadedRegion: () => locStub(), placerFor: () => placer }),
    );
    const mesh = meshAt(100, 0, -100);
    store.trackSpawn(mesh, { kind: "npc", id: 3105, plane: 0 });

    // Drag the mesh into EAST_REGION — updateFromMesh re-keys the tracked
    // record there even though EAST_REGION was never "loaded" for this test.
    mesh.position.x = REGION_SPAN + 50;
    store.updateFromMesh(mesh);

    // EAST_REGION "streams in" — applyToRegion must recognize the record
    // already has a live mesh and skip it rather than spawning a duplicate.
    const result = await store.applyToRegion(EAST_REGION);

    expect(result).toEqual({ hidden: 0, spawned: 0, skipped: 0 });
    expect(spawnAt).not.toHaveBeenCalled();

    // Only one mesh is registered for the record: detaching the region
    // removes exactly the original mesh, once.
    store.detachRegion(EAST_REGION);
    expect(placer.removeMesh).toHaveBeenCalledTimes(1);
    expect(placer.removeMesh).toHaveBeenCalledWith(mesh);
  });

  it("hides a baked loc whose placement id matches a saved remove", async () => {
    // Same fixture shape as hideLoc.test.ts: placementIds + placementIdxs
    // stamped on an InstancedMesh by placeLocs.
    const inst = new THREE.InstancedMesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
      1,
    );
    inst.userData.placementIds = new Uint32Array([0x1a]);
    inst.userData.placementIdxs = [0];
    const locsGroup = new THREE.Group();
    locsGroup.add(inst);

    const store = new SaveStore(makeHost({ getLoadedRegion: () => locStub(locsGroup) }));
    store.addRemove(12850, "0000001a");

    const result = await store.applyToRegion(12850);

    expect(result).toEqual({ hidden: 1, spawned: 0, skipped: 0 });
  });
});
