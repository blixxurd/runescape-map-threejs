import type { SaveBundle, SaveSummary } from "@rsmap/shared/save-file";
import { parseSaveBundle } from "@rsmap/shared/save-file";

/**
 * Transport for the dev-server save endpoints. Isolated from `SaveStore`
 * so the store stays testable without fetch mocking.
 *
 * Every method throws on failure; callers surface the message. A static
 * build has no dev server, so `isAvailable()` probes once and the map menu
 * disables itself rather than throwing on every click.
 */
export class SaveClient {
  private availability: Promise<boolean> | null = null;

  isAvailable(): Promise<boolean> {
    if (!this.availability) {
      this.availability = fetch("/api/dev/saves")
        .then((r) => r.ok)
        .catch(() => false);
    }
    return this.availability;
  }

  async list(): Promise<SaveSummary[]> {
    const r = await fetch("/api/dev/saves");
    if (!r.ok) throw new Error(`list saves failed: HTTP ${r.status}`);
    return ((await r.json()) as { saves: SaveSummary[] }).saves;
  }

  async read(slug: string): Promise<SaveBundle> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`load "${slug}" failed: HTTP ${r.status}`);
    return parseSaveBundle(await r.json());
  }

  async write(bundle: SaveBundle): Promise<void> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(bundle.manifest.slug)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(`save failed: ${body.error ?? `HTTP ${r.status}`}`);
    }
  }

  async remove(slug: string): Promise<void> {
    const r = await fetch(`/api/dev/saves/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (!r.ok) throw new Error(`delete "${slug}" failed: HTTP ${r.status}`);
  }
}
