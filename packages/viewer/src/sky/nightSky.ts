import * as THREE from "three";

/**
 * Procedural Skyrim-style aurora night sky — a unit-radius sphere that rides
 * the camera and writes color in the fragment shader from the view direction.
 *
 * No depth test / write + `renderOrder = -1` + BackSide: draws first as a
 * background fill, behind all scene geometry, regardless of the sphere's
 * actual radius or where it sits relative to the scene. `position.copy(cam)`
 * per frame keeps the sphere centered on the camera so you can never fly
 * "through" it.
 *
 * Fog doesn't apply (ShaderMaterial opts out by default) — which is what we
 * want: the sky is at infinity, not in the fog volume.
 */
export interface NightSky {
  mesh: THREE.Mesh;
  update(cameraPosition: THREE.Vector3, elapsedMs: number): void;
}

export function createNightSky(): NightSky {
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        // Standard skybox trick: pin z to w so post-perspective-divide z = 1
        // (the far plane). Without this, a unit sphere is inside the camera's
        // near plane (16 world units) and every vertex gets clipped — the
        // sky never renders. xyww makes rendering independent of the sphere
        // radius and of the scene's near/far. Paired with depthTest: false
        // so the sky doesn't occlude real geometry at the far plane either.
        vec4 clipPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clipPos.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
                   u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * noise(p);
          p *= 2.02;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        float up = clamp(d.y, 0.0, 1.0);

        // Base gradient: cool blue near horizon → deep indigo at zenith.
        // More chroma on the blue end than the previous near-black to give
        // the whole dome a nighttime-ocean feel.
        vec3 horizon = vec3(0.018, 0.050, 0.145);
        vec3 zenith  = vec3(0.004, 0.015, 0.070);
        vec3 col = mix(horizon, zenith, pow(up, 0.7));

        // Star field — point stars, not grid cells. For each hash cell we
        // pick a random sub-cell position and measure the distance to it,
        // giving a small round dot that sits inside the cell's boundary
        // (so low-frequency cell aliasing doesn't reveal the grid). Cell
        // size is tuned so stars occupy ~1px at typical viewing distance.
        vec2 starUv = vec2(atan(d.z, d.x) * 60.0, d.y * 140.0);
        vec2 cell = floor(starUv);
        vec2 subCell = fract(starUv);
        float cellSeed = hash(cell);
        vec2 starCenter = vec2(hash(cell + 7.1), hash(cell + 19.3));
        float starDist = distance(subCell, starCenter);
        float starPresent = step(0.985, cellSeed); // ~1.5% of cells get a star
        float starBrightness = smoothstep(0.06, 0.0, starDist);
        float twinkle = 0.55 + 0.45 * sin(uTime * 0.0008 + cellSeed * 100.0);
        float horizonFade = smoothstep(0.02, 0.18, d.y);
        col += starPresent * starBrightness * twinkle * horizonFade * vec3(0.80, 0.88, 1.00);

        // Aurora. Two FBM bands scrolling at different speeds (slow), masked
        // to the mid-sky. Palette leans blue-cyan with a purple fringe —
        // green is still present but subordinate to the blues now.
        float az = atan(d.z, d.x);
        float h = d.y;
        float t = uTime * 0.000007;
        float band1 = fbm(vec2(az * 2.2 + t * 5.0, h * 5.5));
        float band2 = fbm(vec2(az * 1.6 - t * 3.5, h * 7.5 + 4.2));
        float aurora = pow(band1, 2.0) * pow(band2, 2.2);
        float heightMask = smoothstep(0.04, 0.30, h) * (1.0 - smoothstep(0.55, 0.95, h));
        aurora *= heightMask * 5.5;

        vec3 auroraColor = mix(vec3(0.05, 0.45, 0.75), vec3(0.15, 0.80, 0.70), band1);
        auroraColor = mix(auroraColor, vec3(0.45, 0.20, 0.90), pow(band2, 3.0));

        col += auroraColor * aurora;

        // Soft horizon glow — shifted toward blue to match the new palette.
        float horizonGlow = exp(-pow(d.y * 9.0, 2.0)) * 0.20;
        col += horizonGlow * vec3(0.05, 0.18, 0.45);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Small sphere + no depth test means clipping/frustum is meaningless; keep
  // it visible regardless of camera pose.
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.visible = false;

  return {
    mesh,
    update(cameraPosition: THREE.Vector3, elapsedMs: number): void {
      if (!mesh.visible) return;
      mesh.position.copy(cameraPosition);
      (material.uniforms.uTime as { value: number }).value = elapsedMs;
    },
  };
}
