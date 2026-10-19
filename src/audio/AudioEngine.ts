export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private flashFilter: BiquadFilterNode | null = null;
  private reverbNode: ConvolverNode | null = null;
  private reverbGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private droneOsc1: OscillatorNode | null = null;
  private droneOsc2: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;

  private lastHeartbeatTime = 0;
  private muted = false;
  private volume = 0.85;
  private environmentType: 'INDOOR' | 'OUTDOOR' = 'INDOOR';

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    // Flashbang low-pass filter (normally wide open at 20,000 Hz; drops to 400 Hz when stunned)
    this.flashFilter = this.ctx.createBiquadFilter();
    this.flashFilter.type = 'lowpass';
    this.flashFilter.frequency.value = 20000;
    this.flashFilter.Q.value = 0.7;

    this.flashFilter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    // Pre-generate 2 seconds of white/pink noise buffer
    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr * 2, sr);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Build acoustic pressure-wave convolution reverb
    this.reverbNode = this.ctx.createConvolver();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.38;
    this.updateReverbImpulse('INDOOR');
    this.reverbNode.connect(this.reverbGain);
    this.reverbGain.connect(this.flashFilter);
  }

  public setEnvironment(env: 'INDOOR' | 'OUTDOOR'): void {
    this.environmentType = env;
    if (this.ctx && this.reverbNode) {
      this.updateReverbImpulse(env);
    }
  }

  private updateReverbImpulse(env: 'INDOOR' | 'OUTDOOR'): void {
    if (!this.ctx || !this.reverbNode) return;
    const sr = this.ctx.sampleRate;
    const duration = env === 'INDOOR' ? 0.95 : 1.85;
    const length = Math.floor(sr * duration);
    const impulse = this.ctx.createBuffer(2, length, sr);

    for (let ch = 0; ch < 2; ch++) {
      const chData = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        // Early slap-back reflections for indoor rooms vs long rolling tail for outdoor trenches
        const earlyBoost = env === 'INDOOR' && t < 0.06 ? 1.5 : 1.0;
        const decay = env === 'INDOOR' ? Math.exp(-t * 5.8) : Math.exp(-t * 2.7);
        chData[i] = (Math.random() * 2 - 1) * decay * earlyBoost;
      }
    }
    this.reverbNode.buffer = impulse;
    if (this.reverbGain) {
      this.reverbGain.gain.value = env === 'INDOOR' ? 0.44 : 0.34;
    }
  }

  public setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  public toggleMute(): boolean {
    this.muted = !this.muted;
    this.setVolume(this.volume);
    return this.muted;
  }

  private ensureReady(): boolean {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.flashFilter || !this.noiseBuffer) return false;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return !this.muted;
  }

  /**
   * Synthesizes hyper-realistic Bodycam v0.8 gunshots with:
   * 1. Sub-bass chest pressure wave
   * 2. Supersonic crack / propellant blast
   * 3. Mechanical bolt carrier clack
   * 4. Room/trench convolution reverb tail
   * 5. Ejected brass casing bounce
   */
  public playGunshot(
    caliber: string,
    suppressed: boolean,
    distance = 0, // 0 = local player weapon, >0 = bot weapon in meters
    pan = 0 // -1 left to +1 right
  ): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;

    const now = this.ctx.currentTime;
    const distAtten = distance <= 0 ? 1.0 : Math.max(0.06, 1 / (1 + distance * 0.085));

    const outNode = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const dest: AudioNode = outNode || this.flashFilter;
    if (outNode) {
      outNode.pan.value = Math.max(-1, Math.min(1, pan));
      outNode.connect(this.flashFilter);
      if (this.reverbNode) {
        outNode.connect(this.reverbNode);
      }
    }

    const isHeavy =
      caliber.includes('7.62') ||
      caliber.includes('.308') ||
      caliber.includes('357') ||
      caliber.includes('12 Gauge');
    const isShotgun = caliber.includes('12 Gauge');
    const isPistol = caliber.includes('9x19') || caliber.includes('.45');

    // 1. Acoustic Pressure Wave (Sub-bass chest punch)
    const punchOsc = this.ctx.createOscillator();
    const punchGain = this.ctx.createGain();
    punchOsc.type = 'sine';
    const startFreq = suppressed ? 140 : isHeavy ? 115 : isPistol ? 175 : 145;
    punchOsc.frequency.setValueAtTime(startFreq, now);
    punchOsc.frequency.exponentialRampToValueAtTime(28, now + (isHeavy ? 0.14 : 0.09));

    const punchVol = (suppressed ? 0.28 : isHeavy ? 0.95 : 0.72) * distAtten;
    punchGain.gain.setValueAtTime(punchVol, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + (isHeavy ? 0.16 : 0.1));
    punchOsc.connect(punchGain);
    punchGain.connect(dest);
    punchOsc.start(now);
    punchOsc.stop(now + 0.17);

    // 2. Muzzle Blast / Supersonic Crack (Filtered Noise Burst)
    const blastSrc = this.ctx.createBufferSource();
    blastSrc.buffer = this.noiseBuffer;

    const blastFilter = this.ctx.createBiquadFilter();
    if (suppressed) {
      blastFilter.type = 'bandpass';
      blastFilter.frequency.setValueAtTime(1450, now);
      blastFilter.Q.value = 1.6;
    } else {
      blastFilter.type = 'lowpass';
      const cutoff = isShotgun ? 2600 : isHeavy ? 3800 : 4800;
      blastFilter.frequency.setValueAtTime(cutoff, now);
      blastFilter.frequency.exponentialRampToValueAtTime(320, now + (isHeavy ? 0.26 : 0.18));
    }

    const blastGain = this.ctx.createGain();
    const blastVol = (suppressed ? 0.25 : isHeavy ? 1.15 : 0.88) * distAtten;
    const blastDur = suppressed ? 0.075 : isShotgun ? 0.32 : isHeavy ? 0.26 : 0.19;
    blastGain.gain.setValueAtTime(blastVol, now);
    blastGain.gain.exponentialRampToValueAtTime(0.001, now + blastDur);

    blastSrc.connect(blastFilter);
    blastFilter.connect(blastGain);
    blastGain.connect(dest);
    if (!outNode && this.reverbNode && !suppressed) {
      blastGain.connect(this.reverbNode);
    }
    blastSrc.start(now, Math.random() * 0.5);
    blastSrc.stop(now + blastDur + 0.02);

    // 3. Mechanical Bolt Carrier Clack (local player hears metallic action clearly)
    if (distance < 6) {
      const mechOsc = this.ctx.createOscillator();
      const mechGain = this.ctx.createGain();
      mechOsc.type = 'triangle';
      mechOsc.frequency.setValueAtTime(2100, now + 0.015);
      mechOsc.frequency.exponentialRampToValueAtTime(680, now + 0.055);
      mechGain.gain.setValueAtTime(0.22 * distAtten, now + 0.015);
      mechGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      mechOsc.connect(mechGain);
      mechGain.connect(dest);
      mechOsc.start(now + 0.015);
      mechOsc.stop(now + 0.065);
    }

    // 4. Shell Casing Ejection Clink on Floor (for local shots)
    if (distance === 0 && !caliber.includes('Revolver')) {
      const delay = 0.34 + Math.random() * 0.14;
      this.playShellBounce(now + delay, isShotgun);
    }
  }

  private playShellBounce(startTime: number, isShotgunHull: boolean): void {
    if (!this.ctx || !this.flashFilter) return;
    const bounces = isShotgunHull ? 2 : 3;
    for (let i = 0; i < bounces; i++) {
      const t = startTime + i * (0.08 + Math.random() * 0.05);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = isShotgunHull ? 'triangle' : 'sine';
      const baseFreq = isShotgunHull ? 520 : 3600 + Math.random() * 900;
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.75, t + 0.035);
      const amp = (isShotgunHull ? 0.06 : 0.08) * Math.pow(0.55, i);
      gain.gain.setValueAtTime(amp, t);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.04);
      osc.connect(gain);
      gain.connect(this.flashFilter);
      osc.start(t);
      osc.stop(t + 0.045);
    }
  }

  public playDryFire(): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1650, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.025);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(gain);
    gain.connect(this.flashFilter);
    osc.start(now);
    osc.stop(now + 0.035);
  }

  /**
   * Plays mechanical reload stages, including stressed fumbles in v0.8!
   */
  public playReloadStep(step: 'magOut' | 'magFumble' | 'magIn' | 'boltSlap' | 'pump' | 'magCheck'): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    if (step === 'magOut' || step === 'magCheck') {
      this.triggerMetallicClick(now, 1250, 580, 0.06, 0.22);
      this.triggerFrictionNoise(now + 0.03, 1800, 0.11, 0.14);
    } else if (step === 'magFumble') {
      // Stressed fumble rattle!
      this.triggerMetallicClick(now, 880, 410, 0.05, 0.28);
      this.triggerMetallicClick(now + 0.09, 1020, 520, 0.06, 0.25);
      this.triggerFrictionNoise(now + 0.04, 1200, 0.18, 0.2);
    } else if (step === 'magIn') {
      this.triggerFrictionNoise(now, 1400, 0.08, 0.16);
      this.triggerMetallicClick(now + 0.06, 720, 1480, 0.07, 0.34);
    } else if (step === 'boltSlap' || step === 'pump') {
      this.triggerMetallicClick(now, 1600, 920, 0.05, 0.3);
      this.triggerFrictionNoise(now + 0.02, 2400, 0.07, 0.22);
      this.triggerMetallicClick(now + 0.11, 2150, 1100, 0.06, 0.36);
    }
  }

  private triggerMetallicClick(
    startTime: number,
    freqStart: number,
    freqEnd: number,
    dur: number,
    vol: number
  ): void {
    if (!this.ctx || !this.flashFilter) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freqStart, startTime);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, startTime + dur);
    gain.gain.setValueAtTime(vol, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    osc.connect(gain);
    gain.connect(this.flashFilter);
    osc.start(startTime);
    osc.stop(startTime + dur + 0.01);
  }

  private triggerFrictionNoise(
    startTime: number,
    centerFreq: number,
    dur: number,
    vol: number
  ): void {
    if (!this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = centerFreq;
    filter.Q.value = 2.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.flashFilter);
    src.start(startTime, Math.random() * 0.5);
    src.stop(startTime + dur + 0.01);
  }

  /**
   * Supersonic bullet crack / whiz when enemy rounds pass near the player's bodycam
   */
  public playBulletCrack(pan = 0): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3400, now);
    filter.frequency.exponentialRampToValueAtTime(900, now + 0.085);
    filter.Q.value = 2.5;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    src.connect(filter);
    filter.connect(gain);

    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      panner.connect(this.flashFilter);
    } else {
      gain.connect(this.flashFilter);
    }

    src.start(now, Math.random() * 0.4);
    src.stop(now + 0.1);
  }

  /**
   * Target & Operator Hit Feedback
   */
  public playHitSound(type: 'STEEL_HEAD' | 'STEEL_BODY' | 'FLESH' | 'HEADSHOT_HELMET'): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;

    if (type === 'STEEL_HEAD' || type === 'STEEL_BODY') {
      const base = type === 'STEEL_HEAD' ? 1480 : 940;
      [base, base * 1.49, base * 2.12].forEach((freq, idx) => {
        if (!this.ctx || !this.flashFilter) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        const dur = type === 'STEEL_HEAD' ? 0.42 : 0.28;
        gain.gain.setValueAtTime(0.18 / (idx + 1), now);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + dur);
        osc.connect(gain);
        gain.connect(this.flashFilter);
        osc.start(now);
        osc.stop(now + dur + 0.02);
      });
    } else if (type === 'HEADSHOT_HELMET') {
      this.triggerMetallicClick(now, 1950, 680, 0.09, 0.42);
      this.triggerFrictionNoise(now, 900, 0.08, 0.35);
    } else {
      // Kevlar / Flesh impact thud
      this.triggerMetallicClick(now, 240, 65, 0.08, 0.38);
      this.triggerFrictionNoise(now, 650, 0.06, 0.25);
    }
  }

  /**
   * M67 Frag Explosion or M84 Flashbang Detonation + Tinnitus Ear Ring
   */
  public playExplosion(isFlashbang: boolean, distance: number): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const atten = Math.max(0.12, 1 / (1 + distance * 0.06));

    // Massive shockwave blast
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isFlashbang ? 4200 : 1800, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + (isFlashbang ? 0.55 : 1.35));

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.2 * atten, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isFlashbang ? 0.6 : 1.4));

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.flashFilter);
    if (this.reverbNode) gain.connect(this.reverbNode);
    src.start(now);
    src.stop(now + 1.45);

    // Sub-bass concussion
    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(95, now);
    subOsc.frequency.exponentialRampToValueAtTime(22, now + 0.55);
    subGain.gain.setValueAtTime(0.95 * atten, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    subOsc.connect(subGain);
    subGain.connect(this.flashFilter);
    subOsc.start(now);
    subOsc.stop(now + 0.62);

    // If Flashbang or close explosion: trigger Tinnitus high-pitched ear ring & muffle game audio!
    if ((isFlashbang && distance < 16) || (!isFlashbang && distance < 8)) {
      const stunDuration = isFlashbang ? 4.2 : 2.2;
      this.flashFilter.frequency.cancelScheduledValues(now);
      this.flashFilter.frequency.setValueAtTime(340, now);
      this.flashFilter.frequency.exponentialRampToValueAtTime(20000, now + stunDuration);

      // High-pitched 3950 Hz tinnitus sine wave bypassing the lowpass filter
      if (this.masterGain) {
        const ringOsc = this.ctx.createOscillator();
        const ringGain = this.ctx.createGain();
        ringOsc.type = 'sine';
        ringOsc.frequency.setValueAtTime(3920, now);
        ringGain.gain.setValueAtTime(0.14 * atten, now);
        ringGain.gain.exponentialRampToValueAtTime(0.0005, now + stunDuration);
        ringOsc.connect(ringGain);
        ringGain.connect(this.masterGain);
        ringOsc.start(now);
        ringOsc.stop(now + stunDuration + 0.05);
      }
    }
  }

  public playFootstep(surface: 'CONCRETE' | 'WOOD' | 'MUD', sprinting: boolean): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;
    const vol = sprinting ? 0.22 : 0.11;

    if (surface === 'MUD') {
      this.triggerFrictionNoise(now, 480, 0.09, vol);
      this.triggerMetallicClick(now, 120, 55, 0.06, vol * 0.8);
    } else if (surface === 'WOOD') {
      this.triggerMetallicClick(now, 210, 85, 0.065, vol * 1.1);
      this.triggerFrictionNoise(now, 950, 0.05, vol * 0.6);
    } else {
      this.triggerMetallicClick(now, 165, 70, 0.055, vol);
      this.triggerFrictionNoise(now, 1450, 0.045, vol * 0.7);
    }
  }

  /**
   * Dynamic Operator Stress Heartbeat & Breathing (Bodycam v0.8 Stress Engine)
   */
  public updateStressAudio(stress: number, timeSec: number): void {
    if (stress < 0.35 || !this.ensureReady() || !this.ctx || !this.flashFilter) return;

    // Heartbeat interval shrinks from 0.85s at 35% stress down to 0.38s (158 BPM) at 100% stress
    const interval = 0.85 - stress * 0.47;
    if (timeSec - this.lastHeartbeatTime >= interval) {
      this.lastHeartbeatTime = timeSec;
      const now = this.ctx.currentTime;
      const intensity = Math.min(1, (stress - 0.3) * 1.4) * 0.28;

      // Lub-dub double thump
      this.triggerMetallicClick(now, 72, 36, 0.07, intensity);
      this.triggerMetallicClick(now + 0.14, 64, 32, 0.06, intensity * 0.75);

      // Subtle stressed breath exhale every 2nd beat
      if (stress > 0.55 && Math.random() < 0.5) {
        this.triggerFrictionNoise(now + 0.18, 720, 0.24, intensity * 0.35);
      }
    }
  }

  /**
   * FPV Drone / RC Car continuous motor synthesizer
   */
  public setDroneMotorState(active: boolean, throttle = 0.5, isRCCar = false): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;

    if (!active) {
      if (this.droneGain) {
        this.droneGain.gain.setTargetAtTime(0, now, 0.05);
      }
      return;
    }

    if (!this.droneOsc1 || !this.droneOsc2 || !this.droneGain) {
      this.droneOsc1 = this.ctx.createOscillator();
      this.droneOsc2 = this.ctx.createOscillator();
      this.droneGain = this.ctx.createGain();
      this.droneOsc1.type = 'sawtooth';
      this.droneOsc2.type = 'triangle';
      this.droneGain.gain.value = 0;

      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 780;
      filter.Q.value = 1.8;

      this.droneOsc1.connect(filter);
      this.droneOsc2.connect(filter);
      filter.connect(this.droneGain);
      this.droneGain.connect(this.flashFilter);
      this.droneOsc1.start();
      this.droneOsc2.start();
    }

    const baseFreq = isRCCar ? 180 + throttle * 260 : 380 + throttle * 540;
    this.droneOsc1.frequency.setTargetAtTime(baseFreq, now, 0.04);
    this.droneOsc2.frequency.setTargetAtTime(baseFreq * 1.03, now, 0.04);
    this.droneGain.gain.setTargetAtTime(0.08 + throttle * 0.07, now, 0.05);
  }

  public playUIClick(pitch = 1100): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    this.triggerMetallicClick(this.ctx.currentTime, pitch, pitch * 0.7, 0.025, 0.12);
  }
}
