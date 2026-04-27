import * as THREE from "three";

/**
 * Capture the current scene as a PNG and trigger a download.
 *
 * The renderer's drawing buffer is normally cleared between frames
 * (`preserveDrawingBuffer: false` — the default, kept for perf), so
 * `canvas.toDataURL()` would catch an empty frame if called outside the
 * `requestAnimationFrame` cycle. We force a synchronous render right
 * before reading the canvas, in the same JS turn, so the buffer is
 * guaranteed populated.
 *
 * Filename layout: `runescape-<centerRegion>-YYYY-MM-DD-HHMM.png`.
 * Region + timestamp give every screenshot a unique, sortable name.
 */
export function captureScreenshot(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  regionId: number,
): void {
  renderer.render(scene, camera);
  const canvas = renderer.domElement;
  const dataUrl = canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filenameFor(regionId);
  // Without an in-DOM anchor some browsers ignore the click event.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function filenameFor(regionId: number): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `runescape-${regionId}-${stamp}.png`;
}
