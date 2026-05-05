import type { ItemDefinition, ModelDefinition, RSCache } from "osrscachereader";
import { IndexType, ConfigType } from "osrscachereader";
import {
  BASE_AMBIENT,
  BASE_CONTRAST,
  applyFaceColorSubstitution,
  applyFaceTextureSubstitution,
} from "../color/modelLight.js";
import type { BakedAtlas } from "../texture/atlas.js";
import { flattenEntityModel } from "./npcModel.js";

/**
 * ItemDefinition extractor — the viewer's "place an item on the ground"
 * tool.
 *
 * OSRS items carry an `inventoryModel` id used for both the inventory
 * sprite and ground rendering. We load that model, apply recolor/retexture
 * the same way locs/NPCs/objects do, light it, flatten to triangle soup.
 *
 * Scope cuts:
 *   - No resize applied. `resize[X/Y/Z] / 128` is the intended ground-scale
 *     factor; skipping it means items render at their full inventory-model
 *     size (often slightly larger than the in-game ground rendering).
 *     Good enough for a map-editor placement tool and keeps the output
 *     format identical to NPCs + objects.
 *   - Banknotes (`notedID >= 0`) and placeholders are rejected with a
 *     non-geometry error — their `inventoryModel` is either missing or
 *     points at the "note template" sprite which isn't interesting to
 *     drop on the world.
 */

function isTemplated(def: ItemDefinition): boolean {
  return (
    (def.notedID ?? -1) >= 0 ||
    (def.notedTemplate ?? -1) >= 0 ||
    (def.placeholderId ?? -1) >= 0 ||
    (def.placeholderTemplateId ?? -1) >= 0
  );
}

export interface BakedItem {
  id: number;
  name: string;
  positions: Float32Array;
  colors: Uint8Array;
  uvs: Float32Array;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export async function bakeItem(
  rs: RSCache,
  itemId: number,
  atlas: BakedAtlas,
): Promise<BakedItem> {
  const def = (await rs
    .getDef<ItemDefinition>(IndexType.CONFIGS, ConfigType.ITEM, itemId)
    .catch(() => null)) as ItemDefinition | null;
  if (!def) throw new Error(`item ${itemId} not in cache`);
  if (isTemplated(def)) {
    throw new Error(`item ${itemId}: templated (note/placeholder), no geometry`);
  }
  const modelId = def.inventoryModel ?? -1;
  if (modelId < 0) throw new Error(`item ${itemId}: no inventoryModel`);

  let model: ModelDefinition | null = null;
  try {
    model = (await rs.getDef<ModelDefinition>(IndexType.MODELS, modelId)) ?? null;
  } catch (e) {
    throw new Error(`item ${itemId}: getModel(${modelId}) threw: ${(e as Error).message}`);
  }
  if (!model || model.vertexCount === 0 || model.faceCount === 0) {
    throw new Error(`item ${itemId}: empty model (${modelId})`);
  }

  applyFaceColorSubstitution(model, def.recolorToFind, def.recolorToReplace);
  applyFaceTextureSubstitution(model, def.retextureToFind, def.retextureToReplace);

  const ambient = BASE_AMBIENT + (def.ambient ?? 0);
  const contrast = BASE_CONTRAST + (def.contrast ?? 0);
  const { positions, colors, uvs } = flattenEntityModel(model, ambient, contrast, atlas);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const bbox: BakedItem["bbox"] = Number.isFinite(minX)
    ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
    : { min: [0, 0, 0], max: [0, 0, 0] };

  return {
    id: itemId,
    name: def.name ?? `item_${itemId}`,
    positions,
    colors,
    uvs,
    bbox,
  };
}

export interface ItemCatalogEntry {
  id: number;
  name: string;
  members: boolean;
  stackable: boolean;
  /** Phase 4 picker-metadata. All optional — included only when the cache
   *  opcode actually fires (rare for some fields). Use null/undefined to
   *  skip filters that don't apply. */
  examineText?: string;
  category?: number;
  cost?: number;
  weight?: number;
  isTradeable?: boolean;
  /** Right-click sub-options like ["Equip","Wield"], one inner array per
   *  click slot (1..5). Empty arrays elided. */
  subops?: string[][];
  team?: number;
}

/**
 * Enumerate every ItemDefinition. Filters out banknotes, placeholders, and
 * defs with no name or inventory model — none of those have geometry we
 * can drop on the map. ~22k entries survive on build 234.
 */
export async function buildItemCatalog(rs: RSCache): Promise<ItemCatalogEntry[]> {
  const defs =
    (await rs.getAllDefs<ItemDefinition>(IndexType.CONFIGS, ConfigType.ITEM)) ?? [];
  const out: ItemCatalogEntry[] = [];
  for (const d of defs) {
    if (!d) continue;
    if (!d.name || d.name.toLowerCase() === "null") continue;
    if ((d.inventoryModel ?? -1) < 0) continue;
    if (isTemplated(d)) continue;
    const entry: ItemCatalogEntry = {
      id: d.id,
      name: d.name,
      members: d.members ?? false,
      stackable: (d.stackable ?? 0) !== 0,
    };
    // Trim noise: only persist fields the cache actually populated. A
    // catalog entry should be ~50 bytes for a typical item; the Phase 4
    // additions add ~5–30 more depending on how many opcodes fired.
    if (d.examineText) entry.examineText = d.examineText;
    if (d.category !== undefined) entry.category = d.category;
    if (d.cost !== undefined) entry.cost = d.cost;
    if (d.weight !== undefined) entry.weight = d.weight;
    if (d.isTradeable) entry.isTradeable = true;
    if (d.team !== undefined && d.team !== 0) entry.team = d.team;
    if (d.subops && d.subops.some((s) => s && s.length > 0)) {
      entry.subops = d.subops.map((s) => (Array.isArray(s) ? [...s] : []));
    }
    out.push(entry);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
