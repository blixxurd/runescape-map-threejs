import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { REGION_SPAN } from "@rsmap/shared";
import { SAVE_SCHEMA } from "@rsmap/shared/save-file";
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
