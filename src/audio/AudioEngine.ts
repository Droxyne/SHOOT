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

  public init(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    this.flashFilter = this.ctx.createBiquadFilter();
    this.flashFilter.type = 'lowpass';
    this.flashFilter.frequency.value = 20000;
    this.flashFilter.Q.value = 0.7;

    this.flashFilter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr * 2, sr);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    this.reverbNode = this.ctx.createConvolver();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.4;
    this.updateReverbImpulse('INDOOR');
    this.reverbNode.connect(this.reverbGain);
    this.reverbGain.connect(this.flashFilter);
  }

  public setEnvironment(env: 'INDOOR' | 'OUTDOOR'): void {
    if (this.ctx && this.reverbNode) {
      this.updateReverbImpulse(env);
    }
  }

  private updateReverbImpulse(env: 'INDOOR' | 'OUTDOOR'): void {
    if (!this.ctx || !this.reverbNode) return;
    const sr = this.ctx.sampleRate;
    const duration = env === 'INDOOR' ? 0.95 : 1.75;
    const length = Math.floor(sr * duration);
    const impulse = this.ctx.createBuffer(2, length, sr);

    for (let ch = 0; ch < 2; ch++) {
      const chData = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const t = i / sr;
        const earlyBoost = env === 'INDOOR' && t < 0.055 ? 1.65 : 1.0;
        const decay = env === 'INDOOR' ? Math.exp(-t * 5.6) : Math.exp(-t * 2.6);
        chData[i] = (Math.random() * 2 - 1) * decay * earlyBoost;
      }
    }
    this.reverbNode.buffer = impulse;
    if (this.reverbGain) {
      this.reverbGain.gain.value = env === 'INDOOR' ? 0.45 : 0.35;
    }
  }

  public setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  private ensureReady(): boolean {
    if (!this.ctx) this.init();
    if (!this.ctx || !this.flashFilter || !this.noiseBuffer) return false;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return !this.muted;
  }

  public playGunshot(caliber: string, suppressed: boolean, distance = 0, pan = 0): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;

    const now = this.ctx.currentTime;
    const distAtten = distance <= 0 ? 1.0 : Math.max(0.06, 1 / (1 + distance * 0.08));

    const outNode = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    const dest: AudioNode = outNode || this.flashFilter;
    if (outNode) {
      outNode.pan.value = Math.max(-1, Math.min(1, pan));
      outNode.connect(this.flashFilter);
      if (this.reverbNode) outNode.connect(this.reverbNode);
    }

    const isHeavy =
      caliber.includes('7.62') ||
      caliber.includes('.308') ||
      caliber.includes('357') ||
      caliber.includes('12 Gauge');
    const isShotgun = caliber.includes('12 Gauge');
    const isPistol = caliber.includes('9x19') || caliber.includes('.45');

    // 1. Sub-bass acoustic pressure wave
    const punchOsc = this.ctx.createOscillator();
    const punchGain = this.ctx.createGain();
    punchOsc.type = 'sine';
    const startFreq = suppressed ? 145 : isHeavy ? 120 : isPistol ? 180 : 150;
    punchOsc.frequency.setValueAtTime(startFreq, now);
    punchOsc.frequency.exponentialRampToValueAtTime(26, now + (isHeavy ? 0.15 : 0.095));

    const punchVol = (suppressed ? 0.3 : isHeavy ? 0.98 : 0.76) * distAtten;
    punchGain.gain.setValueAtTime(punchVol, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + (isHeavy ? 0.17 : 0.11));
    punchOsc.connect(punchGain);
    punchGain.connect(dest);
    punchOsc.start(now);
    punchOsc.stop(now + 0.18);

    // 2. High-energy propellant crack
    const blastSrc = this.ctx.createBufferSource();
    blastSrc.buffer = this.noiseBuffer;

    const blastFilter = this.ctx.createBiquadFilter();
    if (suppressed) {
      blastFilter.type = 'bandpass';
      blastFilter.frequency.setValueAtTime(1550, now);
      blastFilter.Q.value = 1.5;
    } else {
      blastFilter.type = 'lowpass';
      const cutoff = isShotgun ? 2800 : isHeavy ? 4200 : 5200;
      blastFilter.frequency.setValueAtTime(cutoff, now);
      blastFilter.frequency.exponentialRampToValueAtTime(300, now + (isHeavy ? 0.27 : 0.19));
    }

    const blastGain = this.ctx.createGain();
    const blastVol = (suppressed ? 0.28 : isHeavy ? 1.18 : 0.92) * distAtten;
    const blastDur = suppressed ? 0.08 : isShotgun ? 0.34 : isHeavy ? 0.27 : 0.2;
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

    // 3. Mechanical Bolt Carrier Group Reciprocation Clack
    if (distance < 6) {
      const mechOsc = this.ctx.createOscillator();
      const mechGain = this.ctx.createGain();
      mechOsc.type = 'triangle';
      mechOsc.frequency.setValueAtTime(2350, now + 0.012);
      mechOsc.frequency.exponentialRampToValueAtTime(720, now + 0.052);
      mechGain.gain.setValueAtTime(0.25 * distAtten, now + 0.012);
      mechGain.gain.exponentialRampToValueAtTime(0.001, now + 0.058);
      mechOsc.connect(mechGain);
      mechGain.connect(dest);
      mechOsc.start(now + 0.012);
      mechOsc.stop(now + 0.062);
    }

    // 4. Shell Casing Floor Clatter
    if (distance === 0 && !caliber.includes('Revolver')) {
      this.playShellBounce(now + 0.32 + Math.random() * 0.12, isShotgun);
    }
  }

  private playShellBounce(startTime: number, isShotgunHull: boolean): void {
    if (!this.ctx || !this.flashFilter) return;
    const bounces = isShotgunHull ? 2 : 3;
    for (let i = 0; i < bounces; i++) {
      const t = startTime + i * (0.075 + Math.random() * 0.045);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = isShotgunHull ? 'triangle' : 'sine';
      const baseFreq = isShotgunHull ? 540 : 3800 + Math.random() * 950;
      osc.frequency.setValueAtTime(baseFreq, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.76, t + 0.035);
      const amp = (isShotgunHull ? 0.065 : 0.085) * Math.pow(0.55, i);
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
    this.triggerMetallicClick(now, 1750, 440, 0.028, 0.22);
  }

  public playReloadStep(
    step: 'magOut' | 'magFumble' | 'magIn' | 'boltSlap' | 'pump' | 'magCheck'
  ): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;

    if (step === 'magOut' || step === 'magCheck') {
      this.triggerMetallicClick(now, 1320, 610, 0.055, 0.24);
      this.triggerFrictionNoise(now + 0.025, 1850, 0.1, 0.16);
    } else if (step === 'magFumble') {
      this.triggerMetallicClick(now, 910, 420, 0.05, 0.3);
      this.triggerMetallicClick(now + 0.085, 1080, 540, 0.055, 0.26);
      this.triggerFrictionNoise(now + 0.035, 1250, 0.17, 0.22);
    } else if (step === 'magIn') {
      this.triggerFrictionNoise(now, 1450, 0.075, 0.18);
      this.triggerMetallicClick(now + 0.055, 760, 1520, 0.065, 0.36);
    } else if (step === 'boltSlap' || step === 'pump') {
      this.triggerMetallicClick(now, 1680, 940, 0.048, 0.32);
      this.triggerFrictionNoise(now + 0.018, 2500, 0.068, 0.24);
      this.triggerMetallicClick(now + 0.1, 2240, 1150, 0.058, 0.38);
    }
  }

  /**
   * Tactical Walkie-Talkie Radio Squelch + Beep for Squad / Range Announcements
   */
  public playRadioCommsBeep(): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;
    this.triggerFrictionNoise(now, 2800, 0.045, 0.12);
    this.triggerMetallicClick(now + 0.03, 2150, 2150, 0.04, 0.14);
    this.triggerFrictionNoise(now + 0.08, 2600, 0.035, 0.1);
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

  public playBulletCrack(pan = 0): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(3600, now);
    filter.frequency.exponentialRampToValueAtTime(920, now + 0.08);
    filter.Q.value = 2.6;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

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
    src.stop(now + 0.095);
  }

  public playHitSound(type: 'STEEL_HEAD' | 'STEEL_BODY' | 'FLESH' | 'HEADSHOT_HELMET'): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter) return;
    const now = this.ctx.currentTime;

    if (type === 'STEEL_HEAD' || type === 'STEEL_BODY') {
      const base = type === 'STEEL_HEAD' ? 1560 : 980;
      [base, base * 1.51, base * 2.18].forEach((freq, idx) => {
        if (!this.ctx || !this.flashFilter) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        const dur = type === 'STEEL_HEAD' ? 0.44 : 0.28;
        gain.gain.setValueAtTime(0.2 / (idx + 1), now);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + dur);
        osc.connect(gain);
        gain.connect(this.flashFilter);
        osc.start(now);
        osc.stop(now + dur + 0.02);
      });
    } else if (type === 'HEADSHOT_HELMET') {
      this.triggerMetallicClick(now, 2050, 720, 0.09, 0.45);
      this.triggerFrictionNoise(now, 950, 0.08, 0.36);
    } else {
      this.triggerMetallicClick(now, 250, 68, 0.075, 0.4);
      this.triggerFrictionNoise(now, 680, 0.055, 0.26);
    }
  }

  public playExplosion(isFlashbang: boolean, distance: number): void {
    if (!this.ensureReady() || !this.ctx || !this.flashFilter || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const atten = Math.max(0.12, 1 / (1 + distance * 0.06));

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(isFlashbang ? 4400 : 1900, now);
    filter.frequency.exponentialRampToValueAtTime(110, now + (isFlashbang ? 0.55 : 1.35));

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(1.25 * atten, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (isFlashbang ? 0.6 : 1.4));

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.flashFilter);
    if (this.reverbNode) gain.connect(this.reverbNode);
    src.start(now);
    src.stop(now + 1.45);

    const subOsc = this.ctx.createOscillator();
    const subGain = this.ctx.createGain();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(98, now);
    subOsc.frequency.exponentialRampToValueAtTime(22, now + 0.55);
    subGain.gain.setValueAtTime(0.98 * atten, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    subOsc.connect(subGain);
    subGain.connect(this.flashFilter);
    subOsc.start(now);
    subOsc.stop(now + 0.62);

    if ((isFlashbang && distance < 16) || (!isFlashbang && distance < 8)) {
      const stunDuration = isFlashbang ? 4.2 : 2.2;
      this.flashFilter.frequency.cancelScheduledValues(now);
      this.flashFilter.frequency.setValueAtTime(340, now);
      this.flashFilter.frequency.exponentialRampToValueAtTime(20000, now + stunDuration);

      if (this.masterGain) {
        const ringOsc = this.ctx.createOscillator();
        const ringGain = this.ctx.createGain();
        ringOsc.type = 'sine';
        ringOsc.frequency.setValueAtTime(3940, now);
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
    const vol = sprinting ? 0.21 : 0.11;

    if (surface === 'MUD') {
      this.triggerFrictionNoise(now, 490, 0.09, vol);
      this.triggerMetallicClick(now, 125, 55, 0.06, vol * 0.8);
    } else if (surface === 'WOOD') {
      this.triggerMetallicClick(now, 215, 85, 0.065, vol * 1.1);
      this.triggerFrictionNoise(now, 960, 0.05, vol * 0.6);
    } else {
      this.triggerMetallicClick(now, 170, 72, 0.055, vol);
      this.triggerFrictionNoise(now, 1500, 0.045, vol * 0.7);
    }
  }

  public updateStressAudio(stress: number, timeSec: number): void {
    if (stress < 0.35 || !this.ensureReady() || !this.ctx || !this.flashFilter) return;

    const interval = 0.85 - stress * 0.47;
    if (timeSec - this.lastHeartbeatTime >= interval) {
      this.lastHeartbeatTime = timeSec;
      const now = this.ctx.currentTime;
      const intensity = Math.min(1, (stress - 0.3) * 1.4) * 0.28;

      this.triggerMetallicClick(now, 72, 36, 0.07, intensity);
      this.triggerMetallicClick(now + 0.14, 64, 32, 0.06, intensity * 0.75);

      if (stress > 0.55 && Math.random() < 0.5) {
        this.triggerFrictionNoise(now + 0.18, 720, 0.24, intensity * 0.35);
      }
    }
  }

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
