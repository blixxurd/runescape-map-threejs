import { SKY_PRESETS, type SkyPreset } from "./skybox.js";

/**
 * Small bottom-left panel with the Sky-preset dropdown + fog controls. Sits
 * under the HUD and hides when `body.ui-hidden` is set (H hotkey).
 *
 * Fog defaults off. When enabled, two sliders drive a linear `THREE.Fog`:
 *   - **distance** — world units where fog reaches full opacity (the `far`
 *     plane of the fog)
 *   - **thickness** — `[0, 1]` fraction of the distance that lies in the
 *     fade ramp. `thickness = 0` → fog switches on instantly at `distance`;
 *     `thickness = 1` → fog starts fading in right at the camera.
 *
 *   near = distance × (1 − thickness)
 *   far  = distance
 */
export interface FogState {
  enabled: boolean;
  /** World units — linear fog's `far`. */
  distance: number;
  /** 0..1 — fraction of `distance` that's in the fade ramp (vs. clear). */
  thickness: number;
}

export interface EnvironmentPanelHost {
  onSkyChange(preset: SkyPreset): void;
  onFogChange(state: FogState): void;
}

/** Slider ranges. Distance covers "inside a region" → "across the loaded
 *  grid and then some" so most scenes can find a comfortable setting. */
const DISTANCE_MIN = 500;
const DISTANCE_MAX = 30000;
const DISTANCE_DEFAULT = 8000;
const THICKNESS_DEFAULT = 0.6;

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #envPanel {
      position: fixed; bottom: 8px; left: 8px;
      background: rgba(0,0,0,0.70); color: #d5dce8;
      border: 1px solid #2a334a; border-radius: 4px;
      padding: 6px 8px;
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 10;
      display: grid; grid-template-columns: auto 1fr; gap: 4px 6px;
      align-items: center;
      min-width: 260px;
    }
    #envPanel label { color: #7aa6d6; letter-spacing: 0.3px; }
    #envPanel select {
      background: #10131d; color: #e6e8ec;
      border: 1px solid #2a334a; border-radius: 3px;
      padding: 2px 4px; font: inherit; outline: none;
      width: 100%;
    }
    #envPanel select:focus { border-color: #7aa6d6; }
    #envPanel .fog-head {
      display: flex; align-items: center; gap: 5px;
      color: #d5dce8;
    }
    #envPanel .fog-head input { margin: 0; cursor: pointer; accent-color: #7aa6d6; }
    #envPanel .slider-row {
      display: grid; grid-template-columns: 1fr 3em; gap: 4px; align-items: center;
    }
    #envPanel .slider-row input[type="range"] {
      width: 100%; margin: 0; accent-color: #7aa6d6;
    }
    #envPanel .slider-row .val {
      color: #8f9bb5; font-size: 10.5px; text-align: right;
    }
    #envPanel .sub { color: #8f9bb5; padding-left: 8px; font-size: 10.5px; }
    #envPanel input:disabled + .val,
    #envPanel .slider-row input:disabled { opacity: 0.35; }
    body.ui-hidden #envPanel { display: none !important; }
  `;
  document.head.appendChild(style);
}

export class EnvironmentPanel {
  private readonly host: EnvironmentPanelHost;
  private readonly root: HTMLDivElement;
  private readonly skySelect: HTMLSelectElement;
  private readonly fogToggle: HTMLInputElement;
  private readonly fogDistance: HTMLInputElement;
  private readonly fogThickness: HTMLInputElement;
  private readonly fogDistanceVal: HTMLSpanElement;
  private readonly fogThicknessVal: HTMLSpanElement;

  constructor(host: EnvironmentPanelHost, initial: { sky: SkyPreset }) {
    this.host = host;
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "envPanel";
    this.root.innerHTML = `
      <label for="envSky">sky</label>
      <select id="envSky">
        ${SKY_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}
      </select>
      <label for="envFogToggle">fog</label>
      <div class="fog-head">
        <input type="checkbox" id="envFogToggle" />
        <span>enable</span>
      </div>
      <label class="sub" for="envFogDist">distance</label>
      <div class="slider-row">
        <input type="range" id="envFogDist"
          min="${DISTANCE_MIN}" max="${DISTANCE_MAX}" step="100"
          value="${DISTANCE_DEFAULT}" disabled />
        <span class="val" id="envFogDistVal">${DISTANCE_DEFAULT}</span>
      </div>
      <label class="sub" for="envFogThick">thickness</label>
      <div class="slider-row">
        <input type="range" id="envFogThick"
          min="0" max="100" step="1"
          value="${Math.round(THICKNESS_DEFAULT * 100)}" disabled />
        <span class="val" id="envFogThickVal">${THICKNESS_DEFAULT.toFixed(2)}</span>
      </div>
    `;
    document.body.appendChild(this.root);

    this.skySelect = this.root.querySelector<HTMLSelectElement>("#envSky")!;
    this.fogToggle = this.root.querySelector<HTMLInputElement>("#envFogToggle")!;
    this.fogDistance = this.root.querySelector<HTMLInputElement>("#envFogDist")!;
    this.fogThickness = this.root.querySelector<HTMLInputElement>("#envFogThick")!;
    this.fogDistanceVal = this.root.querySelector<HTMLSpanElement>("#envFogDistVal")!;
    this.fogThicknessVal = this.root.querySelector<HTMLSpanElement>("#envFogThickVal")!;

    this.skySelect.value = initial.sky;

    this.skySelect.addEventListener("change", () => {
      this.host.onSkyChange(this.skySelect.value as SkyPreset);
    });
    this.fogToggle.addEventListener("change", () => this.emitFog());
    this.fogDistance.addEventListener("input", () => this.emitFog());
    this.fogThickness.addEventListener("input", () => this.emitFog());
  }

  private emitFog(): void {
    const enabled = this.fogToggle.checked;
    // Sliders grey out when disabled so their position still reflects what
    // values will come back the next time fog's flipped on.
    this.fogDistance.disabled = !enabled;
    this.fogThickness.disabled = !enabled;
    const distance = Number(this.fogDistance.value);
    const thickness = Number(this.fogThickness.value) / 100;
    this.fogDistanceVal.textContent = String(distance);
    this.fogThicknessVal.textContent = thickness.toFixed(2);
    this.host.onFogChange({ enabled, distance, thickness });
  }
}
