import * as THREE from "three";

/**
 * Fetch + decode the dev server's shared texture atlas.
 *
 * One PNG + one JSON manifest; returned as a ready-to-use `THREE.Texture`
 * along with the manifest the bakers use to key UVs. Cached per-page so
 * mounting a second ModelPlacer doesn't re-download.
 *
 * The atlas is configured the same way as region atlases:
 *   - `colorSpace = NoColorSpace` (OSRS is authored in sRGB-as-linear;
 *     Three's default sRGB→Linear→sRGB pipeline double-encodes).
 *   - `minFilter = LinearMipmapLinearFilter` for clean zoom-out.
 *   - `magFilter = NearestFilter` to preserve the chunky OSRS look.
 *   - No wrap — UVs from the bakers are clamped, and each cell has an
 *     8-pixel replicated-edge gutter so mipmaps don't bleed across cells.
 */

export interface GlobalAtlas {
  texture: THREE.Texture;
  manifest: {
    atlasSize: number;
    cellSize: number;
    cellsPerRow: number;
    gutter?: number;
    cellByTextureId: Record<number, number>;
  };
}

let promise: Promise<GlobalAtlas> | null = null;

export async function loadGlobalAtlas(): Promise<GlobalAtlas> {
  if (promise) return promise;
  promise = (async (): Promise<GlobalAtlas> => {
    const [manifestResp, image] = await Promise.all([
      fetch("/api/texture-atlas.json").then((r) => {
        if (!r.ok) throw new Error(`atlas.json: ${r.status}`);
        return r.json() as Promise<GlobalAtlas["manifest"]>;
      }),
      loadImage("/api/texture-atlas.png"),
    ]);
    const texture = new THREE.Texture(image);
    // Must match the region-atlas loader in `main.ts` — without `flipY =
    // false` the server's top-left-origin UVs land on the wrong row and
    // untextured faces sample a transparent neighbour cell, failing the
    // placer material's alphaTest and rendering nothing. Similarly,
    // `ClampToEdgeWrapping` is mandatory for non-POT atlases in WebGL 1
    // (where `RepeatWrapping` silently renders black).
    texture.colorSpace = THREE.NoColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.flipY = false;
    texture.needsUpdate = true;
    return { texture, manifest: manifestResp };
  })();
  promise.catch(() => {
    promise = null;
  });
  return promise;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}
