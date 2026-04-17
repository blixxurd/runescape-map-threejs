/**
 * Monkey-patch `osrscachereader`'s ObjectLoader so that one unknown opcode
 * in a newer cache doesn't poison the entire object archive.
 *
 * The library walks an opcode stream until opcode 0, dispatching through a
 * hand-written switch. When the OSRS client adds a new opcode (common when
 * the library lags the live build), the default fall-through mis-aligns the
 * stream, reads off the end of the buffer, and throws inside
 * `CacheDefinitionLoader.#loadDef`. That rejection is cached by `getAllFiles`
 * — so every later `getDef(OBJECT, …)` returns the same error.
 *
 * Fix: wrap `load()`. On failure, return an empty `ObjectDefinition` with
 * only its id set. Callers see "no models" and our `bakeLocs` records the
 * locId as skipped.
 *
 * The package's `exports` field restricts subpath imports, so we resolve the
 * real file path via `createRequire` and import it as a file URL. Ugly but
 * confined to this one shim.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);

interface DefLike {
  id: number;
}

let patched = false;
let failureCount = 0;

/** Returns the number of ObjectLoader.load calls that threw since patching. */
export function getObjectLoaderFailureCount(): number {
  return failureCount;
}

export async function patchObjectLoader(): Promise<void> {
  if (patched) return;
  // Resolve the library's main entry (allowed by its exports field), then
  // walk up to find the ObjectLoader.js file next to it.
  const mainPath = require_.resolve("osrscachereader");
  const loaderPath = mainPath.replace(/index\.js$/, "cacheReader/loaders/ObjectLoader.js");
  const url = pathToFileURL(loaderPath).href;

  const mod = (await import(url)) as {
    default: new () => { load: (b: Uint8Array, id: number) => unknown };
    ObjectDefinition: new () => DefLike;
  };

  const proto = mod.default.prototype as {
    load: (bytes: Uint8Array, id: number) => unknown;
  };
  const original = proto.load;

  let warnedCount = 0;
  proto.load = function (bytes: Uint8Array, id: number): unknown {
    try {
      return original.call(this, bytes, id);
    } catch (e) {
      failureCount++;
      if (warnedCount < 5) {
        console.warn(
          `[patch] ObjectLoader.load(id=${id}) threw: ${(e as Error).message} — returning empty def`,
        );
        warnedCount++;
      } else if (warnedCount === 5) {
        console.warn(`[patch] (further ObjectLoader failures suppressed)`);
        warnedCount++;
      }
      const def = new mod.ObjectDefinition();
      def.id = id;
      return def;
    }
  };
  patched = true;
}
