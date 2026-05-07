import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type {
  ExtractorSession,
  extractRegion as ExtractRegionFn,
  openExtractorSession as OpenSessionFn,
  NoSuchRegionError as NoSuchRegionErrorCtor,
  bakeNpc as BakeNpcFn,
  buildNpcCatalog as BuildNpcCatalogFn,
  bakeObject as BakeObjectFn,
  buildObjectCatalog as BuildObjectCatalogFn,
  bakeItem as BakeItemFn,
  buildItemCatalog as BuildItemCatalogFn,
  bakeSpotAnim as BakeSpotAnimFn,
  buildSpotAnimCatalog as BuildSpotAnimCatalogFn,
  buildSequenceCatalog as BuildSequenceCatalogFn,
  buildGlobalAtlas as BuildGlobalAtlasFn,
  mergeAndSaveEdits as MergeAndSaveEditsFn,
  BakedAtlas,
  NpcCatalogEntry,
  ObjectCatalogEntry,
  ItemCatalogEntry,
  SpotAnimCatalogEntry,
  SequenceCatalogEntry,
} from "@rsmap/extractor";
import { defineConfig } from "vite";

/** Wire-format diff sent from the viewer's commit button. Shape mirrors
 *  `EditsOverlay` minus the schemaVersion — server applies that. */
interface CommitEditsDiff {
  removes: string[];
  adds: Array<{
    locId: number;
    plane: number;
    tileX: number;
    tileZ: number;
    type: number;
    rotation: number;
    animationOverride: number | null;
    offsetX?: number;
    offsetZ?: number;
    rotationY?: number;
  }>;
}

/**
 * Dev middleware — let the viewer trigger a region extraction when its
 * bundle is missing, so `http://.../?region=<id>` "just works" without a
 * separate `pnpm extract` step.
 *
 * Mounted only in `serve` (dev) mode; `vite build` still produces a static
 * site that needs pre-extracted regions. The extractor module is loaded
 * through Vite's SSR pipeline so we can import it straight from TS source
 * without a precompile step.
 *
 * Concurrency: `osrscachereader` reads a single `RSCache` instance, and its
 * internal state isn't safe for overlapping region loads. We keep one
 * shared session, dedupe concurrent calls for the same region, and
 * serialize calls for different regions behind a single chain.
 */
function autoExtractPlugin(): Plugin {
  interface ExtractorModule {
    openExtractorSession: typeof OpenSessionFn;
    extractRegion: typeof ExtractRegionFn;
    NoSuchRegionError: typeof NoSuchRegionErrorCtor;
    bakeNpc: typeof BakeNpcFn;
    buildNpcCatalog: typeof BuildNpcCatalogFn;
    bakeObject: typeof BakeObjectFn;
    buildObjectCatalog: typeof BuildObjectCatalogFn;
    bakeItem: typeof BakeItemFn;
    buildItemCatalog: typeof BuildItemCatalogFn;
    bakeSpotAnim: typeof BakeSpotAnimFn;
    buildSpotAnimCatalog: typeof BuildSpotAnimCatalogFn;
    buildSequenceCatalog: typeof BuildSequenceCatalogFn;
    buildGlobalAtlas: typeof BuildGlobalAtlasFn;
    mergeAndSaveEdits: typeof MergeAndSaveEditsFn;
  }

  let extractorModule: ExtractorModule | null = null;
  let sessionPromise: Promise<ExtractorSession> | null = null;

  // In-flight dedupe: same regionId → same promise. A single queueTail
  // serializes distinct regions and NPC bakes so RSCache sees one call at a
  // time. (The library's internal state isn't safe for overlapping reads.)
  const inflight = new Map<number, Promise<void>>();
  let queueTail: Promise<unknown> = Promise.resolve();

  // Lazily built per-catalog. NPCs ≈ 12k entries, objects ≈ 40k+ entries.
  let npcCatalogPromise: Promise<NpcCatalogEntry[]> | null = null;
  let objectCatalogPromise: Promise<ObjectCatalogEntry[]> | null = null;
  let itemCatalogPromise: Promise<ItemCatalogEntry[]> | null = null;
  let spotAnimCatalogPromise: Promise<SpotAnimCatalogEntry[]> | null = null;
  let sequenceCatalogPromise: Promise<SequenceCatalogEntry[]> | null = null;
  // Per-id bake caches — tiny JSON payloads, dedupe rapid re-clicks.
  // Key is `${npcId}:${animationOverrideOrDefault}` so switching animations
  // on the same NPC doesn't stomp the previously-cached bake. `"d"` is the
  // default-animation marker (standingAnimation as chosen by bakeNpc).
  const npcCache = new Map<string, Promise<unknown>>();
  const objectCache = new Map<number, Promise<unknown>>();
  const itemCache = new Map<number, Promise<unknown>>();
  const spotAnimCache = new Map<number, Promise<unknown>>();
  // Cache-wide texture atlas shared by every bake. Built on first need —
  // typically triggered by the viewer's atlas pre-load, but the bake path
  // will request it too if the viewer hasn't yet.
  let globalAtlasPromise: Promise<BakedAtlas> | null = null;

  async function loadModule(server: ViteDevServer): Promise<ExtractorModule> {
    if (extractorModule) return extractorModule;
    // ssrLoadModule runs the TS source through Vite's esbuild transform,
    // so we don't need a precompile step or a tsx loader — the same file
    // `pnpm extract` imports is served here.
    const mod = (await server.ssrLoadModule("@rsmap/extractor")) as ExtractorModule;
    extractorModule = mod;
    return mod;
  }

  async function getSession(server: ViteDevServer): Promise<ExtractorSession> {
    const mod = await loadModule(server);
    if (!sessionPromise) sessionPromise = mod.openExtractorSession();
    return sessionPromise;
  }

  async function runExtract(server: ViteDevServer, regionId: number): Promise<void> {
    const mod = await loadModule(server);
    const session = await getSession(server);
    await mod.extractRegion(regionId, session);
  }

  function enqueueExtract(server: ViteDevServer, regionId: number): Promise<void> {
    const existing = inflight.get(regionId);
    if (existing) return existing;
    const job = queueTail.then(() => runExtract(server, regionId));
    // Don't let one failure poison the chain for the next region.
    queueTail = job.catch(() => undefined);
    const tracked = job.finally(() => {
      inflight.delete(regionId);
    });
    inflight.set(regionId, tracked);
    return tracked;
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  /** Read the request body as JSON. Caps payload at 1 MB so a runaway
   *  client can't blow up the dev server. Anything larger is a bug. */
  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolveBody, rejectBody) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > 1024 * 1024) {
          rejectBody(new Error("body too large (>1 MB)"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          rejectBody(e);
        }
      });
      req.on("error", rejectBody);
    });
  }

  /** Per-region commit mutex. Serialises commit-edit operations for the
   *  same region so two rapid commits can't interleave save+extract steps.
   *  Concurrent commits to *different* regions still run in parallel —
   *  they only serialise behind `queueTail` inside `enqueueExtract`. */
  const commitMutex = new Map<number, Promise<unknown>>();

  /**
   * Apply a commit-edits diff to a region's overlay file and re-bake the
   * bundle. Coordinates three kinds of work that mustn't interleave:
   *
   *   1. Any in-flight extract for this region (started by a neighbour
   *      streaming pass or a stale viewer fetch) must finish first —
   *      otherwise that extract reads the previous overlay state and
   *      writes a bundle that doesn't reflect our edit.
   *   2. Save the merged overlay to disk.
   *   3. Enqueue a fresh extract; await it so the HTTP response only goes
   *      out once the bundle is written.
   */
  async function commitEditsForRegion(
    server: ViteDevServer,
    regionId: number,
    diff: CommitEditsDiff,
  ): Promise<void> {
    const mod = await loadModule(server);
    const prev = commitMutex.get(regionId) ?? Promise.resolve();
    const job = prev.then(async () => {
      // Drain any extract that started before us — its overlay snapshot is
      // stale by definition, so we wait it out instead of letting it stomp
      // our bundle.
      const inflightExtract = inflight.get(regionId);
      if (inflightExtract) await inflightExtract.catch(() => undefined);
      await mod.mergeAndSaveEdits(regionId, diff);
      await enqueueExtract(server, regionId);
    });
    // Don't poison future commits if this one fails.
    commitMutex.set(
      regionId,
      job.catch(() => undefined),
    );
    await job;
  }

  async function getNpcCatalog(server: ViteDevServer): Promise<NpcCatalogEntry[]> {
    if (npcCatalogPromise) return npcCatalogPromise;
    npcCatalogPromise = (async (): Promise<NpcCatalogEntry[]> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return mod.buildNpcCatalog(session.rs);
    })();
    npcCatalogPromise.catch(() => {
      npcCatalogPromise = null;
    });
    return npcCatalogPromise;
  }

  async function getGlobalAtlas(server: ViteDevServer): Promise<BakedAtlas> {
    if (globalAtlasPromise) return globalAtlasPromise;
    globalAtlasPromise = (async (): Promise<BakedAtlas> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return new Promise<BakedAtlas>((resolveJob, rejectJob) => {
        // Serialise behind the RSCache queue — the atlas build reads
        // hundreds of texture defs + sprites and can't overlap other
        // cache work.
        const task = queueTail.then(() => mod.buildGlobalAtlas(session.rs));
        queueTail = task.catch(() => undefined);
        task.then(resolveJob, rejectJob);
      });
    })();
    globalAtlasPromise.catch(() => {
      globalAtlasPromise = null;
    });
    return globalAtlasPromise;
  }

  async function getObjectCatalog(server: ViteDevServer): Promise<ObjectCatalogEntry[]> {
    if (objectCatalogPromise) return objectCatalogPromise;
    objectCatalogPromise = (async (): Promise<ObjectCatalogEntry[]> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return mod.buildObjectCatalog(session.rs);
    })();
    objectCatalogPromise.catch(() => {
      objectCatalogPromise = null;
    });
    return objectCatalogPromise;
  }

  async function getItemCatalog(server: ViteDevServer): Promise<ItemCatalogEntry[]> {
    if (itemCatalogPromise) return itemCatalogPromise;
    itemCatalogPromise = (async (): Promise<ItemCatalogEntry[]> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return mod.buildItemCatalog(session.rs);
    })();
    itemCatalogPromise.catch(() => {
      itemCatalogPromise = null;
    });
    return itemCatalogPromise;
  }

  async function getSpotAnimCatalog(
    server: ViteDevServer,
  ): Promise<SpotAnimCatalogEntry[]> {
    if (spotAnimCatalogPromise) return spotAnimCatalogPromise;
    spotAnimCatalogPromise = (async (): Promise<SpotAnimCatalogEntry[]> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return mod.buildSpotAnimCatalog(session.rs);
    })();
    spotAnimCatalogPromise.catch(() => {
      spotAnimCatalogPromise = null;
    });
    return spotAnimCatalogPromise;
  }

  async function getSequenceCatalog(
    server: ViteDevServer,
  ): Promise<SequenceCatalogEntry[]> {
    if (sequenceCatalogPromise) return sequenceCatalogPromise;
    sequenceCatalogPromise = (async (): Promise<SequenceCatalogEntry[]> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return mod.buildSequenceCatalog(session.rs);
    })();
    sequenceCatalogPromise.catch(() => {
      sequenceCatalogPromise = null;
    });
    return sequenceCatalogPromise;
  }

  /**
   * Bake a single entity on the shared RSCache queue and serialise its
   * typed arrays to plain numbers for JSON. The `bake` callback does the
   * actual decode; caller passes the per-type cache + a key so we dedupe
   * rapid re-clicks.
   */
  async function bakeEntity<K, Key extends string | number>(
    server: ViteDevServer,
    cache: Map<Key, Promise<unknown>>,
    id: Key,
    bake: (mod: ExtractorModule, session: ExtractorSession) => Promise<K & {
      positions: Float32Array | Uint8Array | number[];
      colors: Uint8Array | number[];
    }>,
    project: (baked: K) => Record<string, unknown>,
  ): Promise<unknown> {
    const cached = cache.get(id);
    if (cached) return cached;
    const job = (async (): Promise<unknown> => {
      const mod = await loadModule(server);
      const session = await getSession(server);
      return new Promise((resolveJob, rejectJob) => {
        const task = queueTail.then(() => bake(mod, session));
        queueTail = task.catch(() => undefined);
        task.then((baked) => resolveJob(project(baked)), rejectJob);
      });
    })();
    job.catch(() => cache.delete(id));
    cache.set(id, job);
    return job;
  }

  async function getBakedNpc(
    server: ViteDevServer,
    npcId: number,
    animationOverride: number | undefined,
  ): Promise<unknown> {
    const atlas = await getGlobalAtlas(server);
    const cacheKey = `${npcId}:${animationOverride ?? "d"}`;
    return bakeEntity(
      server,
      npcCache,
      cacheKey,
      (mod, session) => mod.bakeNpc(session.rs, npcId, atlas, animationOverride),
      (b) => ({
        id: b.id,
        name: b.name,
        size: b.size,
        positions: Array.from(b.positions),
        colors: Array.from(b.colors),
        uvs: Array.from(b.uvs),
        bbox: b.bbox,
        animation: b.animation
          ? {
              frameCount: b.animation.frameCount,
              frameTicks: b.animation.frameTicks,
              framesPositions: Array.from(b.animation.framesPositions),
              frameStep: b.animation.frameStep,
            }
          : undefined,
        activeAnimationId: b.activeAnimationId,
        availableAnimations: b.availableAnimations,
      }),
    );
  }

  async function getBakedObject(server: ViteDevServer, objectId: number): Promise<unknown> {
    const atlas = await getGlobalAtlas(server);
    return bakeEntity(
      server,
      objectCache,
      objectId,
      (mod, session) => mod.bakeObject(session.rs, objectId, atlas),
      (b) => ({
        id: b.id,
        name: b.name,
        modelType: b.modelType,
        sizeX: b.sizeX,
        sizeY: b.sizeY,
        contouredGround: b.contouredGround,
        animation: b.animation
          ? {
              frameCount: b.animation.frameCount,
              frameTicks: b.animation.frameTicks,
              framesPositions: Array.from(b.animation.framesPositions),
              frameStep: b.animation.frameStep,
            }
          : undefined,
        positions: Array.from(b.positions),
        colors: Array.from(b.colors),
        uvs: Array.from(b.uvs),
        bbox: b.bbox,
      }),
    );
  }

  async function getBakedItem(server: ViteDevServer, itemId: number): Promise<unknown> {
    const atlas = await getGlobalAtlas(server);
    return bakeEntity(
      server,
      itemCache,
      itemId,
      (mod, session) => mod.bakeItem(session.rs, itemId, atlas),
      (b) => ({
        id: b.id,
        name: b.name,
        positions: Array.from(b.positions),
        colors: Array.from(b.colors),
        uvs: Array.from(b.uvs),
        bbox: b.bbox,
      }),
    );
  }

  async function getBakedSpotAnim(
    server: ViteDevServer,
    spotAnimId: number,
  ): Promise<unknown> {
    const atlas = await getGlobalAtlas(server);
    return bakeEntity(
      server,
      spotAnimCache,
      spotAnimId,
      (mod, session) => mod.bakeSpotAnim(session.rs, spotAnimId, atlas),
      (b) => ({
        id: b.id,
        name: b.name,
        scale: b.scale,
        rotation: b.rotation,
        animation: b.animation
          ? {
              frameCount: b.animation.frameCount,
              frameTicks: b.animation.frameTicks,
              framesPositions: Array.from(b.animation.framesPositions),
              frameStep: b.animation.frameStep,
            }
          : undefined,
        positions: Array.from(b.positions),
        colors: Array.from(b.colors),
        uvs: Array.from(b.uvs),
        bbox: b.bbox,
      }),
    );
  }

  return {
    name: "rsmap:auto-extract",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url) return next();

        if (req.url.startsWith("/api/extract/")) {
          const match = /^\/api\/extract\/(\d+)\/?$/.exec(req.url);
          if (!match) {
            writeJson(res, 400, { error: "expected /api/extract/<regionId>" });
            return;
          }
          const regionId = Number(match[1]);
          if (!Number.isInteger(regionId) || regionId < 0 || regionId > 0xffff) {
            writeJson(res, 400, { error: `invalid region id: ${match[1]}` });
            return;
          }
          try {
            server.config.logger.info(`[auto-extract] region ${regionId} requested`);
            await enqueueExtract(server, regionId);
            writeJson(res, 200, { ok: true, regionId });
          } catch (err) {
            if (extractorModule && err instanceof extractorModule.NoSuchRegionError) {
              server.config.logger.info(
                `[auto-extract] region ${regionId} has no map data (ocean / off-map)`,
              );
              writeJson(res, 404, { error: "no map data for region", regionId });
              return;
            }
            server.config.logger.error(
              `[auto-extract] region ${regionId} failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message, regionId });
          }
          return;
        }

        if (
          req.url === "/api/dev/commit-edits" ||
          req.url.startsWith("/api/dev/commit-edits?")
        ) {
          if (req.method !== "POST") {
            writeJson(res, 405, { error: "POST required" });
            return;
          }
          const url = new URL(req.url, "http://localhost");
          const regionParam = url.searchParams.get("region");
          const regionId = Number(regionParam);
          if (!Number.isInteger(regionId) || regionId < 0 || regionId > 0xffff) {
            writeJson(res, 400, { error: `invalid region id: ${regionParam}` });
            return;
          }

          let raw: unknown;
          try {
            raw = await readJsonBody(req);
          } catch (e) {
            writeJson(res, 400, { error: `invalid body: ${(e as Error).message}` });
            return;
          }
          const body = raw as Partial<CommitEditsDiff> | null;
          if (!body || typeof body !== "object") {
            writeJson(res, 400, { error: "expected JSON object body" });
            return;
          }
          const removes = Array.isArray(body.removes) ? body.removes : [];
          const adds = Array.isArray(body.adds) ? body.adds : [];

          // Validate `removes` are 8-char hex placement IDs.
          for (const h of removes) {
            if (typeof h !== "string" || !/^[0-9a-f]{8}$/.test(h)) {
              writeJson(res, 400, { error: `invalid placement id: ${String(h)}` });
              return;
            }
          }
          // Validate `adds` field-by-field. We deliberately DON'T check
          // locId against the object catalog — the catalog filters out
          // entries with `name === "null"`, but the eyedropper + placer
          // happily round-trip those ids (any baked-loc you can click
          // is a valid id). The extractor logs `noDef` for genuine
          // typos, which is enough surface area.
          const intIn = (v: unknown, lo: number, hi: number): boolean =>
            typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
          for (const a of adds) {
            if (!a || typeof a !== "object") {
              writeJson(res, 400, { error: "add must be an object" });
              return;
            }
            if (!intIn(a.locId, 0, 0xfffff)) {
              writeJson(res, 400, { error: `invalid locId: ${String(a.locId)}` });
              return;
            }
            if (!intIn(a.plane, 0, 3)) {
              writeJson(res, 400, { error: `invalid plane: ${String(a.plane)}` });
              return;
            }
            if (!intIn(a.tileX, 0, 63) || !intIn(a.tileZ, 0, 63)) {
              writeJson(res, 400, {
                error: `invalid tile coords: ${String(a.tileX)},${String(a.tileZ)}`,
              });
              return;
            }
            if (!intIn(a.type, 0, 22)) {
              writeJson(res, 400, { error: `invalid type: ${String(a.type)}` });
              return;
            }
            if (!intIn(a.rotation, 0, 3)) {
              writeJson(res, 400, { error: `invalid rotation: ${String(a.rotation)}` });
              return;
            }
            if (
              a.animationOverride !== null &&
              !intIn(a.animationOverride, 0, 0xffffff)
            ) {
              writeJson(res, 400, {
                error: `invalid animationOverride: ${String(a.animationOverride)}`,
              });
              return;
            }
            // Sub-tile offsets are world-unit fractions; allow up to one
            // full tile in either direction (placer-side shouldn't ever
            // exceed half a tile, but be lenient in case someone hand-
            // edits the overlay).
            const numIn = (v: unknown, lo: number, hi: number): boolean =>
              typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
            if (a.offsetX !== undefined && !numIn(a.offsetX, -128, 128)) {
              writeJson(res, 400, { error: `invalid offsetX: ${String(a.offsetX)}` });
              return;
            }
            if (a.offsetZ !== undefined && !numIn(a.offsetZ, -128, 128)) {
              writeJson(res, 400, { error: `invalid offsetZ: ${String(a.offsetZ)}` });
              return;
            }
            // Residual rotation is bounded by the cardinal decomposition's
            // range (−π/4..π/4]. Be lenient — accept the full circle in
            // case a hand-edit happens to record an un-normalised value.
            const TWO_PI = Math.PI * 2;
            if (a.rotationY !== undefined && !numIn(a.rotationY, -TWO_PI, TWO_PI)) {
              writeJson(res, 400, { error: `invalid rotationY: ${String(a.rotationY)}` });
              return;
            }
          }

          try {
            server.config.logger.info(
              `[commit-edits] region ${regionId}: ${removes.length} removes, ${adds.length} adds`,
            );
            await commitEditsForRegion(server, regionId, {
              removes,
              adds: adds as CommitEditsDiff["adds"],
            });
            writeJson(res, 200, { ok: true, regionId });
          } catch (err) {
            server.config.logger.error(
              `[commit-edits] region ${regionId} failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message, regionId });
          }
          return;
        }

        if (req.url === "/api/dev/reset-atlas") {
          // Dev-only escape hatch: clear cached atlas + entity bakes so the
          // next request rebuilds them. Needed after changing the extractor
          // code — ssrLoadModule re-evaluates changed modules, but the
          // existing cached atlas/bakes still point at the old module.
          globalAtlasPromise = null;
          npcCache.clear();
          objectCache.clear();
          itemCache.clear();
          spotAnimCache.clear();
          npcCatalogPromise = null;
          objectCatalogPromise = null;
          itemCatalogPromise = null;
          spotAnimCatalogPromise = null;
          sequenceCatalogPromise = null;
          extractorModule = null;
          writeJson(res, 200, { ok: true });
          return;
        }

        if (req.url === "/api/texture-atlas.json" || req.url === "/api/texture-atlas.png") {
          try {
            const atlas = await getGlobalAtlas(server);
            if (req.url.endsWith(".json")) {
              writeJson(res, 200, atlas.manifest);
            } else {
              res.statusCode = 200;
              res.setHeader("content-type", "image/png");
              // Hint the browser to cache across reloads — the atlas
              // doesn't change until the cache build changes.
              res.setHeader("cache-control", "max-age=3600");
              res.end(atlas.pngBytes);
            }
          } catch (err) {
            server.config.logger.error(
              `[texture-atlas] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url === "/api/npc-catalog" || req.url.startsWith("/api/npc-catalog?")) {
          try {
            const catalog = await getNpcCatalog(server);
            writeJson(res, 200, { entries: catalog });
          } catch (err) {
            server.config.logger.error(
              `[npc-catalog] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url === "/api/object-catalog" || req.url.startsWith("/api/object-catalog?")) {
          try {
            const catalog = await getObjectCatalog(server);
            writeJson(res, 200, { entries: catalog });
          } catch (err) {
            server.config.logger.error(
              `[object-catalog] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url === "/api/item-catalog" || req.url.startsWith("/api/item-catalog?")) {
          try {
            const catalog = await getItemCatalog(server);
            writeJson(res, 200, { entries: catalog });
          } catch (err) {
            server.config.logger.error(
              `[item-catalog] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (
          req.url === "/api/sequence-catalog" ||
          req.url.startsWith("/api/sequence-catalog?")
        ) {
          try {
            const catalog = await getSequenceCatalog(server);
            writeJson(res, 200, { entries: catalog });
          } catch (err) {
            server.config.logger.error(
              `[sequence-catalog] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url.startsWith("/api/npc/")) {
          // Split the URL into path + query so we can accept `?anim=<id>`.
          // Node's `req.url` doesn't include the host, so parse against a
          // dummy base.
          const url = new URL(req.url, "http://localhost");
          const match = /^\/api\/npc\/(\d+)\/?$/.exec(url.pathname);
          if (!match) {
            writeJson(res, 400, { error: "expected /api/npc/<npcId>" });
            return;
          }
          const npcId = Number(match[1]);
          if (!Number.isInteger(npcId) || npcId < 0) {
            writeJson(res, 400, { error: `invalid npc id: ${match[1]}` });
            return;
          }
          const animParam = url.searchParams.get("anim");
          let animationOverride: number | undefined;
          if (animParam !== null) {
            const n = Number(animParam);
            if (!Number.isInteger(n) || n < 0) {
              writeJson(res, 400, { error: `invalid anim id: ${animParam}` });
              return;
            }
            animationOverride = n;
          }
          try {
            const baked = await getBakedNpc(server, npcId, animationOverride);
            writeJson(res, 200, baked);
          } catch (err) {
            const msg = (err as Error).message;
            const status =
              /no models|not in cache|no usable models/i.test(msg) ? 404 : 500;
            if (status !== 404) {
              server.config.logger.error(`[npc] ${npcId} failed: ${msg}`);
            }
            writeJson(res, status, { error: msg, npcId });
          }
          return;
        }

        if (req.url.startsWith("/api/object/")) {
          const match = /^\/api\/object\/(\d+)\/?$/.exec(req.url);
          if (!match) {
            writeJson(res, 400, { error: "expected /api/object/<objectId>" });
            return;
          }
          const objectId = Number(match[1]);
          if (!Number.isInteger(objectId) || objectId < 0) {
            writeJson(res, 400, { error: `invalid object id: ${match[1]}` });
            return;
          }
          try {
            const baked = await getBakedObject(server, objectId);
            writeJson(res, 200, baked);
          } catch (err) {
            const msg = (err as Error).message;
            const status =
              /not in cache|no geometry/i.test(msg) ? 404 : 500;
            if (status !== 404) {
              server.config.logger.error(`[object] ${objectId} failed: ${msg}`);
            }
            writeJson(res, status, { error: msg, objectId });
          }
          return;
        }

        if (req.url.startsWith("/api/item/")) {
          const match = /^\/api\/item\/(\d+)\/?$/.exec(req.url);
          if (!match) {
            writeJson(res, 400, { error: "expected /api/item/<itemId>" });
            return;
          }
          const itemId = Number(match[1]);
          if (!Number.isInteger(itemId) || itemId < 0) {
            writeJson(res, 400, { error: `invalid item id: ${match[1]}` });
            return;
          }
          try {
            const baked = await getBakedItem(server, itemId);
            writeJson(res, 200, baked);
          } catch (err) {
            const msg = (err as Error).message;
            const status =
              /not in cache|no inventoryModel|empty model|templated/i.test(msg) ? 404 : 500;
            if (status !== 404) {
              server.config.logger.error(`[item] ${itemId} failed: ${msg}`);
            }
            writeJson(res, status, { error: msg, itemId });
          }
          return;
        }

        if (
          req.url === "/api/spotanim-catalog" ||
          req.url.startsWith("/api/spotanim-catalog?")
        ) {
          try {
            const catalog = await getSpotAnimCatalog(server);
            writeJson(res, 200, { entries: catalog });
          } catch (err) {
            server.config.logger.error(
              `[spotanim-catalog] failed: ${(err as Error).message}`,
            );
            writeJson(res, 500, { error: (err as Error).message });
          }
          return;
        }

        if (req.url.startsWith("/api/spotanim/")) {
          const match = /^\/api\/spotanim\/(\d+)\/?$/.exec(req.url);
          if (!match) {
            writeJson(res, 400, { error: "expected /api/spotanim/<spotAnimId>" });
            return;
          }
          const spotAnimId = Number(match[1]);
          if (!Number.isInteger(spotAnimId) || spotAnimId < 0) {
            writeJson(res, 400, { error: `invalid spotanim id: ${match[1]}` });
            return;
          }
          try {
            const baked = await getBakedSpotAnim(server, spotAnimId);
            writeJson(res, 200, baked);
          } catch (err) {
            const msg = (err as Error).message;
            const status =
              /not in cache|no model|no geometry/i.test(msg) ? 404 : 500;
            if (status !== 404) {
              server.config.logger.error(`[spotanim] ${spotAnimId} failed: ${msg}`);
            }
            writeJson(res, status, { error: msg, spotAnimId });
          }
          return;
        }

        return next();
      });
    },
    async closeBundle() {
      if (sessionPromise) {
        try {
          const s = await sessionPromise;
          s.close();
        } catch {
          /* session never finished booting — nothing to close */
        }
      }
    },
  };
}

export default defineConfig({
  // Disable the SPA fallback so 404s for missing region bundles actually
  // come back as 404 (the loader relies on that to decide when to kick off
  // an auto-extract). Default `appType: 'spa'` would serve index.html in
  // place of any unknown path.
  appType: "mpa",
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
  // Prevent Vite from pre-bundling the extractor's Node-only deps for the
  // browser. ssrLoadModule pulls them in on the server side only.
  optimizeDeps: {
    exclude: ["@rsmap/extractor"],
  },
  ssr: {
    noExternal: ["@rsmap/extractor", "@rsmap/shared"],
  },
  plugins: [autoExtractPlugin()],
});
