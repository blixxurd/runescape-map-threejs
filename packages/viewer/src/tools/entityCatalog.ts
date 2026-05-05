/**
 * Client-side entity catalog loader + search.
 *
 * NPCs and objects share the same shape: `{ id, name, ...metadata }` with a
 * locally sorted-by-name list returned from the dev server. We keep the full
 * list in memory and filter per-keystroke; network round-trip only happens
 * once per catalog, at first access.
 */

export interface NamedEntry {
  id: number;
  name: string;
  [key: string]: unknown;
}

export interface NpcCatalogEntry extends NamedEntry {
  combatLevel: number;
  size: number;
  /** Phase 4 picker metadata. All optional; undefined means cache opcode
   *  didn't fire on this def. See `packages/extractor/src/entities/npcModel.ts`
   *  → `buildNpcCatalog` for the source-of-truth filter rules. */
  category?: number;
  isMinimapVisible?: false;
  renderPriority?: number;
  rotationSpeed?: number;
  headIconCount?: number;
}

export interface ObjectCatalogEntry extends NamedEntry {
  modelType: number;
  sizeX: number;
  sizeY: number;
  /** Phase 4 picker metadata. */
  category?: number;
  /** Default 2 (blocks player+projectiles); only present when deviating. */
  interactType?: number;
  /** Cache opcode 249 free-form key/value bag. */
  params?: Record<string, string | number>;
}

export interface ItemCatalogEntry extends NamedEntry {
  members: boolean;
  stackable: boolean;
  /** Phase 4 picker metadata. */
  examineText?: string;
  category?: number;
  cost?: number;
  weight?: number;
  isTradeable?: boolean;
  subops?: string[][];
  team?: number;
}

export interface SpotAnimCatalogEntry extends NamedEntry {
  /** True when the def references an animation sequence. */
  hasAnimation?: boolean;
}

/** Sequences come named only if they're in our static lookup table; the
 *  server side just enumerates ids + frame counts. Callers overlay names
 *  from `animationNames.ts`. */
export interface SequenceCatalogEntry {
  id: number;
  frameCount: number;
}

/**
 * Try the static catalog first (`/catalog/<name>.json`, baked by
 * `pnpm extract --catalogs`), fall back to the dev-server endpoint
 * (`/api/<name>-catalog`, computed live). Static deploys won't have
 * the dev endpoint; dev environments may not have run the catalog
 * dump yet.
 */
function makeLoader<T extends NamedEntry>(
  staticUrl: string,
  devUrl: string,
): () => Promise<T[]> {
  let promise: Promise<T[]> | null = null;
  return async (): Promise<T[]> => {
    if (promise) return promise;
    promise = (async (): Promise<T[]> => {
      // 404 on static is expected in dev when catalogs haven't been
      // dumped — silently fall through. Other failures (5xx, network)
      // we let surface from the dev fetch.
      const staticRes = await fetch(staticUrl).catch(() => null);
      if (staticRes && staticRes.ok) {
        const body = (await staticRes.json()) as { entries: T[] };
        return body.entries;
      }
      const devRes = await fetch(devUrl);
      if (!devRes.ok) throw new Error(`${devUrl}: ${devRes.status}`);
      const body = (await devRes.json()) as { entries: T[] };
      return body.entries;
    })();
    promise.catch(() => {
      promise = null;
    });
    return promise;
  };
}

export const loadNpcCatalog = makeLoader<NpcCatalogEntry>(
  "/catalog/npc.json",
  "/api/npc-catalog",
);
export const loadObjectCatalog = makeLoader<ObjectCatalogEntry>(
  "/catalog/object.json",
  "/api/object-catalog",
);
export const loadItemCatalog = makeLoader<ItemCatalogEntry>(
  "/catalog/item.json",
  "/api/item-catalog",
);
export const loadSpotAnimCatalog = makeLoader<SpotAnimCatalogEntry>(
  "/catalog/spotanim.json",
  "/api/spotanim-catalog",
);
// Sequence entries don't extend NamedEntry — they have no `name` field, the
// UI layers names on top via `animationNames.ts`.
let sequenceCatalogPromise: Promise<SequenceCatalogEntry[]> | null = null;
export async function loadSequenceCatalog(): Promise<SequenceCatalogEntry[]> {
  if (sequenceCatalogPromise) return sequenceCatalogPromise;
  sequenceCatalogPromise = (async (): Promise<SequenceCatalogEntry[]> => {
    // Same static-then-dev fallback as the named catalogs above.
    const staticRes = await fetch("/catalog/sequence.json").catch(() => null);
    if (staticRes && staticRes.ok) {
      const body = (await staticRes.json()) as { entries: SequenceCatalogEntry[] };
      return body.entries;
    }
    const devRes = await fetch("/api/sequence-catalog");
    if (!devRes.ok) throw new Error(`sequence catalog: ${devRes.status}`);
    const body = (await devRes.json()) as { entries: SequenceCatalogEntry[] };
    return body.entries;
  })();
  sequenceCatalogPromise.catch(() => {
    sequenceCatalogPromise = null;
  });
  return sequenceCatalogPromise;
}

/**
 * Rank search results by how closely they match the query:
 *   exact name == query  → rank 0
 *   name starts with q   → rank 1
 *   name includes q      → rank 2
 *
 * Within each rank, entries keep the catalog's natural (alphabetical) order.
 * Empty query returns the first `limit` entries as-is.
 */
export function searchEntries<T extends NamedEntry>(
  catalog: T[],
  query: string,
  limit = 80,
): T[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return catalog.slice(0, limit);
  const exact: T[] = [];
  const prefix: T[] = [];
  const substr: T[] = [];
  for (const e of catalog) {
    const n = e.name.toLowerCase();
    if (n === q) exact.push(e);
    else if (n.startsWith(q)) prefix.push(e);
    else if (n.includes(q)) substr.push(e);
    if (exact.length + prefix.length + substr.length >= limit * 2) break;
  }
  return [...exact, ...prefix, ...substr].slice(0, limit);
}
