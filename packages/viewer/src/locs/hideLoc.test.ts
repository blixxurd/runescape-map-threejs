import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildPlacementIndex } from "./hideLoc.js";

/** placeLocs stamps `placementIds` (whole-region, indexed by placementIdx)
 *  on every loc mesh, plus `placementIdxs` per instance on InstancedMesh
 *  and `placementByTri` per triangle on the merged Mesh. These fixtures
 *  reproduce that shape without needing a real bundle. */
function instanced(placementIds: Uint32Array, placementIdxs: number[]): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
    placementIdxs.length,
  );
  inst.userData.placementIds = placementIds;
  inst.userData.placementIdxs = placementIdxs;
  return inst;
}

function merged(placementIds: Uint32Array, placementByTri: Uint32Array): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.userData.isMergedLocs = true;
  mesh.userData.placementIds = placementIds;
  mesh.userData.placementByTri = placementByTri;
  return mesh;
}

describe("buildPlacementIndex", () => {
  it("indexes instanced slots by 8-char hex placement id", () => {
    const ids = new Uint32Array([0x1a, 0x2b, 0x3c]);
    const group = new THREE.Group();
    group.add(instanced(ids, [0, 2]));

    const index = buildPlacementIndex(group);

    expect(index.get("0000001a")).toMatchObject({ instanceId: 0 });
    expect(index.get("0000003c")).toMatchObject({ instanceId: 1 });
    // placementIdx 1 was not instanced here, so it must not appear.
    expect(index.has("0000002b")).toBe(false);
  });

  it("indexes merged triangles by placement id, one entry per placement", () => {
    const ids = new Uint32Array([0x1a, 0x2b]);
    const group = new THREE.Group();
    group.add(merged(ids, new Uint32Array([0, 0, 1, 1, 1])));

    const index = buildPlacementIndex(group);

    expect(index.get("0000001a")).toMatchObject({ placementIdx: 0, instanceId: null });
    expect(index.get("0000002b")).toMatchObject({ placementIdx: 1, instanceId: null });
  });

  it("walks nested plane groups", () => {
    const ids = new Uint32Array([0x1a]);
    const plane = new THREE.Group();
    plane.add(instanced(ids, [0]));
    const root = new THREE.Group();
    root.add(plane);

    expect(buildPlacementIndex(root).has("0000001a")).toBe(true);
  });

  it("returns an empty index when the bundle has no placementIds", () => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.userData.isMergedLocs = true;
    mesh.userData.placementByTri = new Uint32Array([0]);
    group.add(mesh);

    expect(buildPlacementIndex(group).size).toBe(0);
  });
});
