import {
  Camera,
  DefaultRenderingPipeline,
  Effect,
  ImageProcessingConfiguration,
  PostProcess,
  Scene,
  Vector2,
} from '@babylonjs/core';

export type SensorOpticMode = 'CMOS' | 'NVG' | 'THERMAL';

export class BodycamPostProcess {
  public defaultPipeline: DefaultRenderingPipeline;
  public lensPostProcess: PostProcess;

  public fisheyeStrength = 0.32;
  public chromaticBase = 0.0038;
  public grainStrength = 0.042;
  public sensorMode: SensorOpticMode = 'CMOS';

  private uTime = 0;
  private uState = {
    stress: 0,
    damage: 0,
    flashbang: 0,
    adsAmount: 0,
    recoilChromaticSpike: 0,
    droneMode: false,
    exposure: 1.12,
  };

  constructor(scene: Scene, camera: Camera) {
    // 1. Studio HDR Default Rendering Pipeline (ACES Filmic + HDR Bloom for Optics/Lasers/Muzzle Flash)
    this.defaultPipeline = new DefaultRenderingPipeline(
      'ReissadStudioPipeline',
      true,
      scene,
      [camera]
    );
    this.defaultPipeline.samples = 1; // Mobile GPU friendly
    this.defaultPipeline.fxaaEnabled = true;

    // HDR Bloom makes Red-Dot reticles, lasers, tritium sights, and muzzle flashes glow authentically!
    this.defaultPipeline.bloomEnabled = true;
    this.defaultPipeline.bloomThreshold = 0.72;
    this.defaultPipeline.bloomWeight = 0.48;
    this.defaultPipeline.bloomKernel = 48;
    this.defaultPipeline.bloomScale = 0.5;

    // ACES Filmic Tone Mapping for photorealistic dynamic range
    this.defaultPipeline.imageProcessingEnabled = true;
    this.defaultPipeline.imageProcessing.toneMappingEnabled = true;
    this.defaultPipeline.imageProcessing.toneMappingType =
      ImageProcessingConfiguration.TONEMAPPING_ACES;
    this.defaultPipeline.imageProcessing.contrast = 1.24;
    this.defaultPipeline.imageProcessing.exposure = 1.15;

    // 2. Register Custom Bodycam Fisheye + Chromatic + NVG/Thermal Lens Shader
    Effect.ShadersStore['bodycamLensFragmentShader'] = /* glsl */ `
      precision highp float;
      varying vec2 vUV;
      uniform sampler2D textureSampler;
      uniform float uTime;
      uniform vec2 uResolution;
      uniform float uDistortion;
      uniform float uChromatic;
      uniform float uGrain;
      uniform float uStress;
      uniform float uDamage;
      uniform float uFlashbang;
      uniform float uAdsAmount;
      uniform float uSensorMode; // 0 = CMOS, 1 = NVG, 2 = THERMAL
      uniform float uDroneMode;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      vec2 barrelDistort(vec2 uv, float k) {
        vec2 c = uv - 0.5;
        float r2 = dot(c, c);
        float f = 1.0 + k * r2 + (k * 0.65) * r2 * r2;
        float scale = 1.0 / (1.0 + k * 0.23);
        return c * f * scale + 0.5;
      }

      void main(void) {
        float activeDistort = mix(uDistortion, uDistortion * 0.35, uAdsAmount);
        vec2 distUv = barrelDistort(vUV, activeDistort);

        if (distUv.x < 0.0 || distUv.x > 1.0 || distUv.y < 0.0 || distUv.y > 1.0) {
          gl_FragColor = vec4(0.01, 0.012, 0.015, 1.0);
          return;
        }

        vec2 centered = distUv - 0.5;
        float distFromCenter = length(centered);

        // FPV Drone analog RF jitter
        if (uDroneMode > 0.5) {
          float jitter = (hash(vec2(floor(distUv.y * 200.0), floor(uTime * 35.0))) - 0.5) * 0.0032;
          distUv.x += jitter;
        }

        // Dynamic radial chromatic aberration
        float ca = (uChromatic + uStress * 0.0045 + uDamage * 0.0075) * (0.2 + distFromCenter * 2.1);
        vec2 caOffset = centered * ca;

        float r = texture2D(textureSampler, distUv + caOffset).r;
        float g = texture2D(textureSampler, distUv).g;
        float b = texture2D(textureSampler, distUv - caOffset).b;
        vec3 col = vec3(r, g, b);

        float luma = dot(col, vec3(0.299, 0.587, 0.114));

        // Desaturate slightly for realistic bodycam CMOS grading & under combat stress
        col = mix(vec3(luma), col, 0.86 - uStress * 0.28);

        // Sensor Mode 1: AN/PVS-31 Green Phosphor Night Vision
        if (uSensorMode > 0.5 && uSensorMode < 1.5) {
          float nv = pow(max(luma * 2.2, 0.0), 0.85);
          col = vec3(nv * 0.16, nv * 1.18, nv * 0.32);
        }
        // Sensor Mode 2: White-Hot FLIR Thermal Optics
        else if (uSensorMode > 1.5) {
          float th = smoothstep(0.05, 0.92, luma * 1.45);
          // Highlight warm/red tones (operators/muzzles) as glowing white-hot
          float heatBoost = max(0.0, (r - b) * 1.4);
          float finalTh = clamp(th + heatBoost, 0.0, 1.0);
          col = mix(vec3(0.05, 0.08, 0.14), vec3(0.96, 0.98, 1.0), finalTh);
        }

        // Subtle scanlines (stronger in Drone or Thermal mode)
        float scanAmp = (uDroneMode > 0.5 || uSensorMode > 0.5) ? 0.045 : 0.012;
        col -= sin(distUv.y * uResolution.y * 0.95 + uTime * 10.0) * scanAmp;

        // Sensor ISO Grain
        float noise = hash(distUv * uResolution + fract(uTime * 60.0) * 100.0) - 0.5;
        float activeGrain = uGrain * (uSensorMode > 0.5 ? 2.1 : 1.0) + uStress * 0.035;
        col += noise * activeGrain;

        // Bodycam optical housing vignette + Stress tunnel vision
        float vigRad = mix(0.77, 0.55, uStress * 0.6);
        float vig = smoothstep(vigRad, vigRad - 0.38, distFromCenter);
        col *= mix(0.1, 1.0, vig);

        // Red trauma fringe when hit
        if (uDamage > 0.01) {
          float edge = smoothstep(0.2, 0.66, distFromCenter);
          col = mix(col, vec3(0.78, 0.04, 0.02), edge * min(1.0, uDamage * 0.95));
        }

        // M84 Flashbang blinding over-exposure whiteout
        if (uFlashbang > 0.01) {
          col = mix(col, vec3(1.0, 0.99, 0.96), min(1.0, uFlashbang));
        }

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `;

    this.lensPostProcess = new PostProcess(
      'AxonBodycamLens',
      'bodycamLens',
      [
        'uTime',
        'uResolution',
        'uDistortion',
        'uChromatic',
        'uGrain',
        'uStress',
        'uDamage',
        'uFlashbang',
        'uAdsAmount',
        'uSensorMode',
        'uDroneMode',
      ],
      null,
      1.0,
      camera
    );

    this.lensPostProcess.onApply = (effect) => {
      const engine = scene.getEngine();
      effect.setFloat('uTime', this.uTime);
      effect.setVector2(
        'uResolution',
        new Vector2(engine.getRenderWidth(), engine.getRenderHeight())
      );
      effect.setFloat(
        'uDistortion',
        this.uState.droneMode ? 0.42 : this.fisheyeStrength
      );
      effect.setFloat(
        'uChromatic',
        this.chromaticBase + this.uState.recoilChromaticSpike * 0.016
      );
      effect.setFloat('uGrain', this.grainStrength);
      effect.setFloat('uStress', this.uState.stress);
      effect.setFloat('uDamage', this.uState.damage);
      effect.setFloat('uFlashbang', this.uState.flashbang);
      effect.setFloat('uAdsAmount', this.uState.adsAmount);
      effect.setFloat(
        'uSensorMode',
        this.sensorMode === 'CMOS' ? 0.0 : this.sensorMode === 'NVG' ? 1.0 : 2.0
      );
      effect.setFloat('uDroneMode', this.uState.droneMode ? 1.0 : 0.0);
    };
  }

  public attachToCamera(camera: Camera): void {
    this.defaultPipeline.addCamera(camera);
    camera.attachPostProcess(this.lensPostProcess);
  }

  public cycleSensorMode(): SensorOpticMode {
    if (this.sensorMode === 'CMOS') this.sensorMode = 'NVG';
    else if (this.sensorMode === 'NVG') this.sensorMode = 'THERMAL';
    else this.sensorMode = 'CMOS';
    return this.sensorMode;
  }

  public updateState(
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
    this.uTime = timeSec;
    this.uState = state;
    this.defaultPipeline.imageProcessing.exposure = state.exposure;
  }
}
