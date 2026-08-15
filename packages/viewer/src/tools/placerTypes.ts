import type * as THREE from "three";

/**
 * Shared types for placement tools (NPC / Object / Item) and the selection
 * system that reads from them.
 *
 * `PlacedMeshUserData` is the contract for what a placed mesh stamps onto
 * its `userData`. Eyedropper, selection, and any future inspection tool
 * read through this type instead of casting to ad-hoc shapes.
 *
 * `Placer` is the cross-tool contract selection consumes. ModelPlacer is
 * the only implementer today; the interface lets us iterate over a list
 * of placers when selection raycasts or removes by mesh, without naming
 * each tool individually.
 */

export type PlacerKind = "npc" | "object" | "item" | "spotanim";

export interface PlacedMeshUserData {
  kind: PlacerKind;
  id: number;
  name: string;
}

/**
 * Minimal description of a single placement, returned by `Placer.getPlacements`.
 * Selection holds these to look up which placer owns a clicked mesh.
 *
 * Rotation is read directly from `mesh.rotation.y` (radians) — there is no
 * separate `rotation` field, since free-angle rotation makes the discrete
 * 0–7 eighth-turn index a lossy view rather than the source of truth.
 */
export interface PlacedRef {
  mesh: THREE.Mesh;
  kind: PlacerKind;
  id: number;
  name: string;
  /** Sequence id active on this placement, if it's an animated entity that
   *  supports per-placement overrides (NPCs only today). */
  animationId?: number;
  /** Sequences declared by the entity definition (NPC standing / walking
   *  / rotate variants). Inspector renders these in a per-selection
   *  dropdown. Undefined for entities with no animation menu (objects,
   *  items today). */
  availableAnimations?: Array<{ id: number; label: string }>;
}

/** Options for `Placer.spawnAt` — a world pose spawn that bypasses the
 *  armed-tool click flow. Used by the save store to re-materialize saved
 *  placements on region load. */
export interface SpawnAtOptions {
  id: number;
  position: { x: number; y: number; z: number };
  rotationY: number;
  plane: number;
  animationOverride?: number | null;
  /** When false, `onPlacementSpawned` does NOT fire. Save-apply passes
   *  false so re-materializing a saved placement isn't recorded as a new
   *  edit. Defaults to true. */
  notify?: boolean;
}

export interface Placer {
  readonly kind: PlacerKind;
  /** Scene group holding every placed mesh for this placer. Selection's
   *  raycast iterates these across all placers. */
  getSceneGroup(): THREE.Group;
  /** Snapshot of current placements; cheap to call. */
  getPlacements(): PlacedRef[];
  /** Move + rotate a placement. By default Y is re-clamped to the surface
   *  at the new XZ. Pass `preserveY = true` to keep `position.y` exactly
   *  (used when the gizmo's Y handle is the active drag axis so the
   *  user's manual lift sticks — `onPlacementUpdated` then carries the
   *  mesh's exact Y into `SavedPlacement.y` via `SaveStore.updateFromMesh`). */
  updatePose(
    mesh: THREE.Mesh,
    position: THREE.Vector3,
    rotationRad: number,
    preserveY?: boolean,
  ): void;
  /** Remove a placement by mesh reference. */
  removeMesh(mesh: THREE.Mesh): void;
  /** Clone a placement at the same pose. */
  duplicate(mesh: THREE.Mesh): void;
  /** Spawn a placement at an exact world pose, bypassing the armed-tool
   *  flow. Resolves null when the entity can't be baked. */
  spawnAt(opts: SpawnAtOptions): Promise<THREE.Mesh | null>;
  /** Swap the animation on a placed entity (NPC-only today; placers without
   *  the capability omit the method). */
  swapAnimation?(mesh: THREE.Mesh, animationId: number): Promise<void>;
  isArmed(): boolean;
  cancel(): void;
}
