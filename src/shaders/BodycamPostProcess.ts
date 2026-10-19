import * as THREE from 'three';

export class BodycamPostProcess {
  private rt: THREE.WebGLRenderTarget;
  private orthoScene: THREE.Scene;
  private orthoCamera: THREE.OrthographicCamera;
  private quad: THREE.Mesh;
  public material: THREE.ShaderMaterial;

  // User-tunable optics parameters
  public fisheyeStrength = 0.34;
  public chromaticBase = 0.0042;
  public grainStrength = 0.048;
  public nvgEnabled = false;

  constructor(width: number, height: number) {
    this.rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });

    this.orthoScene = new THREE.Scene();
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) },
        uDistortion: { value: this.fisheyeStrength },
        uChromatic: { value: this.chromaticBase },
        uGrain: { value: this.grainStrength },
        uStress: { value: 0 },
        uDamage: { value: 0 },
        uFlashbang: { value: 0 },
        uAdsAmount: { value: 0 },
        uNVG: { value: 0 },
        uDroneMode: { value: 0 },
        uExposure: { value: 1.08 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform vec2 uResolution;
        uniform float uDistortion;
        uniform float uChromatic;
        uniform float uGrain;
        uniform float uStress;
        uniform float uDamage;
        uniform float uFlashbang;
        uniform float uAdsAmount;
        uniform float uNVG;
        uniform float uDroneMode;
        uniform float uExposure;

        varying vec2 vUv;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        vec2 barrelDistort(vec2 uv, float k) {
          vec2 centered = uv - 0.5;
          float r2 = dot(centered, centered);
          float factor = 1.0 + k * r2 + (k * 0.65) * r2 * r2;
          // Zoom in slightly to compensate for barrel edges
          float scale = 1.0 / (1.0 + k * 0.22);
          return centered * factor * scale + 0.5;
        }

        void main() {
          // Reduce fisheye distortion slightly when aiming down sights (ADS) for crisp sight picture
          float activeDistort = mix(uDistortion, uDistortion * 0.45, uAdsAmount);
          vec2 distUv = barrelDistort(vUv, activeDistort);

          vec2 centered = distUv - 0.5;
          float distFromCenter = length(centered);

          // Check out-of-bounds lens housing corners
          if (distUv.x < 0.0 || distUv.x > 1.0 || distUv.y < 0.0 || distUv.y > 1.0) {
            gl_FragColor = vec4(0.01, 0.01, 0.012, 1.0);
            return;
          }

          // Dynamic Radial Chromatic Aberration (stronger at lens edges & during recoil/stress)
          float caAmount = (uChromatic + uStress * 0.005 + uDamage * 0.008) * (0.25 + distFromCenter * 2.2);
          vec2 caOffset = centered * caAmount;

          // FPV Drone RF video link jitter
          if (uDroneMode > 0.5) {
            float lineJitter = (hash(vec2(floor(distUv.y * 220.0), floor(uTime * 30.0))) - 0.5) * 0.003;
            distUv.x += lineJitter;
          }

          float r = texture2D(tDiffuse, distUv + caOffset).r;
          float g = texture2D(tDiffuse, distUv).g;
          float b = texture2D(tDiffuse, distUv - caOffset).b;
          vec3 col = vec3(r, g, b);

          // Bodycam high-contrast S-curve & dynamic exposure
          col *= uExposure;
          col = col / (1.0 + col * 0.28);
          col = pow(max(col, vec3(0.0)), vec3(0.95));

          // Subtle crushed shadow & highlight sensor bloom simulation
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(luma), col, 0.88 - uStress * 0.28); // desaturate under heavy combat stress

          // Night Vision / IR Phosphor Mode [N]
          if (uNVG > 0.5) {
            float nvLuma = dot(col, vec3(0.3, 0.6, 0.1)) * 2.6;
            col = vec3(nvLuma * 0.18, nvLuma * 1.15, nvLuma * 0.32);
          }

          // FPV Drone analog scanlines
          if (uDroneMode > 0.5) {
            float scan = sin(distUv.y * uResolution.y * 1.2) * 0.06;
            col -= scan;
            col = mix(col, vec3(luma * 0.95, luma * 1.04, luma * 1.08), 0.35);
          } else {
            // Subtle bodycam CMOS rolling scanlines
            float scan = sin(distUv.y * uResolution.y * 0.7 + uTime * 8.0) * 0.015;
            col += scan;
          }

          // Sensor ISO Grain
          float noise = (hash(distUv * uResolution + fract(uTime * 60.0) * 100.0) - 0.5);
          float activeGrain = uGrain * (uNVG > 0.5 ? 2.4 : 1.0) + uStress * 0.04;
          col += noise * activeGrain;

          // Bodycam circular housing corner vignette + stress tunnel vision
          float vigRadius = mix(0.76, 0.56, uStress * 0.65);
          float vig = smoothstep(vigRadius, vigRadius - 0.38, distFromCenter);
          col *= mix(0.12, 1.0, vig);

          // Red trauma fringe when hit
          if (uDamage > 0.01) {
            float edge = smoothstep(0.22, 0.68, distFromCenter);
            col = mix(col, vec3(0.75, 0.04, 0.02), edge * min(1.0, uDamage * 0.95));
          }

          // M84 Flashbang blinding over-exposure whiteout
          if (uFlashbang > 0.01) {
            col = mix(col, vec3(1.0, 0.99, 0.96), min(1.0, uFlashbang));
          }

          gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.orthoScene.add(this.quad);
  }

  public setSize(width: number, height: number): void {
    this.rt.setSize(width, height);
    this.material.uniforms.uResolution.value.set(width, height);
  }

  public render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    timeSec: number,
    state: {
      stress: number;
      damage: number;
      flashbang: number;
      adsAmount: number;
      recoilChromaticSpike: number;
      droneMode: boolean;
      exposure: number;
    }
  ): void {
    this.material.uniforms.uTime.value = timeSec;
    this.material.uniforms.uDistortion.value = state.droneMode
      ? 0.44
      : this.fisheyeStrength;
    this.material.uniforms.uChromatic.value =
      this.chromaticBase + state.recoilChromaticSpike * 0.018;
    this.material.uniforms.uGrain.value = this.grainStrength;
    this.material.uniforms.uStress.value = state.stress;
    this.material.uniforms.uDamage.value = state.damage;
    this.material.uniforms.uFlashbang.value = state.flashbang;
    this.material.uniforms.uAdsAmount.value = state.adsAmount;
    this.material.uniforms.uNVG.value = this.nvgEnabled ? 1.0 : 0.0;
    this.material.uniforms.uDroneMode.value = state.droneMode ? 1.0 : 0.0;
    this.material.uniforms.uExposure.value = state.exposure;

    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.orthoScene, this.orthoCamera);
  }
}
