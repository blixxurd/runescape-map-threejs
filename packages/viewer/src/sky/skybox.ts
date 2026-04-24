import * as THREE from "three";

/**
 * Procedural skybox with interchangeable presets.
 *
 * A unit-radius sphere that rides the camera (like `nightSky`'s original
 * implementation) and writes a fragment color from the view direction.
 * `xyww` clip-space trick + `depthTest: false` keeps it rendering as a
 * background fill regardless of sphere radius.
 *
 * Presets flip uniforms rather than rebuilding the mesh/material. Swapping
 * between sky types is free — the GPU program stays the same, only
 * constants change.
 */
export type SkyPreset = "off" | "aurora" | "clear-night" | "overcast-day" | "dawn";

export interface SkyPresetInfo {
  id: SkyPreset;
  label: string;
}

export const SKY_PRESETS: SkyPresetInfo[] = [
  { id: "aurora", label: "Aurora Night" },
  { id: "clear-night", label: "Clear Night" },
  { id: "dawn", label: "Dawn" },
  { id: "overcast-day", label: "Overcast Day" },
  { id: "off", label: "Off" },
];

export interface Skybox {
  mesh: THREE.Mesh;
  /** Current preset — default `"aurora"`. */
  getPreset(): SkyPreset;
  /** Switch to a new preset. `"off"` hides the mesh; others re-show it. */
  setPreset(preset: SkyPreset): void;
  /** Ambient-fill color the scene.background should be set to for the
   *  preset — matches the horizon tint so fog fades in cleanly at the
   *  far plane. */
  getBackgroundColor(): THREE.Color;
  update(cameraPosition: THREE.Vector3, elapsedMs: number): void;
}

/** Uniform packet shared by every preset. Presets flip individual fields
 *  in `applyPreset` rather than swapping shaders — keeps the program
 *  count at 1 and the switch branchless at runtime. Index signature
 *  satisfies Three.js's `ShaderMaterial.uniforms` shape. */
interface SkyUniforms {
  [key: string]: THREE.IUniform<unknown>;
  uTime: { value: number };
  uHorizon: { value: THREE.Color };
  uZenith: { value: THREE.Color };
  uGlowColor: { value: THREE.Color };
  uGlowStrength: { value: number };
  uStarStrength: { value: number };
  uAuroraStrength: { value: number };
}

/** Palette + flags for each preset. Colors are linear-sRGB (these feed
 *  straight into `gl_FragColor` without further processing). */
const PRESETS: Record<SkyPreset, {
  horizon: [number, number, number];
  zenith: [number, number, number];
  glow: [number, number, number];
  glowStrength: number;
  starStrength: number;
  auroraStrength: number;
  background: [number, number, number];
}> = {
  off: {
    horizon: [0.043, 0.059, 0.102],
    zenith: [0.043, 0.059, 0.102],
    glow: [0, 0, 0],
    glowStrength: 0,
    starStrength: 0,
    auroraStrength: 0,
    background: [0.043, 0.059, 0.102],
  },
  aurora: {
    horizon: [0.018, 0.050, 0.145],
    zenith: [0.004, 0.015, 0.070],
    glow: [0.05, 0.18, 0.45],
    glowStrength: 0.20,
    starStrength: 1.0,
    auroraStrength: 1.0,
    background: [0.018, 0.050, 0.145],
  },
  "clear-night": {
    horizon: [0.020, 0.040, 0.110],
    zenith: [0.003, 0.010, 0.050],
    glow: [0.05, 0.12, 0.30],
    glowStrength: 0.12,
    starStrength: 1.2,
    auroraStrength: 0,
    background: [0.020, 0.040, 0.110],
  },
  dawn: {
    horizon: [0.95, 0.60, 0.40],
    zenith: [0.20, 0.28, 0.55],
    glow: [1.0, 0.75, 0.45],
    glowStrength: 0.60,
    starStrength: 0.15, // fading
    auroraStrength: 0,
    background: [0.45, 0.35, 0.40],
  },
  "overcast-day": {
    horizon: [0.80, 0.82, 0.86],
    zenith: [0.48, 0.53, 0.60],
    glow: [0.90, 0.92, 0.94],
    glowStrength: 0.15,
    starStrength: 0,
    auroraStrength: 0,
    background: [0.70, 0.73, 0.78],
  },
};

export function createSkybox(initial: SkyPreset = "aurora"): Skybox {
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const uniforms: SkyUniforms = {
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uGlowColor: { value: new THREE.Color() },
    uGlowStrength: { value: 0 },
    uStarStrength: { value: 0 },
    uAuroraStrength: { value: 0 },
  };
  const backgroundColor = new THREE.Color();

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // xyww trick: clip-space z pinned to w → post-divide z = 1 (far
        // plane). depthTest:false keeps the sky from occluding real geo.
        vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clipPos.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uGlowColor;
      uniform float uGlowStrength;
      uniform float uStarStrength;
      uniform float uAuroraStrength;

      // 3D hash/noise/fbm. Direction-vector driven → no atan branch-cut
      // seam at ±π (that was the west-facing line before the fix).
      float hash3(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }
      float noise3(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), u.x),
              mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
          mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
              mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y),
          u.z
        );
      }
      float fbm3(vec3 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * noise3(p);
          p *= 2.02;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, 0.0, 1.0);

        vec3 col = mix(uHorizon, uZenith, pow(up, 0.7));

        // Star field — strength uniform lets daytime/overcast presets
        // skip the star contribution entirely (uStarStrength = 0).
        if (uStarStrength > 0.0) {
          vec3 starP = d * 140.0;
          vec3 starI = floor(starP);
          vec3 starF = fract(starP);
          float cellSeed = hash3(starI);
          vec3 starCenter = vec3(
            hash3(starI + 7.1),
            hash3(starI + 19.3),
            hash3(starI + 31.5)
          );
          float starDist = distance(starF, starCenter);
          float starPresent = step(0.992, cellSeed);
          float starBrightness = smoothstep(0.06, 0.0, starDist);
          float twinkle = 0.55 + 0.45 * sin(uTime * 0.0008 + cellSeed * 100.0);
          float horizonFade = smoothstep(0.02, 0.18, d.y);
          col += uStarStrength * starPresent * starBrightness * twinkle * horizonFade * vec3(0.80, 0.88, 1.00);
        }

        // Aurora — as before, gated by the strength uniform.
        if (uAuroraStrength > 0.0) {
          float t = uTime * 0.000007;
          vec3 drift1 = vec3(t * 1.8, 0.0, t * 0.9);
          vec3 drift2 = vec3(-t * 1.2, 0.0, t * 1.6);
          float band1 = fbm3(d * 2.6 + drift1);
          float band2 = fbm3(d * 3.2 + drift2 + 4.2);
          float aurora = pow(band1, 2.0) * pow(band2, 2.2);
          float heightMask = smoothstep(0.04, 0.30, d.y) * (1.0 - smoothstep(0.55, 0.95, d.y));
          aurora *= heightMask * 5.5 * uAuroraStrength;
          vec3 auroraColor = mix(vec3(0.05, 0.45, 0.75), vec3(0.15, 0.80, 0.70), band1);
          auroraColor = mix(auroraColor, vec3(0.45, 0.20, 0.90), pow(band2, 3.0));
          col += auroraColor * aurora;
        }

        if (uGlowStrength > 0.0) {
          float horizonGlow = exp(-pow(d.y * 9.0, 2.0)) * uGlowStrength;
          col += horizonGlow * uGlowColor;
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  let currentPreset: SkyPreset = initial;

  const applyPreset = (preset: SkyPreset): void => {
    const p = PRESETS[preset];
    uniforms.uHorizon.value.setRGB(p.horizon[0], p.horizon[1], p.horizon[2]);
    uniforms.uZenith.value.setRGB(p.zenith[0], p.zenith[1], p.zenith[2]);
    uniforms.uGlowColor.value.setRGB(p.glow[0], p.glow[1], p.glow[2]);
    uniforms.uGlowStrength.value = p.glowStrength;
    uniforms.uStarStrength.value = p.starStrength;
    uniforms.uAuroraStrength.value = p.auroraStrength;
    backgroundColor.setRGB(p.background[0], p.background[1], p.background[2]);
    // "off" still gets the gradient-only uniforms applied (so the Scene's
    // background color stays consistent) but the sphere itself hides.
    mesh.visible = preset !== "off";
  };
  applyPreset(initial);

  return {
    mesh,
    getPreset: () => currentPreset,
    setPreset(preset) {
      currentPreset = preset;
      applyPreset(preset);
    },
    getBackgroundColor: () => backgroundColor,
    update(cameraPosition, elapsedMs) {
      if (!mesh.visible) return;
      mesh.position.copy(cameraPosition);
      uniforms.uTime.value = elapsedMs;
    },
  };
}
