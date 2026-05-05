/**
 * Phase 5 — global game-state vars.
 *
 * OSRS varbit / varp values control which alternate of a morphing loc
 * renders. Each morphing source loc carries `LocMorphSpec` in
 * `LocsManifest.morphs`; at scene-build time `placeLocs` consults this
 * registry to pick the active alternate per placement.
 *
 * Today the registry is read once at scene init. Listeners + reactive
 * scene updates are stubbed but not wired through `placeLocs`; flipping
 * a var at runtime requires a scene rebuild (call `loadRegion` again).
 * That's an explicit MVP cut — UI panel + reactive swap is Phase 5b.
 *
 * Lookup key is `"${kind}:${id}"`. Default value when unset is 0
 * (matches OSRS: a freshly logged-in player has every var = 0 unless a
 * quest / interaction sets it).
 */

export type VarKind = "varbit" | "varp";

const state = new Map<string, number>();
const listeners = new Set<() => void>();

const key = (kind: VarKind, id: number): string => `${kind}:${id}`;

export function getVar(kind: VarKind, id: number): number {
  return state.get(key(kind, id)) ?? 0;
}

export function setVar(kind: VarKind, id: number, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  const k = key(kind, id);
  if (state.get(k) === value) return;
  state.set(k, value);
  for (const fn of listeners) fn();
}

export function clearVar(kind: VarKind, id: number): void {
  const k = key(kind, id);
  if (!state.has(k)) return;
  state.delete(k);
  for (const fn of listeners) fn();
}

/** Subscribe to any varState change. Returns an unsubscribe fn. */
export function subscribeVarState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Snapshot the entire state for diagnostics. */
export function snapshotVarState(): Record<string, number> {
  return Object.fromEntries(state);
}

/**
 * Resolve a morph placement to its active alternate locId.
 *
 *   - varValue >= alternates.length → use last entry as default.
 *   - alternates[varValue] === -1   → "no render this state" (caller skips).
 *   - alternates[varValue] === sourceLocId → render source loc as-is.
 *
 * Mirrors the OSRS client's logic in `GameObjectDefinition.transformLink`
 * (referenced by name only — we don't have a Java source for it locally;
 * cross-checked against `osrscachereader/ObjectLoader.js` opcodes 77/92
 * for the data format and rs-map-viewer's `getLocTransform` for the
 * resolve algorithm).
 */
export function resolveMorphLoc(
  sourceLocId: number,
  spec: { varKind: VarKind; varId: number; alternates: number[] },
): number {
  const value = getVar(spec.varKind, spec.varId);
  const alts = spec.alternates;
  if (alts.length === 0) return sourceLocId;
  const idx = value < alts.length ? value : alts.length - 1;
  const resolved = alts[idx];
  if (resolved === undefined) return sourceLocId;
  return resolved;
}

// Dev affordance: allow `window.setVar(kind, id, val)` from the console
// to flip a var. The caller is responsible for triggering a reload — we
// can't redraw the scene from here without coupling to the viewer entry
// point. Logged so it's easy to discover in DevTools.
declare global {
  interface Window {
    /** Set a varbit/varp value. Subsequent scene rebuilds render the
     *  corresponding alternate. Returns instructions for re-rendering. */
    setVar?: (kind: VarKind, id: number, value: number) => string;
    /** Snapshot all set vars. */
    dumpVars?: () => Record<string, number>;
  }
}

if (typeof window !== "undefined") {
  window.setVar = (kind, id, value): string => {
    setVar(kind, id, value);
    return `set ${kind}:${id}=${value}. Reload (?region=...) to re-render.`;
  };
  window.dumpVars = snapshotVarState;
}
