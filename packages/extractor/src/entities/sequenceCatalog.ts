import type { RSCache, SequenceDefinition } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";

/**
 * Catalog of every `SequenceDefinition` in the cache's CONFIGS/SEQUENCE
 * archive. The viewer uses this to power the "try any animation" picker on
 * the NPC banner — users pick a sequence id, the bake re-runs with
 * `?anim=<id>`, and the viewer replays the new sequence.
 *
 * Names are NOT stored in the cache — OSRS triggers animations via game
 * scripts that reference sequence ids as integers. The viewer overlays a
 * static friendly-name table (`tools/animationNames.ts`) on top of this
 * catalog, falling back to `#<id>` for unnamed sequences.
 *
 * We skip empty defs (`frameIDs.length === 0`) — those can't play and
 * would just clutter search results.
 */

export interface SequenceCatalogEntry {
  id: number;
  frameCount: number;
}

export async function buildSequenceCatalog(
  rs: RSCache,
): Promise<SequenceCatalogEntry[]> {
  const defs =
    (await rs.getAllDefs<SequenceDefinition>(
      IndexType.CONFIGS,
      ConfigType.SEQUENCE,
    )) ?? [];
  const out: SequenceCatalogEntry[] = [];
  for (const d of defs) {
    if (!d) continue;
    const frames = d.frameIDs?.length ?? 0;
    if (frames === 0) continue;
    out.push({ id: d.id, frameCount: frames });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}
