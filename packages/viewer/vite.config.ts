import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import type {
  ExtractorSession,
  extractRegion as ExtractRegionFn,
  openExtractorSession as OpenSessionFn,
  NoSuchRegionError as NoSuchRegionErrorCtor,
} from "@rsmap/extractor";
import { defineConfig } from "vite";

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
  }

  let extractorModule: ExtractorModule | null = null;
  let sessionPromise: Promise<ExtractorSession> | null = null;

  // In-flight dedupe: same regionId → same promise. A single queueTail
  // serializes distinct regions so RSCache sees one call at a time.
  const inflight = new Map<number, Promise<void>>();
  let queueTail: Promise<unknown> = Promise.resolve();

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

  return {
    name: "rsmap:auto-extract",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        if (!req.url?.startsWith("/api/extract/")) return next();
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
