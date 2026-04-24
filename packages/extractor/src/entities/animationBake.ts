import type {
  FramesDefinition,
  ModelDefinition,
  RSCache,
  SequenceDefinition,
} from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import { applyFramePose } from "../region/animate.js";

/**
 * Shared sequence-baker used by NPC and object placer bakes. Walks a
 * sequence's frame list, applies each frame's transforms to a fresh clone
 * of the model's base vertex arrays, and returns per-frame posed positions
 * + timing metadata. The caller flattens these into render-ready soup
 * (NPCs via `npcModel.ts`, objects via `objectModel.ts`).
 *
 * `alwaysLoop`:
 *  - `true` for NPC idle animations (`standingAnimation`). OSRS plays
 *    these on a dedicated render path that loops forever regardless of
 *    what `SequenceDefinition.frameStep` stores — and the library
 *    defaults `frameStep` to -1 when the opcode isn't present, which the
 *    viewer's tick loop reads as "freeze on last frame". Promoting a
 *    missing/negative value to `frameCount` fixes the NPC-specific bug.
 *  - `false` for object placements (`ObjectDefinition.animationID`). OSRS
 *    interprets loc sequence metadata literally — some animations loop
 *    (windmill vanes, fire), others are one-shot (chest opens and stays
 *    open). We pass the raw `frameStep` through so the viewer honors the
 *    cache's intent.
 */

export interface PosedFrame {
  vx: number[];
  vy: number[];
  vz: number[];
  /** Duration in 20-ms OSRS client ticks. */
  ticks: number;
}

export interface AnimationBakeResult {
  /** Exactly one frame in the sequence → apply this pose to the model and
   *  skip the per-tick cycle entirely. `animation` is null in that case. */
  singleFramePose: PosedFrame | null;
  /** Multi-frame animation metadata. `framesPositions` is filled in by the
   *  caller after the model's final flatten (the caller owns the face
   *  order). */
  animation: {
    frameCount: number;
    frameTicks: number[];
    /** Raw poses per frame — caller flattens into a frame-major soup. */
    posedFrames: PosedFrame[];
    /** Final `frameStep` after applying `alwaysLoop`. */
    frameStep: number;
  } | null;
}

export async function bakeEntityAnimationFrames(
  rs: RSCache,
  model: ModelDefinition,
  sequenceId: number,
  opts: { alwaysLoop: boolean; logTag: string },
): Promise<AnimationBakeResult> {
  const result: AnimationBakeResult = { singleFramePose: null, animation: null };
  if (sequenceId < 0 || !model.vertexGroups) return result;

  let seq: SequenceDefinition | null = null;
  try {
    seq = ((await rs.getDef(
      IndexType.CONFIGS,
      ConfigType.SEQUENCE,
      sequenceId,
    )) as SequenceDefinition | undefined) ?? null;
  } catch (e) {
    console.warn(`[${opts.logTag}] seq ${sequenceId} load failed: ${(e as Error).message}`);
    return result;
  }
  if (!seq || !seq.frameIDs || seq.frameIDs.length === 0) return result;

  const baseX = Array.from(model.vertexPositionsX as ArrayLike<number>);
  const baseY = Array.from(model.vertexPositionsY as ArrayLike<number>);
  const baseZ = Array.from(model.vertexPositionsZ as ArrayLike<number>);

  const posedFrames: PosedFrame[] = [];
  for (let i = 0; i < seq.frameIDs.length; i++) {
    const packed = seq.frameIDs[i]!;
    const frameArchive = packed >>> 16;
    const frameIndex = packed & 0xffff;
    let frame: FramesDefinition | null = null;
    try {
      frame = ((await rs.getDef(
        IndexType.FRAMES,
        frameArchive,
        frameIndex,
      )) as FramesDefinition | undefined) ?? null;
    } catch (e) {
      console.warn(
        `[${opts.logTag}] seq ${sequenceId} frame ${i} load failed: ${(e as Error).message}`,
      );
      return result;
    }
    if (!frame || !frame.framemap) return result;
    // Each frame poses the BASE vertices — if we let transforms accumulate
    // across frames the animation would drift. Clone back to base every time.
    (model.vertexPositionsX as number[]) = baseX.slice();
    (model.vertexPositionsY as number[]) = baseY.slice();
    (model.vertexPositionsZ as number[]) = baseZ.slice();
    applyFramePose(model, frame);
    posedFrames.push({
      vx: Array.from(model.vertexPositionsX as ArrayLike<number>),
      vy: Array.from(model.vertexPositionsY as ArrayLike<number>),
      vz: Array.from(model.vertexPositionsZ as ArrayLike<number>),
      ticks: seq.frameLengths?.[i] ?? 1,
    });
  }
  // Restore the base pose; caller decides what to do with the model after.
  (model.vertexPositionsX as number[]) = baseX;
  (model.vertexPositionsY as number[]) = baseY;
  (model.vertexPositionsZ as number[]) = baseZ;

  if (posedFrames.length === 1) {
    result.singleFramePose = posedFrames[0]!;
    return result;
  }

  const frameCount = posedFrames.length;
  const rawFrameStep = seq.frameStep ?? -1;
  const frameStep = opts.alwaysLoop && rawFrameStep < 0 ? frameCount : rawFrameStep;
  result.animation = {
    frameCount,
    frameTicks: posedFrames.map((f) => f.ticks),
    posedFrames,
    frameStep,
  };
  return result;
}

/**
 * Re-emit a model's positions using the same face-indexing as the main
 * flatten loop in `npcModel.ts` / `objectModel.ts`, but driven by an
 * externally-supplied `{vx, vy, vz}` set — one per animation frame.
 *
 * The Y/Z negation matches `flattenEntityModel`'s client-space-to-world
 * flip so every frame's positions line up with the rigid-pose attribute
 * the viewer will swap them into.
 */
export function flattenAnimationFramePositions(
  model: ModelDefinition,
  vx: ArrayLike<number>,
  vy: ArrayLike<number>,
  vz: ArrayLike<number>,
): Float32Array {
  const faceCount = model.faceCount;
  const out = new Float32Array(faceCount * 9);
  for (let i = 0; i < faceCount; i++) {
    const a = model.faceVertexIndices1[i] as number;
    const b = model.faceVertexIndices2[i] as number;
    const c = model.faceVertexIndices3[i] as number;
    const off = i * 9;
    out[off + 0] = vx[a] as number;
    out[off + 1] = -(vy[a] as number);
    out[off + 2] = -(vz[a] as number);
    out[off + 3] = vx[b] as number;
    out[off + 4] = -(vy[b] as number);
    out[off + 5] = -(vz[b] as number);
    out[off + 6] = vx[c] as number;
    out[off + 7] = -(vy[c] as number);
    out[off + 8] = -(vz[c] as number);
  }
  return out;
}
