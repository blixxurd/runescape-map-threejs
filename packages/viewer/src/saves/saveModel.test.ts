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
