import { describe, expect, it } from "vitest";
import {
  SAVE_SCHEMA,
  SaveSchemaError,
  emptyRegionFile,
  isRegionFileEmpty,
  parseSaveBundle,
  slugify,
} from "@rsmap/shared/save-file";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Lumbridge Raid")).toBe("lumbridge-raid");
  });

  it("strips characters that are unsafe in a directory name", () => {
    expect(slugify("my/map: v2!")).toBe("my-map-v2");
  });

  it("falls back when nothing survives", () => {
    expect(slugify("///")).toBe("untitled");
  });
});

describe("parseSaveBundle", () => {
  const valid = {
    manifest: {
      schemaVersion: SAVE_SCHEMA,
      name: "Lumbridge Raid",
      slug: "lumbridge-raid",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      regions: [12850],
    },
    regions: [
      {
        schemaVersion: SAVE_SCHEMA,
        regionId: 12850,
        removes: ["0000001a"],
        placements: [
          {
            kind: "object",
            id: 1278,
            plane: 0,
            x: 4480.5,
            y: 12,
            z: -4480.5,
            rotationY: 0.7853981633974483,
            type: 10,
          },
        ],
      },
    ],
  };

  it("round-trips a valid bundle", () => {
    const parsed = parseSaveBundle(JSON.parse(JSON.stringify(valid)));
    expect(parsed.regions[0]!.placements[0]!.id).toBe(1278);
    expect(parsed.manifest.slug).toBe("lumbridge-raid");
  });

  it("rejects a future schema version", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.manifest.schemaVersion = SAVE_SCHEMA + 1;
    expect(() => parseSaveBundle(bad)).toThrow(SaveSchemaError);
  });

  it("rejects a placement with an unknown kind", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.regions[0].placements[0].kind = "monster";
    expect(() => parseSaveBundle(bad)).toThrow(/kind/);
  });

  it("rejects a malformed placement id", () => {
    const bad = JSON.parse(JSON.stringify(valid));
    bad.regions[0].removes = ["nothex"];
    expect(() => parseSaveBundle(bad)).toThrow(/placement id/);
  });
});

describe("region file helpers", () => {
  it("reports an untouched region file as empty", () => {
    expect(isRegionFileEmpty(emptyRegionFile(12850))).toBe(true);
  });

  it("reports a file with a remove as non-empty", () => {
    const f = emptyRegionFile(12850);
    f.removes.push("0000001a");
    expect(isRegionFileEmpty(f)).toBe(false);
  });
});

import { REGION_SPAN } from "@rsmap/shared";
import {
  regionLocalToWorld,
  regionOriginFor,
  worldToRegionId,
  worldToRegionLocal,
} from "./saveModel.js";

// Lumbridge 12850 = (regionX 50, regionZ 50). Used as the streaming centre
// in every case below, so its own origin is the world origin.
const CX = 50;
const CZ = 50;

describe("regionOriginFor", () => {
  it("puts the centre region at the world origin", () => {
    expect(regionOriginFor(12850, CX, CZ)).toEqual({ offsetX: 0, offsetZ: 0 });
  });

  it("puts the region one step east at +X", () => {
    // regionX 51, regionZ 50 → (51 << 8) | 50
    expect(regionOriginFor((51 << 8) | 50, CX, CZ)).toEqual({
      offsetX: REGION_SPAN,
      offsetZ: 0,
    });
  });

  it("puts the region one step north at -Z (cache +Y is world -Z)", () => {
    expect(regionOriginFor((50 << 8) | 51, CX, CZ)).toEqual({
      offsetX: 0,
      offsetZ: -REGION_SPAN,
    });
  });
});

describe("worldToRegionId", () => {
  it("attributes a position inside the centre region", () => {
    expect(worldToRegionId(100, -100, CX, CZ)).toBe(12850);
  });

  it("attributes a position just across the east seam to the east region", () => {
    expect(worldToRegionId(REGION_SPAN + 1, -100, CX, CZ)).toBe((51 << 8) | 50);
  });

  it("attributes a position just across the north seam to the north region", () => {
    expect(worldToRegionId(100, -REGION_SPAN - 1, CX, CZ)).toBe((50 << 8) | 51);
  });

  it("returns null outside the addressable cache grid", () => {
    expect(worldToRegionId(-100 * REGION_SPAN, 0, CX, CZ)).toBeNull();
  });
});

describe("region-local round trip", () => {
  it("recovers the original world position", () => {
    const world = { x: REGION_SPAN + 250.5, y: 37.25, z: -REGION_SPAN - 900.75 };
    const regionId = worldToRegionId(world.x, world.z, CX, CZ)!;
    const origin = regionOriginFor(regionId, CX, CZ);
    const local = worldToRegionLocal(world, origin);
    expect(regionLocalToWorld(local, origin)).toEqual(world);
  });

  it("keeps local coordinates inside one region span", () => {
    const world = { x: REGION_SPAN + 250.5, y: 0, z: -REGION_SPAN - 900.75 };
    const regionId = worldToRegionId(world.x, world.z, CX, CZ)!;
    const local = worldToRegionLocal(world, regionOriginFor(regionId, CX, CZ));
    expect(local.x).toBeGreaterThanOrEqual(0);
    expect(local.x).toBeLessThan(REGION_SPAN);
    expect(local.z).toBeLessThanOrEqual(0);
    expect(local.z).toBeGreaterThan(-REGION_SPAN);
  });
});
