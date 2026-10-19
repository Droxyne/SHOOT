import {
  Color3,
  Engine,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Ray,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector2,
  Vector3,
} from '@babylonjs/core';
import {
  AttachmentDef,
  AttachmentSlot,
  BODYCAM_ATTACHMENTS,
  BODYCAM_MAPS,
  BODYCAM_MODES,
  BODYCAM_WEAPONS,
  GameModeId,
  MapId,
  WeaponDef,
} from './data/bodycamData';
import { AudioEngine } from './audio/AudioEngine';
import { BodycamPostProcess } from './shaders/BodycamPostProcess';
import { BuiltWeaponRig, WeaponModelBuilder } from './weapons/WeaponModelBuilder';
import { BuiltMap, MapBuilder } from './world/MapBuilder';
import { BotBehaviorMode, BotTeam, TacticalBot } from './entities/BotAI';
import { ActiveGrenade, DroneFlightMode, GadgetSystem, GadgetType } from './gadgets/GadgetSystem';
import { SpringVector3 } from './engine/SpringPhysics';

interface EjectedBrass {
  mesh: Mesh;
  vel: Vector3;
  rotVel: Vector3;
  life: number;
}

interface ImpactParticle {
  mesh: Mesh;
  vel: Vector3;
  life: number;
}

interface WeaponRuntimeState {
  def: WeaponDef;
  magAmmo: number;
  chambered: number;
  spareMags: number;
  fireModeIndex: number;
  attachments: Record<AttachmentSlot, AttachmentDef>;
}

class BodycamBabylonEngine {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private camera: UniversalCamera;
  private postProcess: BodycamPostProcess;
  private audio: AudioEngine;
  private gadgets: GadgetSystem;

  private currentMapId: MapId = 'SHOOTING_RANGE';
  private currentModeId: GameModeId = 'TRAINING';
  private builtMap!: BuiltMap;

  // Native Babylon.js Sliding Ellipsoid Player Collider
  private playerCollider: Mesh;
  private playerPos = new Vector3(-2.5, 0, -3.2);
  private playerVel = Vector3.Zero();
  private playerYaw = 0;
  private playerPitch = 0;
  private playerHealth = 100;
  private operatorStress = 0.06;
  private damageFlash = 0;
  private flashbangBlind = 0;
  private isCrouching = false;
  private isCanted = false; // 38° Canted Laser Point-Shooting Stance [X]
  private currentEyeHeight = 1.62;
  private leanTarget = 0;
  private leanCurrent = 0;
  private walkBobTimer = 0;
  private lastFootstepCycle = 0;
  private wallBlockAmount = 0; // Physical barrel wall avoidance

  // 2nd-Order Harmonic Spring-Damper Solvers for Studio Weapon & Camera Feel
  private wepPosSpring = new SpringVector3(190, 20);
  private wepRotSpring = new SpringVector3(175, 18);
  private camRecoilSpring = new SpringVector3(140, 16);

  // Bodycam Unlinked Free-Aim Deadzone
  private freeAimX = 0;
  private freeAimY = 0;
  private recoilChromaticSpike = 0;
  private boltSlideOffset = 0;
  private pumpCycleTimer = 0;

  // Loadout & Weapon State
  private reissadPoints = 12500;
  private activeSlot: 'PRIMARY' | 'SECONDARY' = 'PRIMARY';
  private primaryState!: WeaponRuntimeState;
  private secondaryState!: WeaponRuntimeState;
  private weaponRig!: BuiltWeaponRig;
  private weaponPivot: TransformNode;

  // Firing, ADS, Reload & Mag Check
  private isFiring = false;
  private semiShotLatched = false;
  private fireTimer = 0;
  private isADS = false;
  private adsAmount = 0;
  private cantedAmount = 0;
  private sprintPoseAmount = 0;
  private flashlightOn = true;
  private isReloading = false;
  private reloadTimer = 0;
  private reloadDuration = 2.2;
  private reloadIsStressed = false;
  private reloadStepFlags = { out: false, fumble: false, in: false, bolt: false };
  private magCheckTimer = 0;
  private switchAnimTimer = 0;

  // Throwables & Gadgets
  private selectedGrenade: 'FRAG' | 'FLASH' = 'FRAG';
  private grenadesRemaining = 3;
  private selectedGadget: GadgetType = 'FPV_DRONE';
  private droneFlightMode: DroneFlightMode = 'CASUAL';
  private activeGrenades: ActiveGrenade[] = [];
  private operatorBodyStandin: TransformNode;

  // Bots & Gun Game
  private bots: TacticalBot[] = [];
  private botBehaviorMode: BotBehaviorMode = 'PATROL_COMBAT';
  private gunGameIndex = 0;

  // Telemetry & 30s Reflex Drill
  private shotsFired = 0;
  private shotsHit = 0;
  private headshotsCount = 0;
  private totalKills = 0;
  private drillActive = false;
  private drillTimeLeft = 0;
  private drillScore = 0;
  private lastTargetPopUpTime = 0;

  // Visual Pools
  private ejectedBrass: EjectedBrass[] = [];
  private impactParticles: ImpactParticle[] = [];
  private bulletDecals: Mesh[] = [];

  // Input & Mobile Velocity-Smoothed Touch State
  private keys: Record<string, boolean> = {};
  private lookSensitivity = 1.0;
  private aimAssistEnabled = true;
  private pureDiegeticHud = false;
  private gyroEnabled = false;
  private touchMoveVec = new Vector2(0, 0);
  private touchSprinting = false;
  private rawLookAccum = new Vector2(0, 0);
  private smoothedLookDelta = new Vector2(0, 0);
  private moveTouchId: number | null = null;
  private moveTouchOrigin = new Vector2(84, window.innerHeight - 86);
  private lookTouchId: number | null = null;
  private lookTouchLast = new Vector2(0, 0);
  private fireTouchId: number | null = null;
  private fireTouchLast = new Vector2(0, 0);

  private startTimeSec = performance.now() * 0.001;
  private fpsAvg = 60;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.engine = new Engine(this.canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      powerPreference: 'high-performance',
    });

    // Mobile GPU Hardware Scaling Optimization
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.engine.setHardwareScalingLevel(1 / dpr);

    this.scene = new Scene(this.engine);
    this.scene.collisionsEnabled = true;

    this.camera = new UniversalCamera('bodycamEye', new Vector3(-2.5, 1.62, -3.2), this.scene);
    this.camera.fov = 1.38; // ~79 deg vertical (~106 deg horizontal wide-angle chest lens)
    this.camera.minZ = 0.03;
    this.camera.maxZ = 180;
    this.camera.inputs.clear(); // Custom Free-Aim Deadzone + Mobile Touch Look controller

    // Invisible Ellipsoid Collision Proxy for Quake-style smooth sliding wall collisions
    this.playerCollider = MeshBuilder.CreateBox('playerCollider', { size: 0.5 }, this.scene);
    this.playerCollider.isVisible = false;
    this.playerCollider.isPickable = false;
    this.playerCollider.checkCollisions = true;
    this.playerCollider.ellipsoid = new Vector3(0.38, 0.85, 0.38);
    this.playerCollider.ellipsoidOffset = new Vector3(0, 0.85, 0);

    this.weaponPivot = new TransformNode('weaponPivot', this.scene);
    this.weaponPivot.parent = this.camera;

    this.postProcess = new BodycamPostProcess(this.scene, this.camera);
    this.audio = new AudioEngine();
    this.gadgets = new GadgetSystem(this.scene);

    // 3D Operator Stand-in when piloting FPV Drone / RC Car
    this.operatorBodyStandin = new TransformNode('operatorStandin', this.scene);
    const opMat = new PBRMaterial('opStandinMat', this.scene);
    opMat.albedoColor = new Color3(0.18, 0.23, 0.19);
    opMat.roughness = 0.8;
    const opTorso = MeshBuilder.CreateBox(
      'opStandinTorso',
      { width: 0.45, height: 1.45, depth: 0.28 },
      this.scene
    );
    opTorso.position.y = 0.75;
    opTorso.material = opMat;
    opTorso.parent = this.operatorBodyStandin;
    opTorso.isPickable = false;
    this.operatorBodyStandin.setEnabled(false);

    this.initDefaultLoadout();
    this.loadMap('SHOOTING_RANGE');
    this.equipWeaponSlot('PRIMARY');
    this.spawnBotsForCurrentMode(4);

    this.bindInputs();
    this.bindUI();
    this.populateTabletUI();

    window.addEventListener('resize', () => this.engine.resize());

    this.engine.runRenderLoop(() => {
      const dt = Math.min(0.05, this.engine.getDeltaTime() * 0.001);
      const elapsed = performance.now() * 0.001 - this.startTimeSec;
      this.updateFrame(dt, elapsed);
      this.scene.render();
    });
  }

  private getDefaultAttachments(isPistol: boolean): Record<AttachmentSlot, AttachmentDef> {
    const find = (id: string) =>
      BODYCAM_ATTACHMENTS.find((a) => a.id === id) || BODYCAM_ATTACHMENTS[0];
    return {
      optic: find(isPistol ? 'optic_iron' : 'optic_reddot'),
      muzzle: find('muzzle_std'),
      grip: find(isPistol ? 'grip_none' : 'grip_angled'),
      tactical: find('tac_combo'),
      magazine: find('mag_std'),
    };
  }

  private initDefaultLoadout(): void {
    const m4 = BODYCAM_WEAPONS.find((w) => w.id === 'm4') || BODYCAM_WEAPONS[0];
    const mlock = BODYCAM_WEAPONS.find((w) => w.id === 'mlock19') || BODYCAM_WEAPONS[13];

    this.primaryState = {
      def: m4,
      magAmmo: m4.magCapacity,
      chambered: 1,
      spareMags: m4.spareMags,
      fireModeIndex: 0,
      attachments: this.getDefaultAttachments(false),
    };

    this.secondaryState = {
      def: mlock,
      magAmmo: mlock.magCapacity,
      chambered: 1,
      spareMags: mlock.spareMags,
      fireModeIndex: 0,
      attachments: this.getDefaultAttachments(true),
    };
  }

  private getActiveWeaponState(): WeaponRuntimeState {
    return this.activeSlot === 'PRIMARY' ? this.primaryState : this.secondaryState;
  }

  private getComputedWeaponStats(st: WeaponRuntimeState) {
    const d = st.def;
    let adsSpeed = d.adsSpeed;
    let switchSpeed = d.switchSpeed;
    let reloadCalm = d.reloadTimeCalm;
    let reloadStressed = d.reloadTimeStressed;
    let hRecoil = d.hRecoil;
    let vRecoil = d.vRecoil;
    let spread = d.hipSpread;
    let kick = d.firstShotKick;
    let magCap = d.magCapacity;
    let suppressed = false;
    let opticZoom = 1.15;

    for (const slot of Object.keys(st.attachments) as AttachmentSlot[]) {
      const m = st.attachments[slot].modifiers;
      if (m.adsSpeed) adsSpeed *= 1 + m.adsSpeed;
      if (m.switchSpeed) switchSpeed *= 1 + m.switchSpeed;
      if (m.reloadSpeed) {
        reloadCalm *= 1 - m.reloadSpeed;
        reloadStressed *= 1 - m.reloadSpeed;
      }
      if (m.hRecoil) hRecoil *= 1 + m.hRecoil;
      if (m.vRecoil) vRecoil *= 1 + m.vRecoil;
      if (m.spread) spread *= 1 + m.spread;
      if (m.kick) kick *= 1 + m.kick;
      if (m.magCapDelta) magCap += m.magCapDelta;
      if (m.suppressed) suppressed = true;
      if (m.opticZoom) opticZoom = m.opticZoom;
    }

    return {
      adsSpeed: Math.max(2.5, adsSpeed),
      switchSpeed: Math.max(0.5, switchSpeed),
      reloadCalm: Math.max(1.0, reloadCalm),
      reloadStressed: Math.max(1.5, reloadStressed),
      hRecoil: Math.max(0.004, hRecoil),
      vRecoil: Math.max(0.008, vRecoil),
      spread: Math.max(0.004, spread),
      kick: Math.max(0.4, kick),
      magCap: Math.max(2, magCap),
      suppressed,
      opticZoom,
    };
  }

  public equipWeaponSlot(slot: 'PRIMARY' | 'SECONDARY'): void {
    this.activeSlot = slot;
    this.isReloading = false;
    this.magCheckTimer = 0;
    this.switchAnimTimer = 0.32;

    if (this.weaponRig) {
      this.weaponRig.root.dispose();
      this.weaponRig.laserDotMesh.dispose();
    }

    const st = this.getActiveWeaponState();
    this.weaponRig = WeaponModelBuilder.buildWeapon(this.scene, st.def, st.attachments);
    this.weaponRig.root.parent = this.weaponPivot;

    this.weaponRig.flashlightSpot.intensity =
      this.flashlightOn && this.weaponRig.hasFlashlight ? 3.5 : 0;

    // Trigger draw spring impulse
    this.wepPosSpring.impulseXYZ(0, -0.9, -0.4);
    this.wepRotSpring.impulseXYZ(0.35, 0, -0.25);

    this.updateHUDWeaponCard();
  }

  public loadMap(mapId: MapId): void {
    this.currentMapId = mapId;
    if (this.builtMap) {
      this.builtMap.sceneGroup.dispose();
    }
    this.clearDecalsAndBrass();

    this.builtMap = MapBuilder.buildMap(mapId, this.scene);
    this.playerPos.copyFrom(this.builtMap.playerSpawn);
    this.playerCollider.position.copyFrom(this.playerPos);
    this.playerYaw = this.builtMap.playerSpawnYaw;
    this.playerPitch = 0;
    this.freeAimX = 0;
    this.freeAimY = 0;
    this.playerHealth = 100;
    this.operatorStress = 0.08;

    this.audio.setEnvironment(mapId === 'TRENCHES' ? 'OUTDOOR' : 'INDOOR');
    this.gadgets.defuseOrResetBomb();

    const jumpBtn = document.getElementById('btn-zone-jump');
    if (jumpBtn) {
      jumpBtn.style.display = mapId === 'SHOOTING_RANGE' ? 'inline-flex' : 'none';
    }

    this.updateAxonHeader();
  }

  public spawnBotsForCurrentMode(count?: number): void {
    for (const b of this.bots) {
      b.dispose();
    }
    this.bots = [];

    const modeDef = BODYCAM_MODES.find((m) => m.id === this.currentModeId) || BODYCAM_MODES[0];
    const numBots = count !== undefined ? count : modeDef.defaultBots;
    const wps = this.builtMap.botWaypoints;
    if (wps.length === 0) return;

    const callsigns = [
      'VIPER-1',
      'KILO-6',
      'REISSAD-2',
      'SHADOW-4',
      'NOMAD-9',
      'DAGGER-3',
      'SPECTRE-7',
      'RAVEN-5',
    ];

    for (let i = 0; i < numBots; i++) {
      const wp = wps[i % wps.length].clone();
      wp.x += (Math.random() - 0.5) * 1.4;
      wp.z += (Math.random() - 0.5) * 1.4;

      let team: BotTeam = 'ENEMY';
      let behavior: BotBehaviorMode = this.botBehaviorMode;

      if (this.currentModeId === 'ZOMBIES') {
        team = 'ZOMBIE';
        behavior = 'ZOMBIE_RUSH';
      } else if (
        (this.currentModeId === 'WINGMAN' || this.currentModeId === 'TDM') &&
        i === 0
      ) {
        team = 'ALLY';
      }

      const bot = new TacticalBot(
        this.scene,
        `bot_${i}_${Date.now()}`,
        callsigns[i % callsigns.length],
        team,
        wp,
        behavior
      );
      this.bots.push(bot);
    }

    const botLbl = document.getElementById('lbl-bots-count');
    if (botLbl) {
      botLbl.textContent = `BOTS: ${this.bots.length}`;
    }
  }

  public startReflexDrill(): void {
    if (this.currentMapId !== 'SHOOTING_RANGE') {
      this.loadMap('SHOOTING_RANGE');
      this.spawnBotsForCurrentMode(2);
    }
    this.playerPos.set(-2.0, 0, -2.2);
    this.playerCollider.position.copyFrom(this.playerPos);
    this.playerYaw = 0;
    this.playerPitch = 0;

    this.drillActive = true;
    this.drillTimeLeft = 30.0;
    this.drillScore = 0;
    this.lastTargetPopUpTime = performance.now();

    const drillTargets = this.builtMap.reactiveTargets.filter((t) => t.isDrillTarget);
    drillTargets.forEach((t, idx) => {
      t.isDown = idx >= 3;
      t.drillActive = !t.isDown;
    });

    this.audio.playRadioCommsBeep();
    this.showDiegeticBanner('30s CQB REFLEX DRILL ACTIVE — ENGAGE POP-UP TARGETS');
  }

  private showDiegeticBanner(msg: string, durationMs = 2400): void {
    const el = document.getElementById('diegetic-banner');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    window.clearTimeout((el as unknown as { _timer?: number })._timer);
    (el as unknown as { _timer?: number })._timer = window.setTimeout(() => {
      el.style.opacity = '0';
    }, durationMs);
  }

  private addKillfeedEntry(text: string, color = '#ef4444'): void {
    const container = document.getElementById('killfeed-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = 'killfeed-item';
    item.style.borderRightColor = color;
    item.textContent = text;
    container.prepend(item);
    while (container.children.length > 4) {
      container.lastChild?.remove();
    }
    setTimeout(() => item.remove(), 5000);
  }

  private triggerHitmarker(isHeadshot: boolean): void {
    const hm = document.getElementById('hitmarker');
    if (!hm) return;
    hm.setAttribute('stroke', isHeadshot ? '#ef4444' : '#f8fafc');
    hm.style.opacity = '1';
    hm.style.transform = `translate(-50%, -50%) scale(${isHeadshot ? 1.35 : 1.0})`;
    setTimeout(() => {
      hm.style.opacity = '0';
    }, 105);
  }

  // ==================== SHOOTING, RELOAD & MAG CHECK ====================
  private tryFireWeapon(): void {
    if (this.isReloading || this.switchAnimTimer > 0.05 || this.pumpCycleTimer > 0) return;

    const st = this.getActiveWeaponState();
    const mode = st.def.fireModes[st.fireModeIndex] || 'AUTO';
    if (mode === 'SEMI' || mode === 'PUMP' || mode === 'BOLT') {
      if (this.semiShotLatched) return;
      this.semiShotLatched = true;
    }

    const totalLoaded = st.magAmmo + st.chambered;
    if (totalLoaded <= 0) {
      this.audio.playDryFire();
      this.semiShotLatched = true;
      this.showDiegeticBanner('WEAPON DRY — PRESS [R] OR TAP RELOAD');
      return;
    }

    if (st.magAmmo > 0) {
      st.magAmmo--;
    } else {
      st.chambered = 0;
    }

    const stats = this.getComputedWeaponStats(st);
    const interval = 60 / st.def.rpm;
    this.fireTimer = interval;

    if (mode === 'PUMP' || mode === 'BOLT') {
      this.pumpCycleTimer = Math.min(interval * 0.85, 0.72);
      setTimeout(() => {
        this.audio.playReloadStep('pump');
      }, 210);
    }

    // 1. Acoustic Pressure Wave Gunshot
    this.audio.playGunshot(st.def.caliber, stats.suppressed, 0, 0);

    if (!stats.suppressed) {
      for (const bot of this.bots) {
        bot.notifySoundHeard(this.playerPos);
      }
    }

    // 2. HDR Muzzle Flash & Bolt Kick (-Z rearward)
    if (!stats.suppressed) {
      const mfMat = this.weaponRig.muzzleFlashMesh.material as StandardMaterial;
      mfMat.alpha = 0.95;
      this.weaponRig.muzzleFlashMesh.rotation.z = Math.random() * Math.PI * 2;
      this.weaponRig.muzzleFlashLight.intensity = 6.5;
    }
    this.boltSlideOffset = st.def.visual.isPistol ? -0.045 : -0.065;

    // 3. Eject 3D Brass Casing
    if (!st.def.visual.isRevolver) {
      this.spawnEjectedBrass(st.def.category === 'Shotguns');
    }

    // 4. Ballistic Raycast along True 3D Weapon Barrel Vector (+Z in Babylon.js)!
    const pellets = st.def.pellets || 1;
    this.shotsFired++;
    let anyPelletHit = false;

    this.weaponRig.muzzlePoint.computeWorldMatrix(true);
    const muzzleWorldPos = this.weaponRig.muzzlePoint.getAbsolutePosition().clone();
    const baseBarrelDir = this.weaponRig.muzzlePoint.forward.clone().normalize();

    if (this.aimAssistEnabled) {
      const assistedDir = this.computeAimAssistVector(muzzleWorldPos, baseBarrelDir);
      if (assistedDir) {
        Vector3.LerpToRef(
          baseBarrelDir,
          assistedDir,
          this.isADS || this.isCanted ? 0.72 : 0.56,
          baseBarrelDir
        );
        baseBarrelDir.normalize();
      }
    }

    const activeSpread = this.isADS ? st.def.adsSpread : stats.spread * 0.42;

    for (let p = 0; p < pellets; p++) {
      const shotDir = baseBarrelDir.clone();
      if (pellets > 1 || activeSpread > 0.0005) {
        shotDir.x += (Math.random() - 0.5) * activeSpread;
        shotDir.y += (Math.random() - 0.5) * activeSpread;
        shotDir.z += (Math.random() - 0.5) * activeSpread;
        shotDir.normalize();
      }

      if (this.performBallisticRaycast(muzzleWorldPos, shotDir, st.def)) {
        anyPelletHit = true;
      }
    }

    if (anyPelletHit) {
      this.shotsHit++;
    }
    this.updateTelemetryAccuracy();

    // 5. 2nd-Order Harmonic Spring Recoil Impulse + Camera Concussion
    const adsMult = this.isADS ? 0.65 : this.isCanted ? 0.78 : 1.0;
    const vertClimb = stats.vRecoil * stats.kick * adsMult;
    const horizDrift = (Math.random() - 0.46) * stats.hRecoil * stats.kick * 1.8 * adsMult;

    // Weapon kicks backward (-Z) and pitches upward (-X in Babylon Euler)
    this.wepPosSpring.impulseXYZ(
      horizDrift * 0.25,
      vertClimb * 0.35,
      -0.42 * stats.kick * adsMult
    );
    this.wepRotSpring.impulseXYZ(
      -vertClimb * 9.5,
      horizDrift * 7.5,
      (Math.random() - 0.5) * 1.2 * stats.kick
    );
    this.camRecoilSpring.impulseXYZ(
      -vertClimb * 5.2,
      horizDrift * 4.5,
      (Math.random() - 0.5) * 0.85 * stats.kick
    );

    // Permanent slight climb into pitch & free-aim
    this.playerPitch = Math.max(-1.35, Math.min(1.35, this.playerPitch - vertClimb * 0.38));
    this.playerYaw += horizDrift * 0.38;
    this.freeAimY = Math.max(-0.2, Math.min(0.2, this.freeAimY - vertClimb * 0.32));
    this.freeAimX = Math.max(-0.25, Math.min(0.25, this.freeAimX + horizDrift * 0.32));

    this.recoilChromaticSpike = Math.min(1.0, this.recoilChromaticSpike + 0.42 * stats.kick);
    this.operatorStress = Math.min(1.0, this.operatorStress + 0.016);

    if (navigator.vibrate) {
      navigator.vibrate(15);
    }

    this.updateHUDWeaponCard();
  }

  private computeAimAssistVector(origin: Vector3, barrelDir: Vector3): Vector3 | null {
    let bestDir: Vector3 | null = null;
    let bestDot = Math.cos((5.6 * Math.PI) / 180);

    for (const bot of this.bots) {
      if (bot.isDead || bot.team === 'ALLY') continue;
      const chestPos = bot.root.position.add(new Vector3(0, 1.28, 0));
      const toBot = chestPos.subtract(origin).normalize();
      const dot = Vector3.Dot(barrelDir, toBot);
      if (dot > bestDot) {
        bestDot = dot;
        bestDir = toBot;
      }
    }

    for (const rt of this.builtMap.reactiveTargets) {
      if (rt.isDown) continue;
      rt.bodyMesh.computeWorldMatrix(true);
      const targetCenter = rt.bodyMesh.getAbsolutePosition();
      const toTarget = targetCenter.subtract(origin).normalize();
      const dot = Vector3.Dot(barrelDir, toTarget);
      if (dot > bestDot) {
        bestDot = dot;
        bestDir = toTarget;
      }
    }

    return bestDir;
  }

  private performBallisticRaycast(origin: Vector3, dir: Vector3, weapon: WeaponDef): boolean {
    const ray = new Ray(origin, dir, 150);
    const pick = this.scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isEnabled());

    if (!pick || !pick.hit || !pick.pickedPoint || !pick.pickedMesh) return false;

    const hitPoint = pick.pickedPoint;
    const hitMesh = pick.pickedMesh;
    const distMeters = Math.round(pick.distance * 10) / 10;
    const meta = hitMesh.metadata || {};

    // 1. Tactical AI Bot Hit
    if (meta.botId) {
      const bot = this.bots.find((b) => b.id === meta.botId);
      if (bot && !bot.isDead) {
        const zone = (meta.hitZone || 'TORSO') as 'HEAD' | 'TORSO' | 'LIMB';
        const mult =
          zone === 'HEAD' ? weapon.headshotMult : zone === 'LIMB' ? weapon.limbMult : 1.0;
        const dmg = Math.round(weapon.damage * mult);

        const res = bot.applyHit(dmg, zone, dir);
        this.spawnImpactParticles(
          hitPoint,
          zone === 'HEAD' ? new Color3(1, 0.75, 0.2) : new Color3(0.75, 0.08, 0.08),
          7
        );
        this.audio.playHitSound(zone === 'HEAD' ? 'HEADSHOT_HELMET' : 'FLESH');
        this.triggerHitmarker(zone === 'HEAD');

        const lastHitEl = document.getElementById('telemetry-last-hit');
        if (lastHitEl) {
          lastHitEl.textContent = `${bot.callsign} [${zone}] · ${dmg} DMG @ ${distMeters}m`;
        }

        if (res.killed) {
          this.totalKills++;
          if (res.headshot) this.headshotsCount++;
          const rpEarned = res.headshot ? 150 : 100;
          this.awardReissadPoints(rpEarned);
          this.audio.playRadioCommsBeep();
          this.addKillfeedEntry(
            `${bot.callsign} KIA [${weapon.name}${res.headshot ? ' · HEADSHOT' : ''}] +${rpEarned} RP`,
            res.headshot ? '#f59e0b' : '#22c55e'
          );

          if (this.currentModeId === 'GUNGAME') {
            this.gunGameIndex = (this.gunGameIndex + 1) % BODYCAM_WEAPONS.length;
            const nextWep = BODYCAM_WEAPONS[this.gunGameIndex];
            this.primaryState.def = nextWep;
            this.primaryState.magAmmo = nextWep.magCapacity;
            this.primaryState.chambered = 1;
            this.equipWeaponSlot('PRIMARY');
            this.showDiegeticBanner(`GUN GAME TIER ${this.gunGameIndex + 1}: ${nextWep.name}`);
          }
        }
        return true;
      }
    }

    // 2. Reactive Steel Target Hit
    if (meta.targetId) {
      const rt = this.builtMap.reactiveTargets.find((t) => t.id === meta.targetId);
      if (rt && !rt.isDown) {
        const zone = (meta.hitZone || 'BODY') as 'HEAD' | 'BODY';
        const isHead = zone === 'HEAD';
        const dmg = Math.round(weapon.damage * (isHead ? weapon.headshotMult : 1.0));

        this.audio.playHitSound(isHead ? 'STEEL_HEAD' : 'STEEL_BODY');
        this.spawnImpactParticles(hitPoint, new Color3(1.0, 0.82, 0.3), 8);
        this.triggerHitmarker(isHead);

        rt.isDown = true;
        rt.downTimer = rt.isDrillTarget ? 999 : 2.1;
        if (isHead) this.headshotsCount++;

        const reactionMs = Math.round(performance.now() - this.lastTargetPopUpTime);
        const rpGain = isHead ? 50 : 25;
        this.awardReissadPoints(rpGain);

        const lastHitEl = document.getElementById('telemetry-last-hit');
        if (lastHitEl) {
          lastHitEl.textContent = `STEEL [${zone}] @ ${distMeters}m · ${dmg} DMG · +${rpGain} RP`;
        }

        if (this.drillActive && rt.isDrillTarget) {
          this.drillScore += isHead ? 150 : 100;
          this.lastTargetPopUpTime = performance.now();
          const downedDrill = this.builtMap.reactiveTargets.filter(
            (t) => t.isDrillTarget && t.isDown && t.id !== rt.id
          );
          if (downedDrill.length > 0) {
            const pickT = downedDrill[Math.floor(Math.random() * downedDrill.length)];
            pickT.isDown = false;
            pickT.downTimer = 0;
          }
          const drillEl = document.getElementById('telemetry-drill');
          if (drillEl) {
            drillEl.textContent = `DRILL: ${this.drillScore} PTS · ${reactionMs}ms (${Math.ceil(
              this.drillTimeLeft
            )}s)`;
          }
        }
        return true;
      }
    }

    // 3. World Geometry Impact (Bullet Decal + Sparks)
    const normal = pick.getNormal(true);
    if (normal) {
      this.spawnBulletDecal(hitPoint, normal);
      this.spawnImpactParticles(hitPoint, new Color3(1.0, 0.88, 0.55), 4);
    }
    return false;
  }

  public startReload(): void {
    if (this.isReloading) return;
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);

    if (st.spareMags <= 0) {
      this.showDiegeticBanner('NO SPARE MAGAZINES REMAINING');
      return;
    }
    if (st.magAmmo >= stats.magCap && st.chambered === 1) return;

    this.isReloading = true;
    this.isADS = false;
    document.getElementById('tbtn-ads')?.classList.remove('active');
    this.reloadTimer = 0;
    this.reloadIsStressed = this.operatorStress > 0.48;
    this.reloadDuration = this.reloadIsStressed ? stats.reloadStressed : stats.reloadCalm;
    this.reloadStepFlags = { out: false, fumble: false, in: false, bolt: false };

    if (this.reloadIsStressed) {
      this.showDiegeticBanner('HIGH COMBAT STRESS — FUMBLED / PANICKED RELOAD');
    } else {
      this.showDiegeticBanner('TACTICAL RELOAD...');
    }
  }

  public triggerMagCheck(): void {
    if (this.isReloading || this.magCheckTimer > 0) return;
    this.magCheckTimer = 1.45;
    this.audio.playReloadStep('magCheck');
    this.wepRotSpring.impulseXYZ(-0.2, 0.15, 0.65);

    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);
    const ratio = st.magAmmo / stats.magCap;
    let desc = 'EMPTY (0 RNDS)';
    if (ratio >= 0.95) desc = `FULL (~${st.magAmmo} RNDS)`;
    else if (ratio >= 0.65) desc = `> HALF (~${st.magAmmo} RNDS)`;
    else if (ratio >= 0.35) desc = `~ HALF (~${st.magAmmo} RNDS)`;
    else if (st.magAmmo > 0) desc = `LOW (~${st.magAmmo} RNDS)`;

    const chamberText = st.chambered ? '+1 CHAMBER' : 'CHAMBER EMPTY';
    this.showDiegeticBanner(
      `MAG CHECK: ${desc} · ${chamberText} · ${st.spareMags} SPARE`,
      2600
    );
  }

  public throwGrenade(): void {
    if (this.grenadesRemaining <= 0) {
      this.showDiegeticBanner('OUT OF THROWABLES');
      return;
    }
    this.grenadesRemaining--;
    const isFlash = this.selectedGrenade === 'FLASH';

    const gGroup = new TransformNode('grenadeNode', this.scene);
    const bodyMesh = isFlash
      ? MeshBuilder.CreateCylinder(
          'flashBody',
          { diameter: 0.064, height: 0.11, tessellation: 10 },
          this.scene
        )
      : MeshBuilder.CreateSphere('fragBody', { diameter: 0.09, segments: 8 }, this.scene);

    const gMat = new PBRMaterial('grenMat', this.scene);
    gMat.albedoColor = isFlash ? new Color3(0.82, 0.85, 0.88) : new Color3(0.25, 0.32, 0.2);
    gMat.roughness = 0.45;
    gMat.metallic = 0.4;
    bodyMesh.material = gMat;
    bodyMesh.parent = gGroup;
    bodyMesh.isPickable = false;

    const camForward = this.camera.getForwardRay(1).direction.clone().normalize();
    gGroup.position.copyFrom(this.camera.position).addInPlace(camForward.scale(0.65));

    const throwVel = camForward.scale(15.5).add(new Vector3(0, 3.2, 0));
    this.activeGrenades.push({
      mesh: gGroup,
      vel: throwVel,
      isFlashbang: isFlash,
      fuseTimer: 2.25,
    });

    this.audio.playReloadStep('magOut');
    this.showDiegeticBanner(
      isFlash
        ? `M84 STUN FLASHBANG OUT (${this.grenadesRemaining} LEFT)`
        : `M67 FRAG GRENADE OUT (${this.grenadesRemaining} LEFT)`
    );
  }

  public toggleGadgetDeploy(): void {
    if (this.gadgets.activeGadget) {
      this.gadgets.recallOrDestroy(4.0);
      this.audio.setDroneMotorState(false);
      this.operatorBodyStandin.setEnabled(false);
      this.scene.activeCamera = this.camera;
      this.postProcess.attachToCamera(this.camera);
      document.getElementById('drone-osd')?.classList.remove('visible');
      return;
    }

    const ok = this.gadgets.deploy(
      this.selectedGadget,
      this.droneFlightMode,
      this.playerPos,
      this.playerYaw
    );
    if (!ok) {
      this.showDiegeticBanner(
        `GADGET RECHARGING (${Math.ceil(this.gadgets.cooldown)}s COOLDOWN)`
      );
      return;
    }

    this.operatorBodyStandin.position.copyFrom(this.playerPos);
    this.operatorBodyStandin.rotation.y = this.playerYaw;
    this.operatorBodyStandin.setEnabled(true);
    this.scene.activeCamera = this.gadgets.camera;
    this.postProcess.attachToCamera(this.gadgets.camera);
    document.getElementById('drone-osd')?.classList.add('visible');
    this.updateDroneOSD();
  }

  public detonateGadgetPayload(): void {
    if (!this.gadgets.activeGadget) return;
    const blastPos = this.gadgets.pos.clone();
    const distToPlayer = Vector3.Distance(blastPos, this.playerPos);

    this.audio.playExplosion(false, distToPlayer);
    this.spawnImpactParticles(blastPos, new Color3(1.0, 0.55, 0.15), 22);

    for (const bot of this.bots) {
      if (bot.isDead) continue;
      const d = Vector3.Distance(bot.root.position, blastPos);
      if (d < 9.5) {
        const dmg = Math.round(160 * (1 - d / 9.5));
        const dir = bot.root.position.subtract(blastPos).normalize();
        const res = bot.applyHit(dmg, 'TORSO', dir);
        if (res.killed) {
          this.totalKills++;
          this.awardReissadPoints(125);
          this.addKillfeedEntry(
            `${bot.callsign} KIA [${this.gadgets.activeGadget} C4] +125 RP`,
            '#38bdf8'
          );
        }
      }
    }

    this.gadgets.recallOrDestroy(6.0);
    this.audio.setDroneMotorState(false);
    this.operatorBodyStandin.setEnabled(false);
    this.scene.activeCamera = this.camera;
    this.postProcess.attachToCamera(this.camera);
    document.getElementById('drone-osd')?.classList.remove('visible');
  }

  private awardReissadPoints(amount: number): void {
    this.reissadPoints += amount;
    const rpEl = document.getElementById('tablet-rp-balance');
    if (rpEl) rpEl.textContent = `${this.reissadPoints.toLocaleString()} RP`;
    this.updateAxonHeader();
  }

  // ==================== VISUAL POOLS ====================
  private spawnEjectedBrass(isShotgunHull: boolean): void {
    this.weaponRig.ejectionPoint.computeWorldMatrix(true);
    const worldPos = this.weaponRig.ejectionPoint.getAbsolutePosition().clone();
    const rightDir = this.weaponRig.ejectionPoint.right
      .clone()
      .add(new Vector3(0, 0.45, -0.15))
      .normalize()
      .scale(2.3 + Math.random() * 1.1);

    const mesh = MeshBuilder.CreateCylinder(
      'brassCasing',
      {
        diameter: isShotgunHull ? 0.018 : 0.009,
        height: isShotgunHull ? 0.055 : 0.032,
        tessellation: 6,
      },
      this.scene
    );
    mesh.position.copyFrom(worldPos);
    mesh.isPickable = false;

    const mat = new PBRMaterial('casingMat', this.scene);
    mat.albedoColor = isShotgunHull
      ? new Color3(0.75, 0.12, 0.12)
      : new Color3(0.88, 0.72, 0.22);
    mat.metallic = isShotgunHull ? 0.2 : 0.9;
    mat.roughness = 0.25;
    mesh.material = mat;

    this.ejectedBrass.push({
      mesh,
      vel: rightDir,
      rotVel: new Vector3(
        Math.random() * 18,
        Math.random() * 18,
        Math.random() * 18
      ),
      life: 2.2,
    });
  }

  private spawnBulletDecal(point: Vector3, normal: Vector3): void {
    const decal = MeshBuilder.CreateDisc(
      'bulletDecal',
      { radius: 0.036, tessellation: 8, sideOrientation: Mesh.DOUBLESIDE },
      this.scene
    );
    decal.position.copyFrom(point).addInPlace(normal.scale(0.012));
    decal.lookAt(point.add(normal));
    decal.isPickable = false;

    const mat = new StandardMaterial('decalMat', this.scene);
    mat.diffuseColor = new Color3(0.04, 0.05, 0.06);
    mat.specularColor = Color3.Black();
    decal.material = mat;

    this.bulletDecals.push(decal);
    if (this.bulletDecals.length > 50) {
      const old = this.bulletDecals.shift();
      old?.dispose();
    }
  }

  private spawnImpactParticles(pos: Vector3, col: Color3, count: number): void {
    const mat = new StandardMaterial('sparkMat', this.scene);
    mat.disableLighting = true;
    mat.emissiveColor = col.scale(2.5); // HDR Bloom sparks!

    for (let i = 0; i < count; i++) {
      const mesh = MeshBuilder.CreateBox('spark', { size: 0.026 }, this.scene);
      mesh.position.copyFrom(pos);
      mesh.material = mat;
      mesh.isPickable = false;
      this.impactParticles.push({
        mesh,
        vel: new Vector3(
          (Math.random() - 0.5) * 5.8,
          1.2 + Math.random() * 3.8,
          (Math.random() - 0.5) * 5.8
        ),
        life: 0.32 + Math.random() * 0.22,
      });
    }
  }

  private clearDecalsAndBrass(): void {
    for (const d of this.bulletDecals) d.dispose();
    this.bulletDecals = [];
    for (const b of this.ejectedBrass) b.mesh.dispose();
    this.ejectedBrass = [];
  }

  // ==================== MAIN FRAME UPDATE ====================
  private updateFrame(dt: number, elapsed: number): void {
    this.fpsAvg = this.fpsAvg * 0.92 + this.engine.getFps() * 0.08;
    this.updateClockStamp();

    // Velocity-smoothed look interpolation (eliminates mobile touch jitter!)
    const smoothFactor = Math.min(1, dt * 28);
    this.smoothedLookDelta.x = this.rawLookAccum.x * smoothFactor;
    this.smoothedLookDelta.y = this.rawLookAccum.y * smoothFactor;
    this.rawLookAccum.x -= this.smoothedLookDelta.x;
    this.rawLookAccum.y -= this.smoothedLookDelta.y;

    if (this.gadgets.activeGadget) {
      this.updateGadgetMode(dt);
    } else {
      this.updatePlayerMovementAndCamera(dt, elapsed);
      this.updateWeaponMechanicsAndSprings(dt, elapsed);
    }

    this.updateReactiveTargetsAndDrill(dt, elapsed);
    this.updateBotsAI(dt);
    this.updateGrenadesAndPools(dt);
    this.updatePhysiologyAndStress(dt, elapsed);

    this.postProcess.updateState(elapsed, {
      stress: this.operatorStress,
      damage: this.damageFlash,
      flashbang: this.flashbangBlind,
      adsAmount: this.adsAmount,
      recoilChromaticSpike: this.recoilChromaticSpike,
      droneMode: this.gadgets.activeGadget !== null,
      exposure: this.builtMap.defaultExposure,
    });
  }

  private updateGadgetMode(dt: number): void {
    let moveFwd = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0) + this.touchMoveVec.y;
    let moveRight = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0) + this.touchMoveVec.x;
    const vert = (this.keys['Space'] ? 1 : 0) - (this.keys['ControlLeft'] ? 1 : 0);

    moveFwd = Math.max(-1, Math.min(1, moveFwd));
    moveRight = Math.max(-1, Math.min(1, moveRight));

    const lookDX = this.smoothedLookDelta.x * 0.0045 * this.lookSensitivity;
    const lookDY = this.smoothedLookDelta.y * 0.0045 * this.lookSensitivity;

    const res = this.gadgets.update(dt, {
      moveForward: moveFwd,
      moveRight,
      vertical: vert,
      lookDeltaX: lookDX,
      lookDeltaY: lookDY,
    });

    if (this.gadgets.activeGadget) {
      this.audio.setDroneMotorState(
        true,
        res.throttleLevel,
        this.gadgets.activeGadget === 'RC_CAR'
      );
      this.updateDroneOSD();
    } else {
      this.audio.setDroneMotorState(false);
      this.operatorBodyStandin.setEnabled(false);
      this.scene.activeCamera = this.camera;
      this.postProcess.attachToCamera(this.camera);
      document.getElementById('drone-osd')?.classList.remove('visible');
    }
  }

  private updateDroneOSD(): void {
    const titleEl = document.getElementById('drone-title-osd');
    const modeEl = document.getElementById('drone-mode-osd');
    const battEl = document.getElementById('drone-batt-osd');
    const coordsEl = document.getElementById('drone-coords-osd');
    if (titleEl) {
      titleEl.textContent =
        this.gadgets.activeGadget === 'RC_CAR'
          ? 'REISSAD RECON RC ROVER // GROUND LINK'
          : 'REISSAD FPV QUAD DRONE // CH-4 5.8GHz';
    }
    if (modeEl) {
      modeEl.textContent =
        this.gadgets.activeGadget === 'RC_CAR'
          ? 'DRIVE MODE: HIGH-TORQUE + C4 CHARGE'
          : `FLIGHT PROFILE: ${this.gadgets.droneFlightMode} (${
              this.gadgets.droneFlightMode === 'ACRO' ? 'MANUAL FPV RATES' : 'AUTO-LEVEL STABILIZED'
            })`;
    }
    if (battEl) {
      battEl.textContent = `BATT: ${Math.ceil(this.gadgets.battery)}% (16.4V 4S)`;
    }
    if (coordsEl) {
      const dist = Vector3.Distance(this.gadgets.pos, this.playerPos).toFixed(1);
      coordsEl.textContent = `ALT: ${this.gadgets.pos.y.toFixed(1)}m // RANGE: ${dist}m`;
    }
  }

  private updatePlayerMovementAndCamera(dt: number, elapsed: number): void {
    const dx = this.smoothedLookDelta.x * 0.003 * this.lookSensitivity;
    const dy = this.smoothedLookDelta.y * 0.003 * this.lookSensitivity;

    // 1. Bodycam Unlinked Free-Aim Deadzone + Weapon Spring Sway Impulse
    const deadzoneLimitX = this.isADS ? 0.03 : 0.18;
    const deadzoneLimitY = this.isADS ? 0.025 : 0.13;

    this.freeAimX += dx * (this.isADS ? 0.22 : 0.62);
    this.freeAimY += dy * (this.isADS ? 0.22 : 0.62);

    // Feed wrist rotational torque into harmonic weapon spring
    this.wepRotSpring.impulseXYZ(dy * 2.8, dx * 2.8, -dx * 3.6);
    this.wepPosSpring.impulseXYZ(-dx * 0.14, dy * 0.14, 0);

    if (Math.abs(this.freeAimX) > deadzoneLimitX) {
      const excessX = this.freeAimX - Math.sign(this.freeAimX) * deadzoneLimitX;
      this.playerYaw += excessX;
      this.freeAimX = Math.sign(this.freeAimX) * deadzoneLimitX;
    }
    if (Math.abs(this.freeAimY) > deadzoneLimitY) {
      const excessY = this.freeAimY - Math.sign(this.freeAimY) * deadzoneLimitY;
      this.playerPitch = Math.max(-1.35, Math.min(1.35, this.playerPitch + excessY));
      this.freeAimY = Math.sign(this.freeAimY) * deadzoneLimitY;
    }

    this.playerYaw += dx * (this.isADS ? 0.88 : 0.58);
    this.playerPitch = Math.max(
      -1.35,
      Math.min(1.35, this.playerPitch + dy * (this.isADS ? 0.88 : 0.58))
    );

    const recenterRate = this.isADS ? 10.5 : 3.0;
    this.freeAimX += (0 - this.freeAimX) * Math.min(1, dt * recenterRate);
    this.freeAimY += (0 - this.freeAimY) * Math.min(1, dt * recenterRate);

    // 2. Movement Vector & Native Babylon.js Sliding Ellipsoid Collision
    let moveFwd =
      (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0) -
      (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0) +
      this.touchMoveVec.y;
    let moveRight =
      (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0) -
      (this.keys['KeyA'] || this.keys['ArrowLeft'] ? 1 : 0) +
      this.touchMoveVec.x;

    const inputLen = Math.hypot(moveFwd, moveRight);
    if (inputLen > 1) {
      moveFwd /= inputLen;
      moveRight /= inputLen;
    }

    const isSprinting =
      (this.keys['ShiftLeft'] || this.touchSprinting) &&
      moveFwd > 0.35 &&
      !this.isADS &&
      !this.isCrouching &&
      !this.isReloading;

    this.sprintPoseAmount += ((isSprinting ? 1 : 0) - this.sprintPoseAmount) * Math.min(1, dt * 9);

    const baseSpeed = this.isCrouching ? 2.7 : isSprinting ? 6.5 : this.isADS ? 3.2 : 4.55;

    const forwardVec = new Vector3(Math.sin(this.playerYaw), 0, Math.cos(this.playerYaw));
    const rightVec = new Vector3(Math.cos(this.playerYaw), 0, -Math.sin(this.playerYaw));

    const wishVel = Vector3.Zero();
    wishVel.addInPlace(forwardVec.scale(moveFwd * baseSpeed));
    wishVel.addInPlace(rightVec.scale(moveRight * baseSpeed));

    Vector3.LerpToRef(this.playerVel, wishVel, Math.min(1, dt * 12.0), this.playerVel);

    // Slide smoothly along walls using Babylon.js ellipsoid collision!
    this.playerCollider.position.copyFrom(this.playerPos);
    this.playerCollider.moveWithCollisions(this.playerVel.scale(dt));
    this.playerPos.copyFrom(this.playerCollider.position);
    this.playerPos.y = 0;

    // 3. Stance Height & Q/E Corner Leaning
    const targetHeight = this.isCrouching ? 1.05 : 1.62;
    this.currentEyeHeight += (targetHeight - this.currentEyeHeight) * Math.min(1, dt * 10);

    const kbLean = (this.keys['KeyE'] ? 1 : 0) - (this.keys['KeyQ'] ? 1 : 0);
    const activeLean = kbLean !== 0 ? kbLean : this.leanTarget;
    this.leanCurrent += (activeLean - this.leanCurrent) * Math.min(1, dt * 9.5);

    // 4. Chest-Camera Bob, Footsteps & Spring Update
    const horizSpeed = Math.hypot(this.playerVel.x, this.playerVel.z);
    let bobY = Math.sin(elapsed * 2.1) * 0.007;
    let bobRoll = Math.cos(elapsed * 1.4) * 0.004;

    if (horizSpeed > 0.4) {
      const freq = isSprinting ? 11.8 : 8.4;
      this.walkBobTimer += dt * freq;
      const amp = isSprinting ? 0.05 : 0.024;
      bobY += Math.sin(this.walkBobTimer) * amp;
      bobRoll += Math.cos(this.walkBobTimer * 0.5) * (amp * 0.48);

      const stepCycle = Math.floor(this.walkBobTimer / Math.PI);
      if (stepCycle !== this.lastFootstepCycle) {
        this.lastFootstepCycle = stepCycle;
        this.audio.playFootstep(this.builtMap.surfaceType, isSprinting);
        // Subtle footstep impulse into weapon spring
        this.wepPosSpring.impulseXYZ(
          (stepCycle % 2 === 0 ? 1 : -1) * (isSprinting ? 0.14 : 0.06),
          isSprinting ? -0.24 : -0.1,
          0
        );
      }
    }

    const camSpring = this.camRecoilSpring.update(dt);
    const leanOffset = rightVec.scale(this.leanCurrent * 0.44);

    this.camera.position
      .copyFrom(this.playerPos)
      .addInPlace(leanOffset)
      .addInPlaceFromFloats(0, this.currentEyeHeight + bobY, 0);

    this.camera.rotation.set(
      Math.max(-1.45, Math.min(1.45, this.playerPitch + camSpring.x)),
      this.playerYaw + camSpring.y,
      -this.leanCurrent * 0.24 + bobRoll + camSpring.z
    );
  }

  private updateWeaponMechanicsAndSprings(dt: number, elapsed: number): void {
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);

    // 1. ADS & Canted Laser Point-Shooting Interpolation
    const wantADS = this.isADS && !this.isReloading && this.magCheckTimer <= 0;
    const wantCanted = this.isCanted && !this.isReloading && this.magCheckTimer <= 0;

    this.adsAmount += ((wantADS ? 1 : 0) - this.adsAmount) * Math.min(1, dt * stats.adsSpeed * 1.9);
    this.cantedAmount += ((wantCanted ? 1 : 0) - this.cantedAmount) * Math.min(1, dt * 11);

    const targetFov = 1.38 / (1 + (stats.opticZoom - 1) * 0.45 * this.adsAmount);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);

    // 2. Physical Wall / Doorway Barrel Collision Avoidance (Weapon High-Port)
    const camRay = this.camera.getForwardRay(0.88);
    const wallHit = this.scene.pickWithRay(
      camRay,
      (m) => !!m.metadata?.isWorldGeometry && m.checkCollisions
    );
    const targetBlock =
      wallHit && wallHit.hit && wallHit.distance < 0.85
        ? Math.min(1, (0.85 - wallHit.distance) / 0.55)
        : 0;
    this.wallBlockAmount += (targetBlock - this.wallBlockAmount) * Math.min(1, dt * 12);

    // 3. Decay Muzzle Flash, Bolt Slide & Switch Timer
    this.recoilChromaticSpike += (0 - this.recoilChromaticSpike) * Math.min(1, dt * 9.5);
    this.boltSlideOffset += (0 - this.boltSlideOffset) * Math.min(1, dt * 24.0);

    if (this.switchAnimTimer > 0) {
      this.switchAnimTimer = Math.max(0, this.switchAnimTimer - dt * stats.switchSpeed);
    }
    if (this.pumpCycleTimer > 0) {
      this.pumpCycleTimer = Math.max(0, this.pumpCycleTimer - dt);
    }

    const flashMat = this.weaponRig.muzzleFlashMesh.material as StandardMaterial;
    if (flashMat.alpha > 0) {
      flashMat.alpha = Math.max(0, flashMat.alpha - dt * 20);
      this.weaponRig.muzzleFlashLight.intensity = flashMat.alpha * 6.0;
    }

    const isEmpty = st.magAmmo + st.chambered === 0;
    this.weaponRig.boltGroup.position.z = isEmpty ? -0.038 : this.boltSlideOffset;

    if (this.pumpCycleTimer > 0) {
      const pumpCurve = Math.sin((this.pumpCycleTimer / 0.55) * Math.PI);
      this.weaponRig.pumpGroup.position.z = -Math.max(0, pumpCurve * 0.075);
    } else {
      this.weaponRig.pumpGroup.position.z = 0;
    }

    // 4. Multi-Stage Articulated Reload & Diegetic Mag Check
    let reloadDipY = 0;
    let reloadRollZ = 0;
    let reloadPitchX = 0;

    if (this.isReloading) {
      this.reloadTimer += dt;
      const p = Math.min(1, this.reloadTimer / this.reloadDuration);

      if (p > 0.12 && !this.reloadStepFlags.out) {
        this.reloadStepFlags.out = true;
        this.audio.playReloadStep('magOut');
        this.wepPosSpring.impulseXYZ(0, -0.35, 0);
      }
      if (this.reloadIsStressed && p > 0.42 && !this.reloadStepFlags.fumble) {
        this.reloadStepFlags.fumble = true;
        this.audio.playReloadStep('magFumble');
        this.wepRotSpring.impulseXYZ(0.35, -0.25, 0.45);
      }
      if (p > 0.65 && !this.reloadStepFlags.in) {
        this.reloadStepFlags.in = true;
        this.audio.playReloadStep('magIn');
        this.wepPosSpring.impulseXYZ(0, 0.55, 0);
      }
      if (p > 0.86 && !this.reloadStepFlags.bolt) {
        this.reloadStepFlags.bolt = true;
        this.audio.playReloadStep('boltSlap');
        this.boltSlideOffset = -0.055;
        this.wepPosSpring.impulseXYZ(0, 0, -0.35);
      }

      const stressJitter = this.reloadIsStressed ? Math.sin(elapsed * 48) * 0.015 : 0;
      const magPull = p < 0.35 ? p / 0.35 : p < 0.68 ? 1.0 : 1.0 - (p - 0.68) / 0.32;
      this.weaponRig.magazineGroup.position.y =
        -st.def.visual.receiverHeight * 0.5 - magPull * 0.22 + stressJitter;
      this.weaponRig.magazineGroup.position.x = stressJitter * 1.4;

      reloadDipY = -Math.sin(p * Math.PI) * 0.045;
      reloadRollZ = -Math.sin(p * Math.PI) * 0.42 + stressJitter * 2.5;
      reloadPitchX = -Math.sin(p * Math.PI) * 0.2;

      if (p >= 1.0) {
        this.isReloading = false;
        this.weaponRig.magazineGroup.position.set(
          0,
          -st.def.visual.receiverHeight * 0.5,
          st.def.visual.isPistol ? -0.035 : 0.048
        );
        const hadRoundInChamber = st.magAmmo + st.chambered > 0;
        st.spareMags = Math.max(0, st.spareMags - 1);
        st.magAmmo = stats.magCap;
        st.chambered = hadRoundInChamber ? 1 : 0;
        this.updateHUDWeaponCard();
      }
    } else if (this.magCheckTimer > 0) {
      this.magCheckTimer = Math.max(0, this.magCheckTimer - dt);
      const checkAmt = Math.sin(Math.min(1, this.magCheckTimer / 1.45) * Math.PI);
      this.weaponRig.magazineGroup.position.y =
        -st.def.visual.receiverHeight * 0.5 - checkAmt * 0.068;
      this.weaponRig.brassBulletMesh.isVisible = st.magAmmo > 0;
      reloadRollZ = -0.56 * checkAmt;
      reloadDipY = 0.035 * checkAmt;
    } else {
      this.weaponRig.magazineGroup.position.set(
        0,
        -st.def.visual.receiverHeight * 0.5,
        st.def.visual.isPistol ? -0.035 : 0.048
      );
    }

    // 5. Compute Final 3D Weapon Transform (Hip ↔ ADS ↔ Canted ↔ Sprint ↔ Wall Block + Harmonic Springs)
    const pSpring = this.wepPosSpring.update(dt);
    const rSpring = this.wepRotSpring.update(dt);

    const hipPos = new Vector3(
      0.135 - this.cantedAmount * 0.075 - this.sprintPoseAmount * 0.06,
      -0.145 -
        this.switchAnimTimer * 0.4 +
        reloadDipY +
        this.cantedAmount * 0.035 -
        this.sprintPoseAmount * 0.04 +
        this.wallBlockAmount * 0.08,
      0.32 - this.wallBlockAmount * 0.14
    );
    const adsPos = new Vector3(
      0,
      -this.weaponRig.sightAlignLocal.y,
      st.def.visual.isPistol ? 0.25 : 0.21
    );

    Vector3.LerpToRef(hipPos, adsPos, this.adsAmount, this.weaponRig.root.position);
    this.weaponRig.root.position.addInPlace(pSpring);

    const stressTremor = this.operatorStress > 0.35 ? (this.operatorStress - 0.35) * 0.015 : 0;
    const tremorX = Math.sin(elapsed * 19.3) * stressTremor;
    const tremorY = Math.cos(elapsed * 23.7) * stressTremor;

    this.weaponRig.root.rotation.set(
      this.freeAimY * (1 - this.adsAmount * 0.8) +
        reloadPitchX +
        tremorY +
        rSpring.x -
        this.sprintPoseAmount * 0.28 -
        this.wallBlockAmount * 0.65,
      this.freeAimX * (1 - this.adsAmount * 0.8) +
        tremorX +
        rSpring.y -
        this.sprintPoseAmount * 0.48,
      reloadRollZ + rSpring.z - this.cantedAmount * 0.68 + this.sprintPoseAmount * 0.25
    );

    // 6. Update 3D Laser Beam & World Hit Dot
    this.updateTacticalLaser();

    // 7. Handle Firing + Optional Smart Mobile Auto-Fire
    if (this.fireTimer > 0) {
      this.fireTimer -= dt;
    }

    let smartAutoTrigger = false;
    if (
      this.aimAssistEnabled &&
      !this.isReloading &&
      this.fireTimer <= 0 &&
      (this.lookTouchId !== null || this.fireTouchId !== null || this.moveTouchId !== null)
    ) {
      this.weaponRig.muzzlePoint.computeWorldMatrix(true);
      const muzzlePos = this.weaponRig.muzzlePoint.getAbsolutePosition();
      const barrelDir = this.weaponRig.muzzlePoint.forward.normalize();
      for (const bot of this.bots) {
        if (bot.isDead || bot.team === 'ALLY') continue;
        const botChest = bot.root.position.add(new Vector3(0, 1.25, 0));
        const dist = Vector3.Distance(muzzlePos, botChest);
        if (
          dist < 30 &&
          Vector3.Dot(barrelDir, botChest.subtract(muzzlePos).normalize()) > 0.9988
        ) {
          smartAutoTrigger = true;
          break;
        }
      }
    }

    if ((this.isFiring || smartAutoTrigger) && this.fireTimer <= 0) {
      this.tryFireWeapon();
    }
  }

  private updateTacticalLaser(): void {
    if (!this.weaponRig.hasLaser || this.isReloading || this.sprintPoseAmount > 0.5) {
      this.weaponRig.laserBeamMesh.isVisible = false;
      this.weaponRig.laserDotMesh.isVisible = false;
      return;
    }

    this.weaponRig.laserBeamMesh.isVisible = true;
    this.weaponRig.laserBeamMesh.computeWorldMatrix(true);
    const beamOrigin = this.weaponRig.laserBeamMesh.getAbsolutePosition().clone();
    const beamDir = this.weaponRig.root.forward.clone().normalize();

    const ray = new Ray(beamOrigin, beamDir, 65);
    const pick = this.scene.pickWithRay(ray, (m) => m.isPickable && m.isEnabled());

    if (pick && pick.hit && pick.pickedPoint) {
      this.weaponRig.laserBeamMesh.scaling.set(1, 1, pick.distance);
      this.weaponRig.laserDotMesh.position
        .copyFrom(pick.pickedPoint)
        .addInPlace(beamDir.scale(-0.02));
      this.weaponRig.laserDotMesh.isVisible = true;
    } else {
      this.weaponRig.laserBeamMesh.scaling.set(1, 1, 35);
      this.weaponRig.laserDotMesh.isVisible = false;
    }
  }

  // ==================== REACTIVE TARGETS & DRILL ====================
  private updateReactiveTargetsAndDrill(dt: number, elapsed: number): void {
    for (const rt of this.builtMap.reactiveTargets) {
      const targetAngle = rt.isDown ? Math.PI / 2 : 0;
      rt.pivot.rotation.x += (targetAngle - rt.pivot.rotation.x) * Math.min(1, dt * 12);

      if (rt.isDown && !rt.isDrillTarget) {
        rt.downTimer -= dt;
        if (rt.downTimer <= 0) {
          rt.isDown = false;
        }
      }

      if (rt.isMoving && !rt.isDown) {
        rt.root.position.x =
          rt.moveOriginX + Math.sin(elapsed * rt.moveSpeed + rt.movePhase) * rt.moveAmp;
      }
    }

    if (this.drillActive) {
      this.drillTimeLeft -= dt;
      const drillEl = document.getElementById('telemetry-drill');
      if (this.drillTimeLeft <= 0) {
        this.drillActive = false;
        const bonusRP = Math.round(this.drillScore * 0.5);
        this.awardReissadPoints(bonusRP);
        if (drillEl) {
          drillEl.textContent = `DRILL DONE: ${this.drillScore} PTS (+${bonusRP} RP)`;
        }
        this.audio.playRadioCommsBeep();
        this.showDiegeticBanner(
          `30s REFLEX DRILL COMPLETE: ${this.drillScore} PTS (+${bonusRP} RP)`,
          3500
        );
      } else if (drillEl) {
        drillEl.textContent = `DRILL: ${this.drillScore} PTS · ${this.drillTimeLeft.toFixed(1)}s`;
      }
    }
  }

  // ==================== TACTICAL AI BOTS ====================
  private updateBotsAI(dt: number): void {
    const wps = this.builtMap.botWaypoints;

    for (const bot of this.bots) {
      const mfMat = bot.muzzleFlash.material as StandardMaterial;
      if (mfMat && mfMat.alpha > 0) {
        mfMat.alpha = Math.max(0, mfMat.alpha - dt * 16);
      }

      if (bot.isDead) {
        bot.bodyPivot.rotation.x +=
          (bot.deathFallPitch - bot.bodyPivot.rotation.x) * Math.min(1, dt * 8.5);
        bot.bodyPivot.rotation.z +=
          (bot.deathFallRoll - bot.bodyPivot.rotation.z) * Math.min(1, dt * 8.5);
        bot.bodyPivot.position.y += (0.15 - bot.bodyPivot.position.y) * Math.min(1, dt * 8);

        if (bot.helmetDetached) {
          bot.helmetMesh.position.addInPlace(bot.helmetVel.scale(dt));
          bot.helmetVel.y -= 9.8 * dt;
          bot.helmetMesh.rotation.x += dt * 12;
        }

        bot.respawnTimer -= dt;
        if (bot.respawnTimer <= 0 && wps.length > 0) {
          bot.respawn(wps[Math.floor(Math.random() * wps.length)]);
        }
        continue;
      }

      if (bot.flashedTimer > 0) {
        bot.flashedTimer -= dt;
        bot.leftArm.rotation.x = 2.2;
        bot.bodyPivot.rotation.z = Math.sin(performance.now() * 0.012) * 0.22;
        continue;
      } else {
        bot.leftArm.rotation.x = 0;
      }

      if (bot.stumbleTimer > 0) {
        bot.stumbleTimer -= dt;
        bot.root.position.addInPlace(bot.stumbleDir.scale(dt * 2.1));
        bot.bodyPivot.rotation.z = Math.sin(bot.stumbleTimer * 18) * 0.35;
        bot.bodyPivot.rotation.x = -0.28;
        continue;
      } else {
        bot.bodyPivot.rotation.x += (0 - bot.bodyPivot.rotation.x) * Math.min(1, dt * 8);
        bot.bodyPivot.rotation.z +=
          (bot.leanAngle - bot.bodyPivot.rotation.z) * Math.min(1, dt * 8);
      }

      let targetPos: Vector3 | null = null;
      let targetIsPlayer = false;

      if (bot.team === 'ALLY') {
        let closestDist = 45;
        for (const other of this.bots) {
          if (other.isDead || other.team === 'ALLY') continue;
          const d = Vector3.Distance(bot.root.position, other.root.position);
          if (d < closestDist) {
            closestDist = d;
            targetPos = other.root.position;
          }
        }
      } else {
        const distToPlayer = Vector3.Distance(bot.root.position, this.playerPos);
        const playerInCombatZone =
          this.currentMapId !== 'SHOOTING_RANGE' ||
          this.playerPos.x > 7.5 ||
          bot.alertTimer > 0;

        if (playerInCombatZone && distToPlayer < 42) {
          targetPos = this.playerPos;
          targetIsPlayer = true;
        }
      }

      let canSeeTarget = false;
      if (targetPos) {
        const eyeOrigin = bot.root.position.add(new Vector3(0, 1.5, 0));
        const targetEye = targetPos.add(new Vector3(0, 1.3, 0));
        const dist = Vector3.Distance(eyeOrigin, targetEye);
        const dir = targetEye.subtract(eyeOrigin).normalize();

        const ray = new Ray(eyeOrigin, dir, dist - 0.35);
        const wallHit = this.scene.pickWithRay(ray, (m) => !!m.metadata?.isWorldGeometry);
        canSeeTarget = !wallHit || !wallHit.hit;
      }

      if (canSeeTarget && targetPos) {
        bot.state = 'ENGAGE';
        const dx = targetPos.x - bot.root.position.x;
        const dz = targetPos.z - bot.root.position.z;
        const desiredYaw = Math.atan2(dx, dz);
        bot.root.rotation.y += (desiredYaw - bot.root.rotation.y) * Math.min(1, dt * 8);

        if (bot.team === 'ZOMBIE') {
          const moveDir = new Vector3(dx, 0, dz).normalize();
          bot.root.position.addInPlace(moveDir.scale(dt * 4.8));
          this.animateBotLegs(bot, dt, 12);
          if (Vector3.Distance(bot.root.position, this.playerPos) < 1.65 && bot.fireCooldown <= 0) {
            bot.fireCooldown = 1.1;
            this.applyDamageToPlayer(18, moveDir);
          }
        } else {
          bot.strafeTimer -= dt;
          if (bot.strafeTimer <= 0) {
            bot.strafeTimer = 1.2 + Math.random() * 1.4;
            bot.strafeDir = Math.random() > 0.5 ? 1 : -1;
            bot.leanAngle = (Math.random() - 0.5) * 0.28;
          }

          if (bot.behavior !== 'STATIONARY_GUARD') {
            const rightSide = new Vector3(Math.cos(desiredYaw), 0, -Math.sin(desiredYaw));
            bot.root.position.addInPlace(rightSide.scale(bot.strafeDir * dt * 2.0));
            this.animateBotLegs(bot, dt, 6.5);
          }

          bot.fireCooldown -= dt;
          if (bot.fireCooldown <= 0) {
            bot.fireCooldown = 0.25 + Math.random() * 0.38;
            this.botFireShot(bot, targetPos, targetIsPlayer);
          }
        }
      } else {
        bot.leanAngle = 0;
        if (bot.behavior === 'STATIONARY_GUARD') {
          this.animateBotLegs(bot, dt, 0);
          continue;
        }

        if (bot.alertTimer > 0) {
          bot.alertTimer -= dt;
          bot.targetWaypoint.copyFrom(bot.alertPos);
        } else if (Vector3.Distance(bot.root.position, bot.targetWaypoint) < 1.5 && wps.length > 0) {
          bot.targetWaypoint.copyFrom(wps[Math.floor(Math.random() * wps.length)]);
        }

        const toWp = bot.targetWaypoint.subtract(bot.root.position);
        toWp.y = 0;
        if (toWp.lengthSquared() > 0.2) {
          toWp.normalize();
          const desiredYaw = Math.atan2(toWp.x, toWp.z);
          bot.root.rotation.y += (desiredYaw - bot.root.rotation.y) * Math.min(1, dt * 5);
          bot.root.position.addInPlace(toWp.scale(dt * 2.7));
          this.animateBotLegs(bot, dt, 7.5);
        }
      }
    }
  }

  private animateBotLegs(bot: TacticalBot, dt: number, speed: number): void {
    if (speed <= 0.1) {
      bot.leftLeg.rotation.x += (0 - bot.leftLeg.rotation.x) * Math.min(1, dt * 8);
      bot.rightLeg.rotation.x += (0 - bot.rightLeg.rotation.x) * Math.min(1, dt * 8);
      return;
    }
    bot.walkCycle += dt * speed;
    bot.leftLeg.rotation.x = Math.sin(bot.walkCycle) * 0.55;
    bot.rightLeg.rotation.x = -Math.sin(bot.walkCycle) * 0.55;
  }

  private botFireShot(bot: TacticalBot, targetPos: Vector3, targetIsPlayer: boolean): void {
    const mfMat = bot.muzzleFlash.material as StandardMaterial;
    if (mfMat) mfMat.alpha = 0.92;

    const dist = Vector3.Distance(bot.root.position, this.playerPos);
    const toBot = bot.root.position.subtract(this.playerPos).normalize();
    const camRight = new Vector3(Math.cos(this.playerYaw), 0, -Math.sin(this.playerYaw));
    const pan = Vector3.Dot(camRight, toBot);

    this.audio.playGunshot('5.56x45mm', false, dist, pan);

    if (targetIsPlayer) {
      this.audio.playBulletCrack(pan);
      this.operatorStress = Math.min(1.0, this.operatorStress + 0.13);
      this.recoilChromaticSpike = Math.min(1.0, this.recoilChromaticSpike + 0.32);

      const hitChance = Math.max(0.08, 0.32 - dist * 0.006);
      if (Math.random() < hitChance) {
        this.applyDamageToPlayer(14, toBot.scale(-1));
      }
    } else {
      for (const other of this.bots) {
        if (
          other.id !== bot.id &&
          !other.isDead &&
          Vector3.Distance(other.root.position, targetPos) < 1.5
        ) {
          if (Math.random() < 0.35) {
            other.applyHit(28, 'TORSO', new Vector3(0, 0, 1));
          }
          break;
        }
      }
    }
  }

  private applyDamageToPlayer(dmg: number, dir: Vector3): void {
    if (this.currentMapId === 'SHOOTING_RANGE' && this.playerPos.x < 7.5) {
      return;
    }

    this.playerHealth = Math.max(0, this.playerHealth - dmg);
    this.damageFlash = Math.min(1.0, this.damageFlash + 0.72);
    this.operatorStress = Math.min(1.0, this.operatorStress + 0.26);
    this.camRecoilSpring.impulseXYZ(-0.45, dir.x * 0.4, (Math.random() - 0.5) * 0.5);

    if (navigator.vibrate) navigator.vibrate([35, 25, 55]);

    if (this.playerHealth <= 0) {
      this.showDiegeticBanner('OPERATOR DOWN — RESPAWNING', 2200);
      this.playerHealth = 100;
      this.operatorStress = 0.1;
      this.playerPos.copyFrom(this.builtMap.playerSpawn);
      this.playerCollider.position.copyFrom(this.playerPos);
    }
  }

  // ==================== GRENADES & VISUAL POOLS ====================
  private updateGrenadesAndPools(dt: number): void {
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i];
      g.vel.y -= 14.5 * dt;
      g.mesh.position.addInPlace(g.vel.scale(dt));

      if (g.mesh.position.y < 0.06) {
        g.mesh.position.y = 0.06;
        g.vel.y = Math.abs(g.vel.y) * 0.45;
        g.vel.x *= 0.7;
        g.vel.z *= 0.7;
      }

      g.fuseTimer -= dt;
      if (g.fuseTimer <= 0) {
        const gPos = g.mesh.position.clone();
        const distPlayer = Vector3.Distance(gPos, this.playerPos);
        this.audio.playExplosion(g.isFlashbang, distPlayer);
        this.spawnImpactParticles(
          gPos,
          g.isFlashbang ? new Color3(1, 1, 1) : new Color3(1, 0.45, 0.1),
          22
        );

        if (g.isFlashbang) {
          if (distPlayer < 16) {
            this.flashbangBlind = Math.min(1.0, (1 - distPlayer / 18) * 1.25);
            this.operatorStress = Math.min(1.0, this.operatorStress + 0.42);
          }
          for (const bot of this.bots) {
            const d = Vector3.Distance(bot.root.position, gPos);
            if (d < 15) bot.applyFlashbang(1 - d / 15);
          }
        } else {
          for (const bot of this.bots) {
            if (bot.isDead) continue;
            const d = Vector3.Distance(bot.root.position, gPos);
            if (d < 10) {
              const dmg = Math.round(150 * (1 - d / 10));
              const res = bot.applyHit(dmg, 'TORSO', bot.root.position.subtract(gPos).normalize());
              if (res.killed) {
                this.totalKills++;
                this.awardReissadPoints(110);
                this.addKillfeedEntry(`${bot.callsign} KIA [M67 FRAG] +110 RP`, '#f59e0b');
              }
            }
          }
        }

        g.mesh.dispose();
        this.activeGrenades.splice(i, 1);
      }
    }

    for (let i = this.ejectedBrass.length - 1; i >= 0; i--) {
      const b = this.ejectedBrass[i];
      b.vel.y -= 9.8 * dt;
      b.mesh.position.addInPlace(b.vel.scale(dt));
      b.mesh.rotation.x += b.rotVel.x * dt;
      b.mesh.rotation.z += b.rotVel.z * dt;
      if (b.mesh.position.y < 0.015) {
        b.mesh.position.y = 0.015;
        b.vel.y = Math.abs(b.vel.y) * 0.35;
        b.vel.x *= 0.6;
        b.vel.z *= 0.6;
      }
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.dispose();
        this.ejectedBrass.splice(i, 1);
      }
    }

    for (let i = this.impactParticles.length - 1; i >= 0; i--) {
      const p = this.impactParticles[i];
      p.vel.y -= 9.8 * dt;
      p.mesh.position.addInPlace(p.vel.scale(dt));
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.dispose();
        this.impactParticles.splice(i, 1);
      }
    }
  }

  private updatePhysiologyAndStress(dt: number, elapsed: number): void {
    this.operatorStress = Math.max(0.05, this.operatorStress - dt * 0.055);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    this.flashbangBlind = Math.max(0, this.flashbangBlind - dt * 0.36);

    if (this.playerHealth < 100 && this.damageFlash <= 0.05) {
      this.playerHealth = Math.min(100, this.playerHealth + dt * 4.5);
    }

    this.audio.updateStressAudio(this.operatorStress, elapsed);

    const hpText = document.getElementById('hud-hp-text');
    const hpBar = document.getElementById('hud-hp-bar');
    const stressBar = document.getElementById('hud-stress-bar');
    const stressState = document.getElementById('hud-stress-state');

    if (hpText) hpText.textContent = `${Math.ceil(this.playerHealth)} HP`;
    if (hpBar) hpBar.style.width = `${this.playerHealth}%`;
    if (stressBar) {
      const pct = Math.round(this.operatorStress * 100);
      stressBar.style.width = `${pct}%`;
      stressBar.style.background = pct > 48 ? '#ef4444' : '#f59e0b';
    }
    if (stressState) {
      const bpm = Math.round(68 + this.operatorStress * 92);
      stressState.textContent =
        this.operatorStress > 0.48 ? `${bpm} BPM · STRESSED` : `${bpm} BPM · CALM`;
    }
  }

  // ==================== UI & HUD UPDATES ====================
  private updateClockStamp(): void {
    const el = document.getElementById('axon-clock');
    if (!el) return;
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    el.textContent = `2026-10-19 ${hh}:${mm}:${ss} UTC · ${Math.round(this.fpsAvg)}FPS · ${
      this.postProcess.sensorMode
    }`;
  }

  private updateAxonHeader(): void {
    const el = document.getElementById('axon-mode-line');
    if (!el) return;
    const mapDef = BODYCAM_MAPS.find((m) => m.id === this.currentMapId);
    const modeDef = BODYCAM_MODES.find((m) => m.id === this.currentModeId);
    el.textContent = `${mapDef?.tag} · ${modeDef?.id} · ${this.reissadPoints.toLocaleString()} RP`;
  }

  private updateHUDWeaponCard(): void {
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);
    const nameEl = document.getElementById('hud-weapon-name');
    const ammoEl = document.getElementById('hud-ammo-estimate');

    if (nameEl) {
      nameEl.textContent = `${st.def.name}`;
    }
    if (ammoEl) {
      const modeName = st.def.fireModes[st.fireModeIndex] || 'AUTO';
      const total = st.magAmmo + st.chambered;
      const ratio = st.magAmmo / stats.magCap;
      const feel =
        total === 0
          ? 'EMPTY [0]'
          : ratio > 0.8
          ? `FULL [~${total}]`
          : ratio > 0.4
          ? `HALF [~${total}]`
          : `LOW [~${total}]`;
      ammoEl.textContent = `${feel} · ${st.spareMags} MAGS · ${modeName}`;
    }
  }

  private updateTelemetryAccuracy(): void {
    const el = document.getElementById('telemetry-accuracy');
    if (!el) return;
    const pct = this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    el.textContent = `ACC: ${pct}% (${this.shotsHit}/${this.shotsFired}) · HS: ${this.headshotsCount} · KILLS: ${this.totalKills}`;
  }

  // ==================== INPUT BINDINGS ====================
  private bindInputs(): void {
    window.addEventListener('keydown', (e) => {
      this.audio.init();
      this.keys[e.code] = true;

      if (e.code === 'KeyR') this.startReload();
      if (e.code === 'KeyM') this.triggerMagCheck();
      if (e.code === 'KeyF') this.toggleFlashlight();
      if (e.code === 'KeyN') this.cycleOpticSensorMode();
      if (e.code === 'KeyX') this.toggleCantedStance();
      if (e.code === 'KeyC') {
        this.isCrouching = !this.isCrouching;
        document.getElementById('tbtn-crouch')?.classList.toggle('active', this.isCrouching);
      }
      if (e.code === 'Digit1') this.equipWeaponSlot('PRIMARY');
      if (e.code === 'Digit2') this.equipWeaponSlot('SECONDARY');
      if (e.code === 'KeyB') {
        const st = this.getActiveWeaponState();
        st.fireModeIndex = (st.fireModeIndex + 1) % st.def.fireModes.length;
        this.audio.playUIClick(1300);
        this.updateHUDWeaponCard();
      }
      if (e.code === 'KeyG') this.throwGrenade();
      if (e.code === 'KeyV') this.toggleGadgetDeploy();
      if (e.code === 'KeyH') this.togglePureDiegeticHUD();
      if (e.code === 'Space' && this.gadgets.activeGadget) {
        e.preventDefault();
        this.detonateGadgetPayload();
      }
      if (e.code === 'Tab' || e.code === 'Escape') {
        e.preventDefault();
        this.toggleTabletModal();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });

    this.canvas.addEventListener('mousedown', (e) => {
      this.audio.init();
      const modal = document.getElementById('tactical-tablet-modal');
      if (modal?.classList.contains('open')) return;

      if (document.pointerLockElement !== this.canvas && this.canvas.requestPointerLock) {
        this.canvas.requestPointerLock();
      }
      if (e.button === 0) {
        this.isFiring = true;
        this.semiShotLatched = false;
      } else if (e.button === 2) {
        this.isADS = !this.isADS;
        if (this.isADS) this.isCanted = false;
        document.getElementById('tbtn-ads')?.classList.toggle('active', this.isADS);
        document.getElementById('tbtn-canted')?.classList.remove('active');
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.isFiring = false;
        this.semiShotLatched = false;
      }
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.rawLookAccum.x += e.movementX;
        this.rawLookAccum.y += e.movementY;
      } else if (e.buttons === 1 && this.moveTouchId === null) {
        this.rawLookAccum.x += e.movementX * 1.25;
        this.rawLookAccum.y += e.movementY * 1.25;
      }
    });

    // ==================== MOBILE MULTI-TOUCH DUAL-STICK & CLAW ENGINE ====================
    const moveZone = document.getElementById('touch-move-zone')!;
    const joystickBase = document.getElementById('joystick-base')!;
    const joystickStick = document.getElementById('joystick-stick')!;
    const lookZone = document.getElementById('touch-look-zone')!;

    moveZone.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.audio.init();
        const t = e.changedTouches[0];
        this.moveTouchId = t.identifier;
        this.moveTouchOrigin.set(t.clientX, t.clientY);
        joystickBase.style.left = `${Math.max(14, t.clientX - 52)}px`;
        joystickBase.style.bottom = `${Math.max(14, window.innerHeight - t.clientY - 52)}px`;
      },
      { passive: false }
    );

    moveZone.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier === this.moveTouchId) {
            const dx = t.clientX - this.moveTouchOrigin.x;
            const dy = t.clientY - this.moveTouchOrigin.y;
            const maxR = 46;
            const dist = Math.min(maxR, Math.hypot(dx, dy));
            const angle = Math.atan2(dy, dx);
            const sx = Math.cos(angle) * dist;
            const sy = Math.sin(angle) * dist;
            joystickStick.style.transform = `translate(${sx}px, ${sy}px)`;

            this.touchMoveVec.set(sx / maxR, -sy / maxR);
            this.touchSprinting = -sy / maxR > 0.78;
          }
        }
      },
      { passive: false }
    );

    const endMoveTouch = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.moveTouchId) {
          this.moveTouchId = null;
          this.touchMoveVec.set(0, 0);
          this.touchSprinting = false;
          joystickStick.style.transform = 'translate(0px, 0px)';
        }
      }
    };
    moveZone.addEventListener('touchend', endMoveTouch);
    moveZone.addEventListener('touchcancel', endMoveTouch);

    lookZone.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.audio.init();
        const t = e.changedTouches[0];
        this.lookTouchId = t.identifier;
        this.lookTouchLast.set(t.clientX, t.clientY);
      },
      { passive: false }
    );

    lookZone.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
          const t = e.changedTouches[i];
          if (t.identifier === this.lookTouchId) {
            this.rawLookAccum.x += (t.clientX - this.lookTouchLast.x) * 1.55;
            this.rawLookAccum.y += (t.clientY - this.lookTouchLast.y) * 1.55;
            this.lookTouchLast.set(t.clientX, t.clientY);
          }
        }
      },
      { passive: false }
    );

    const endLookTouch = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === this.lookTouchId) {
          this.lookTouchId = null;
        }
      }
    };
    lookZone.addEventListener('touchend', endLookTouch);
    lookZone.addEventListener('touchcancel', endLookTouch);

    // Primary Right-Thumb Fire Button (Supports Drag-While-Firing!)
    const fireRightBtn = document.getElementById('tbtn-fire-right')!;
    fireRightBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.audio.init();
      this.isFiring = true;
      this.semiShotLatched = false;
      this.fireTouchId = e.pointerId;
      this.fireTouchLast.set(e.clientX, e.clientY);
      fireRightBtn.setPointerCapture(e.pointerId);
    });
    fireRightBtn.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.fireTouchId) {
        this.rawLookAccum.x += (e.clientX - this.fireTouchLast.x) * 1.45;
        this.rawLookAccum.y += (e.clientY - this.fireTouchLast.y) * 1.45;
        this.fireTouchLast.set(e.clientX, e.clientY);
      }
    });
    const releaseRightFire = (e: PointerEvent) => {
      if (e.pointerId === this.fireTouchId) {
        this.isFiring = false;
        this.semiShotLatched = false;
        this.fireTouchId = null;
      }
    };
    fireRightBtn.addEventListener('pointerup', releaseRightFire);
    fireRightBtn.addEventListener('pointercancel', releaseRightFire);

    const fireLeftBtn = document.getElementById('tbtn-fire-left')!;
    fireLeftBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.audio.init();
      this.isFiring = true;
      this.semiShotLatched = false;
    });
    fireLeftBtn.addEventListener('pointerup', () => {
      this.isFiring = false;
      this.semiShotLatched = false;
    });

    const bindTap = (id: string, fn: () => void) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.audio.init();
        fn();
      });
    };

    bindTap('tbtn-ads', () => {
      this.isADS = !this.isADS;
      if (this.isADS) this.isCanted = false;
      document.getElementById('tbtn-ads')?.classList.toggle('active', this.isADS);
      document.getElementById('tbtn-canted')?.classList.remove('active');
    });
    bindTap('tbtn-canted', () => this.toggleCantedStance());
    bindTap('tbtn-reload', () => this.startReload());
    bindTap('tbtn-magcheck', () => this.triggerMagCheck());
    bindTap('tbtn-crouch', () => {
      this.isCrouching = !this.isCrouching;
      document.getElementById('tbtn-crouch')?.classList.toggle('active', this.isCrouching);
    });
    bindTap('tbtn-swap', () => {
      this.equipWeaponSlot(this.activeSlot === 'PRIMARY' ? 'SECONDARY' : 'PRIMARY');
    });
    bindTap('tbtn-grenade', () => this.throwGrenade());
    bindTap('tbtn-drone', () => this.toggleGadgetDeploy());
    bindTap('tbtn-light', () => this.toggleFlashlight());
    bindTap('tbtn-lean-l', () => {
      this.leanTarget = this.leanTarget === -1 ? 0 : -1;
      document.getElementById('tbtn-lean-l')?.classList.toggle('active', this.leanTarget === -1);
      document.getElementById('tbtn-lean-r')?.classList.remove('active');
    });
    bindTap('tbtn-lean-r', () => {
      this.leanTarget = this.leanTarget === 1 ? 0 : 1;
      document.getElementById('tbtn-lean-r')?.classList.toggle('active', this.leanTarget === 1);
      document.getElementById('tbtn-lean-l')?.classList.remove('active');
    });

    window.addEventListener('deviceorientation', (e) => {
      if (!this.gyroEnabled || e.gamma === null || e.beta === null) return;
      this.rawLookAccum.x += e.gamma * 0.04;
      this.rawLookAccum.y += (e.beta - 45) * 0.03;
    });
  }

  private toggleCantedStance(): void {
    this.isCanted = !this.isCanted;
    if (this.isCanted) this.isADS = false;
    document.getElementById('tbtn-canted')?.classList.toggle('active', this.isCanted);
    document.getElementById('tbtn-ads')?.classList.remove('active');
    this.audio.playUIClick(1350);
    this.showDiegeticBanner(
      this.isCanted ? 'CANTED LASER POINT-SHOOTING STANCE' : 'STANDARD SIGHT STANCE',
      1400
    );
  }

  private toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.weaponRig.flashlightSpot.intensity =
      this.flashlightOn && this.weaponRig.hasFlashlight ? 3.5 : 0;
    document.getElementById('tbtn-light')?.classList.toggle('active', this.flashlightOn);
    this.audio.playUIClick(1400);
  }

  private cycleOpticSensorMode(): void {
    const nextMode = this.postProcess.cycleSensorMode();
    const lbl = document.getElementById('lbl-sensor-mode');
    if (lbl) lbl.textContent = `OPTIC: ${nextMode}`;
    document.getElementById('btn-toggle-nvg')?.classList.toggle('active', nextMode !== 'CMOS');
    this.audio.playUIClick(1750);
    this.showDiegeticBanner(
      nextMode === 'NVG'
        ? 'AN/PVS-31 GREEN PHOSPHOR NIGHT VISION'
        : nextMode === 'THERMAL'
        ? 'FLIR WHITE-HOT THERMAL IMAGING'
        : 'AXON BODY 4 STANDARD CMOS SENSOR',
      1800
    );
  }

  private togglePureDiegeticHUD(): void {
    this.pureDiegeticHud = !this.pureDiegeticHud;
    const tel = document.getElementById('hud-telemetry-row');
    const bot = document.getElementById('hud-bottom-cluster');
    if (tel) tel.style.display = this.pureDiegeticHud ? 'none' : 'block';
    if (bot) bot.style.display = this.pureDiegeticHud ? 'none' : 'flex';
    document.getElementById('btn-pure-bodycam')?.classList.toggle('active', this.pureDiegeticHud);
    this.showDiegeticBanner(
      this.pureDiegeticHud
        ? 'PURE BODYCAM MODE: ON (NO HUD — PRESS [M] FOR MAG CHECK)'
        : 'TACTICAL TELEMETRY RESTORED'
    );
  }

  private toggleTabletModal(): void {
    const modal = document.getElementById('tactical-tablet-modal');
    if (!modal) return;
    const isOpen = modal.classList.toggle('open');
    if (isOpen && document.pointerLockElement) {
      document.exitPointerLock();
    }
    this.audio.playUIClick(isOpen ? 1250 : 900);
  }

  // ==================== UI & TACTICAL TABLET BINDINGS ====================
  private bindUI(): void {
    document
      .getElementById('btn-open-tablet')
      ?.addEventListener('click', () => this.toggleTabletModal());
    document
      .getElementById('btn-close-tablet')
      ?.addEventListener('click', () => this.toggleTabletModal());

    document
      .getElementById('btn-start-drill')
      ?.addEventListener('click', () => this.startReflexDrill());

    document.getElementById('btn-spawn-bots')?.addEventListener('click', () => {
      const nextCount = this.bots.length >= 8 ? 4 : this.bots.length + 2;
      this.spawnBotsForCurrentMode(nextCount);
      this.showDiegeticBanner(`SPAWNED ${nextCount} TACTICAL AI OPERATORS`);
    });

    document.getElementById('btn-zone-jump')?.addEventListener('click', () => {
      const inKillhouse = this.playerPos.x > 8;
      if (inKillhouse) {
        this.playerPos.set(-2.5, 0, -3.2);
        this.playerCollider.position.copyFrom(this.playerPos);
        this.playerYaw = 0;
        this.showDiegeticBanner('FIRING LINE — 10m TO 75m CALIBRATED LANES');
      } else {
        this.playerPos.set(14.5, 0, -1.5);
        this.playerCollider.position.copyFrom(this.playerPos);
        this.playerYaw = 0;
        this.showDiegeticBanner('BREACHED CQB KILLHOUSE — LIVE AI OPERATORS');
      }
      const lbl = document.getElementById('lbl-zone-jump');
      if (lbl) lbl.textContent = inKillhouse ? 'KILLHOUSE' : 'RANGE LANES';
    });

    document
      .getElementById('btn-toggle-nvg')
      ?.addEventListener('click', () => this.cycleOpticSensorMode());

    document.getElementById('btn-toggle-assist')?.addEventListener('click', (e) => {
      this.aimAssistEnabled = !this.aimAssistEnabled;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.aimAssistEnabled);
      const lbl = document.getElementById('lbl-assist-mode');
      if (lbl) lbl.textContent = `ASSIST: ${this.aimAssistEnabled ? 'ON' : 'OFF'}`;
    });

    document
      .getElementById('btn-pure-bodycam')
      ?.addEventListener('click', () => this.togglePureDiegeticHUD());

    document.getElementById('btn-drone-flightmode')?.addEventListener('click', () => {
      this.droneFlightMode = this.droneFlightMode === 'CASUAL' ? 'ACRO' : 'CASUAL';
      this.gadgets.droneFlightMode = this.droneFlightMode;
      this.updateDroneOSD();
    });
    document
      .getElementById('btn-drone-detonate')
      ?.addEventListener('click', () => this.detonateGadgetPayload());
    document
      .getElementById('btn-drone-recall')
      ?.addEventListener('click', () => this.toggleGadgetDeploy());

    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const tabId = (btn as HTMLElement).dataset.tab;
        ['loadout', 'mission', 'optics', 'intel'].forEach((id) => {
          const panel = document.getElementById(`tab-content-${id}`);
          if (panel) panel.style.display = id === tabId ? 'grid' : 'none';
        });
        this.audio.playUIClick(1150);
      });
    });

    document.getElementById('slider-fisheye')?.addEventListener('input', (e) => {
      this.postProcess.fisheyeStrength = parseFloat((e.target as HTMLInputElement).value);
    });
    document.getElementById('slider-chromatic')?.addEventListener('input', (e) => {
      this.postProcess.chromaticBase = parseFloat((e.target as HTMLInputElement).value);
    });
    document.getElementById('slider-grain')?.addEventListener('input', (e) => {
      this.postProcess.grainStrength = parseFloat((e.target as HTMLInputElement).value);
    });
    document.getElementById('slider-volume')?.addEventListener('input', (e) => {
      this.audio.setVolume(parseFloat((e.target as HTMLInputElement).value));
    });
    document.getElementById('slider-sens')?.addEventListener('input', (e) => {
      this.lookSensitivity = parseFloat((e.target as HTMLInputElement).value);
    });

    document.getElementById('opt-toggle-touchhud')?.addEventListener('click', (e) => {
      const layer = document.getElementById('mobile-touch-layer')!;
      const hidden = layer.style.display === 'none';
      layer.style.display = hidden ? 'block' : 'none';
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', hidden);
      btn.textContent = `ON-SCREEN MOBILE TOUCH CONTROLS: ${hidden ? 'VISIBLE' : 'HIDDEN'}`;
    });

    document.getElementById('opt-toggle-gyro')?.addEventListener('click', (e) => {
      this.gyroEnabled = !this.gyroEnabled;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.gyroEnabled);
      btn.textContent = `MOBILE GYROSCOPE TILT AIMING: ${this.gyroEnabled ? 'ON' : 'OFF'}`;
    });

    document.getElementById('opt-toggle-centerdot')?.addEventListener('click', (e) => {
      const dot = document.getElementById('freeaim-reticle')!;
      const visible = dot.style.display === 'block';
      dot.style.display = visible ? 'none' : 'block';
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', !visible);
      btn.textContent = `FAINT CENTER POINT-AIM DOT: ${!visible ? 'ON' : 'OFF (TRUE BODYCAM)'}`;
    });
  }

  private populateTabletUI(filterCat = 'ALL'): void {
    const catContainer = document.getElementById('weapon-cat-filters');
    if (catContainer && !catContainer.dataset.bound) {
      catContainer.dataset.bound = '1';
      catContainer.querySelectorAll('.attach-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          catContainer.querySelectorAll('.attach-chip').forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
          this.populateTabletUI((chip as HTMLElement).dataset.cat || 'ALL');
        });
      });
    }

    const weaponListEl = document.getElementById('tablet-weapon-list')!;
    weaponListEl.innerHTML = '';
    const activeWep = this.getActiveWeaponState().def;

    const filtered = BODYCAM_WEAPONS.filter(
      (w) => filterCat === 'ALL' || w.category === filterCat
    );

    filtered.forEach((w) => {
      const card = document.createElement('div');
      card.className = `weapon-card ${w.id === activeWep.id ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="w-name">${w.name}</div>
        <div class="w-sub">${w.caliber} · ${w.rpm} RPM</div>
        <div class="w-sub" style="color:#fde68a">${w.damage} DMG · ${
        w.rpCost === 0 ? 'FREE' : w.rpCost.toLocaleString() + ' RP'
      }</div>
      `;
      card.addEventListener('click', () => {
        const targetSlot = w.slot;
        const runtime = targetSlot === 'PRIMARY' ? this.primaryState : this.secondaryState;
        runtime.def = w;
        runtime.magAmmo = w.magCapacity;
        runtime.chambered = 1;
        runtime.spareMags = w.spareMags;
        runtime.fireModeIndex = 0;
        this.equipWeaponSlot(targetSlot);
        this.populateTabletUI(filterCat);
        this.audio.playReloadStep('boltSlap');
      });
      weaponListEl.appendChild(card);
    });

    const attachContainer = document.getElementById('tablet-attachment-slots')!;
    attachContainer.innerHTML = '';
    const st = this.getActiveWeaponState();
    const slots: AttachmentSlot[] = ['optic', 'muzzle', 'grip', 'tactical', 'magazine'];

    slots.forEach((slot) => {
      const group = document.createElement('div');
      group.className = 'attach-slot-group';
      group.innerHTML = `<div class="attach-slot-label">${slot.toUpperCase()} ATTACHMENT</div>`;
      const opts = document.createElement('div');
      opts.className = 'attach-options';

      BODYCAM_ATTACHMENTS.filter((a) => a.slot === slot).forEach((att) => {
        const chip = document.createElement('button');
        chip.className = `attach-chip ${st.attachments[slot]?.id === att.id ? 'selected' : ''}`;
        chip.textContent = att.name;
        chip.addEventListener('click', () => {
          st.attachments[slot] = att;
          this.equipWeaponSlot(this.activeSlot);
          this.populateTabletUI(filterCat);
          this.audio.playUIClick(1350);
        });
        opts.appendChild(chip);
      });
      group.appendChild(opts);
      attachContainer.appendChild(group);
    });

    const titleEl = document.getElementById('inspector-weapon-title')!;
    const descEl = document.getElementById('inspector-weapon-desc')!;
    const barsEl = document.getElementById('inspector-stat-bars')!;

    titleEl.textContent = `${st.def.name} — ${st.def.realCounterpart}`;
    descEl.textContent = st.def.description;

    const cStats = this.getComputedWeaponStats(st);
    const statRows = [
      { label: '1. Stopping Power', val: Math.min(100, st.def.damage * (st.def.pellets || 1) * 0.85) },
      { label: '2. Cyclic Rate (RPM)', val: Math.min(100, (st.def.rpm / 1200) * 100) },
      { label: '3. ADS Speed', val: Math.min(100, (cStats.adsSpeed / 10) * 100) },
      { label: '4. Reload Speed (Calm)', val: Math.min(100, (3.2 / cStats.reloadCalm) * 65) },
      { label: '5. Vertical Recoil Control', val: Math.max(10, 100 - cStats.vRecoil * 1100) },
      { label: '6. Horizontal Stability', val: Math.max(10, 100 - cStats.hRecoil * 1800) },
      { label: '7. Point-Fire Precision', val: Math.max(10, 100 - cStats.spread * 1200) },
      { label: `8. Capacity (${cStats.magCap} Rnds)`, val: Math.min(100, (cStats.magCap / 40) * 100) },
    ];

    barsEl.innerHTML = statRows
      .map(
        (r) => `
      <div class="stat-row">
        <span>${r.label}</span>
        <div class="stat-bar-track">
          <div class="stat-bar-fill" style="width:${Math.round(r.val)}%"></div>
        </div>
      </div>
    `
      )
      .join('');

    const fragBtn = document.getElementById('select-gren-frag');
    const flashBtn = document.getElementById('select-gren-flash');
    fragBtn?.addEventListener('click', () => {
      this.selectedGrenade = 'FRAG';
      this.grenadesRemaining = 3;
      fragBtn.classList.add('selected');
      flashBtn?.classList.remove('selected');
    });
    flashBtn?.addEventListener('click', () => {
      this.selectedGrenade = 'FLASH';
      this.grenadesRemaining = 3;
      flashBtn.classList.add('selected');
      fragBtn?.classList.remove('selected');
    });

    const droneBtn = document.getElementById('select-gad-drone');
    const rcBtn = document.getElementById('select-gad-rccar');
    droneBtn?.addEventListener('click', () => {
      this.selectedGadget = 'FPV_DRONE';
      droneBtn.classList.add('selected');
      rcBtn?.classList.remove('selected');
    });
    rcBtn?.addEventListener('click', () => {
      this.selectedGadget = 'RC_CAR';
      rcBtn.classList.add('selected');
      droneBtn?.classList.remove('selected');
    });

    const mapListEl = document.getElementById('tablet-map-list')!;
    mapListEl.innerHTML = '';
    BODYCAM_MAPS.forEach((m) => {
      const card = document.createElement('div');
      card.className = `weapon-card ${m.id === this.currentMapId ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="w-name">${m.name} <span style="color:#fde68a">[${m.tag}]</span></div>
        <div class="w-sub">${m.description}</div>
      `;
      card.addEventListener('click', () => {
        this.loadMap(m.id);
        this.spawnBotsForCurrentMode();
        this.populateTabletUI(filterCat);
        this.showDiegeticBanner(`DEPLOYED TO ${m.name.toUpperCase()}`);
      });
      mapListEl.appendChild(card);
    });

    const modeListEl = document.getElementById('tablet-mode-list')!;
    modeListEl.innerHTML = '';
    BODYCAM_MODES.forEach((mode) => {
      const card = document.createElement('div');
      card.className = `weapon-card ${mode.id === this.currentModeId ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="w-name">${mode.name} <span style="color:#86efac">(${mode.rpMultiplier})</span></div>
        <div class="w-sub">${mode.description}</div>
      `;
      card.addEventListener('click', () => {
        this.currentModeId = mode.id;
        this.spawnBotsForCurrentMode(mode.defaultBots);
        this.updateAxonHeader();
        this.populateTabletUI(filterCat);
        this.showDiegeticBanner(`GAME MODE: ${mode.name.toUpperCase()}`);
      });
      modeListEl.appendChild(card);
    });

    const addBotBtn = document.getElementById('tab-btn-bot-add');
    if (addBotBtn && !addBotBtn.dataset.bound) {
      addBotBtn.dataset.bound = '1';
      addBotBtn.addEventListener('click', () => {
        this.spawnBotsForCurrentMode(this.bots.length + 1);
      });
      document.getElementById('tab-btn-bot-ally')?.addEventListener('click', () => {
        const wp = this.builtMap.botWaypoints[0] || this.playerPos.clone();
        const ally = new TacticalBot(
          this.scene,
          `ally_${Date.now()}`,
          'WINGMAN-1',
          'ALLY',
          wp.clone(),
          'PATROL_COMBAT'
        );
        this.bots.push(ally);
      });
      document.getElementById('tab-btn-bot-clear')?.addEventListener('click', () => {
        this.spawnBotsForCurrentMode(0);
      });
      document.querySelectorAll('[data-botmode]').forEach((chip) => {
        chip.addEventListener('click', () => {
          document
            .querySelectorAll('[data-botmode]')
            .forEach((c) => c.classList.remove('selected'));
          chip.classList.add('selected');
          this.botBehaviorMode = ((chip as HTMLElement).dataset.botmode ||
            'PATROL_COMBAT') as BotBehaviorMode;
          this.spawnBotsForCurrentMode(this.bots.length || 4);
        });
      });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new BodycamBabylonEngine();
});
