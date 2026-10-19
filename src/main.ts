import * as THREE from 'three';
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
import { BuiltMap, MapBuilder, ReactiveTarget } from './world/MapBuilder';
import { BotBehaviorMode, BotTeam, TacticalBot } from './entities/BotAI';
import { ActiveGrenade, DroneFlightMode, GadgetSystem, GadgetType } from './gadgets/GadgetSystem';

interface EjectedBrass {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  rotVel: THREE.Vector3;
  life: number;
}

interface ImpactParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

interface WeaponRuntimeState {
  def: WeaponDef;
  magAmmo: number;
  chambered: number; // 0 or 1 (+1 in chamber realism)
  spareMags: number;
  fireModeIndex: number;
  attachments: Record<AttachmentSlot, AttachmentDef>;
}

class BodycamGameEngine {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private postProcess: BodycamPostProcess;
  private audio: AudioEngine;
  private gadgets: GadgetSystem;

  private currentMapId: MapId = 'SHOOTING_RANGE';
  private currentModeId: GameModeId = 'TRAINING';
  private builtMap!: BuiltMap;

  // Player Operator State ("True Body")
  private playerPos = new THREE.Vector3(-2.5, 0, 3.2);
  private playerVel = new THREE.Vector3();
  private playerYaw = 0;
  private playerPitch = 0;
  private playerHealth = 100;
  private operatorStress = 0.06; // 0..1 (v0.8 Stress Engine)
  private damageFlash = 0;
  private flashbangBlind = 0;
  private isCrouching = false;
  private currentEyeHeight = 1.62; // Chest/eye bodycam height
  private leanTarget = 0; // -1 left (Q), 0 center, +1 right (E)
  private leanCurrent = 0;
  private walkBobTimer = 0;
  private lastFootstepCycle = 0;

  // Bodycam Unlinked Free-Aim Deadzone & Weapon Inertia
  private freeAimX = 0; // radians horizontal offset inside deadzone
  private freeAimY = 0; // radians vertical offset inside deadzone
  private swayVelX = 0;
  private swayVelY = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilKickZ = 0;
  private recoilChromaticSpike = 0;
  private boltSlideOffset = 0;
  private pumpCycleTimer = 0;

  // Loadout & Weapon State
  private reissadPoints = 12500;
  private activeSlot: 'PRIMARY' | 'SECONDARY' = 'PRIMARY';
  private primaryState!: WeaponRuntimeState;
  private secondaryState!: WeaponRuntimeState;
  private weaponRig!: BuiltWeaponRig;
  private weaponPivot: THREE.Group;

  // Firing, ADS, Reload & Mag Check
  private isFiring = false;
  private semiShotLatched = false;
  private burstShotsLeft = 0;
  private fireTimer = 0;
  private isADS = false;
  private adsAmount = 0;
  private flashlightOn = true;
  private isReloading = false;
  private reloadTimer = 0;
  private reloadDuration = 2.2;
  private reloadIsStressed = false;
  private reloadStepFlags = { out: false, fumble: false, in: false, bolt: false };
  private magCheckTimer = 0;
  private switchAnimTimer = 0;

  // Selected Throwable & Gadget
  private selectedGrenade: 'FRAG' | 'FLASH' = 'FRAG';
  private grenadesRemaining = 3;
  private selectedGadget: GadgetType = 'FPV_DRONE';
  private droneFlightMode: DroneFlightMode = 'CASUAL';
  private activeGrenades: ActiveGrenade[] = [];
  private operatorBodyStandin: THREE.Group;

  // Bots, Ragdolls & Gun Game Ladder
  private bots: TacticalBot[] = [];
  private botBehaviorMode: BotBehaviorMode = 'PATROL_COMBAT';
  private gunGameIndex = 0;

  // Ballistic Telemetry & 30s Reflex Drill
  private shotsFired = 0;
  private shotsHit = 0;
  private headshotsCount = 0;
  private totalKills = 0;
  private drillActive = false;
  private drillTimeLeft = 0;
  private drillScore = 0;
  private lastTargetPopUpTime = 0;

  // Visual Effects Pools
  private ejectedBrass: EjectedBrass[] = [];
  private impactParticles: ImpactParticle[] = [];
  private bulletDecals: THREE.Mesh[] = [];

  // Input State (Desktop Keyboard/Mouse + Mobile Dual-Stick & Claw Touch + Gyro)
  private keys: Record<string, boolean> = {};
  private lookSensitivity = 1.0;
  private aimAssistEnabled = true;
  private pureDiegeticHud = false;
  private gyroEnabled = false;
  private touchMoveVec = new THREE.Vector2(0, 0);
  private touchSprinting = false;
  private touchLookDelta = new THREE.Vector2(0, 0);
  private moveTouchId: number | null = null;
  private moveTouchOrigin = new THREE.Vector2(93, window.innerHeight - 101);
  private lookTouchId: number | null = null;
  private lookTouchLast = new THREE.Vector2();
  private fireTouchId: number | null = null;
  private fireTouchLast = new THREE.Vector2();

  private clock = new THREE.Clock();

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      92,
      window.innerWidth / window.innerHeight,
      0.04,
      180
    );
    this.scene.add(this.camera);

    this.weaponPivot = new THREE.Group();
    this.camera.add(this.weaponPivot);

    this.postProcess = new BodycamPostProcess(window.innerWidth, window.innerHeight);
    this.audio = new AudioEngine();
    this.gadgets = new GadgetSystem(this.scene);

    // Build 3D Operator Avatar Stand-In (visible when flying FPV Drone / RC Car!)
    this.operatorBodyStandin = new THREE.Group();
    const opTorso = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 1.45, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x2b362c, roughness: 0.8 })
    );
    opTorso.position.y = 0.75;
    const opTablet = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.2, 0.02),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8 })
    );
    opTablet.position.set(0, 1.25, -0.28);
    opTablet.rotation.x = -0.45;
    this.operatorBodyStandin.add(opTorso, opTablet);
    this.operatorBodyStandin.visible = false;
    this.scene.add(this.operatorBodyStandin);

    this.initDefaultLoadout();
    this.loadMap('SHOOTING_RANGE');
    this.equipWeaponSlot('PRIMARY');
    this.spawnBotsForCurrentMode(4);

    this.bindInputs();
    this.bindUI();
    this.populateTabletUI();

    window.addEventListener('resize', () => this.onResize());
    this.animate();
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
    this.switchAnimTimer = 0.35;

    if (this.weaponRig) {
      this.weaponPivot.remove(this.weaponRig.root);
      this.scene.remove(this.weaponRig.laserDotMesh);
    }

    const st = this.getActiveWeaponState();
    this.weaponRig = WeaponModelBuilder.buildWeapon(st.def, st.attachments);
    this.weaponPivot.add(this.weaponRig.root);
    this.scene.add(this.weaponRig.laserDotMesh);

    this.weaponRig.flashlightSpot.intensity =
      this.flashlightOn && this.weaponRig.hasFlashlight ? 3.8 : 0;

    this.updateHUDWeaponCard();
  }

  public loadMap(mapId: MapId): void {
    this.currentMapId = mapId;
    if (this.builtMap) {
      this.scene.remove(this.builtMap.sceneGroup);
    }
    this.clearDecalsAndBrass();

    this.builtMap = MapBuilder.buildMap(mapId, this.scene);
    this.scene.add(this.builtMap.sceneGroup);

    this.playerPos.copy(this.builtMap.playerSpawn);
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
    // Remove existing bots
    for (const b of this.bots) {
      this.scene.remove(b.root);
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
      wp.x += (Math.random() - 0.5) * 1.5;
      wp.z += (Math.random() - 0.5) * 1.5;

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
        `bot_${i}_${Date.now()}`,
        callsigns[i % callsigns.length],
        team,
        wp,
        behavior
      );
      this.bots.push(bot);
      this.scene.add(bot.root);
    }

    const botBtn = document.getElementById('btn-spawn-bots');
    if (botBtn) {
      botBtn.textContent = `🤖 BOTS (${this.bots.length})`;
    }
  }

  public startReflexDrill(): void {
    if (this.currentMapId !== 'SHOOTING_RANGE') {
      this.loadMap('SHOOTING_RANGE');
      this.spawnBotsForCurrentMode(2);
    }
    // Place operator at firing line facing lanes
    this.playerPos.set(-2.0, 0, 2.2);
    this.playerYaw = 0;
    this.playerPitch = 0;

    this.drillActive = true;
    this.drillTimeLeft = 30.0;
    this.drillScore = 0;
    this.lastTargetPopUpTime = performance.now();

    // Pop up 3 drill targets immediately
    const drillTargets = this.builtMap.reactiveTargets.filter((t) => t.isDrillTarget);
    drillTargets.forEach((t, idx) => {
      t.isDown = idx >= 3;
      t.drillActive = !t.isDown;
    });

    this.showDiegeticBanner('🎯 30s CQB REFLEX DRILL STARTED — ENGAGE POP-UP TARGETS!');
    this.audio.playUIClick(1500);
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
    setTimeout(() => item.remove(), 5500);
  }

  private triggerHitmarker(isHeadshot: boolean): void {
    const hm = document.getElementById('hitmarker');
    if (!hm) return;
    hm.setAttribute('stroke', isHeadshot ? '#ef4444' : '#f8fafc');
    hm.style.opacity = '1';
    hm.style.transform = `translate(-50%, -50%) scale(${isHeadshot ? 1.35 : 1.0})`;
    setTimeout(() => {
      hm.style.opacity = '0';
    }, 110);
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
      this.showDiegeticBanner('CLICK — WEAPON DRY! PRESS [R] OR TAP RELOAD');
      return;
    }

    // Consume 1 round
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
      }, 220);
    }

    // 1. Acoustic Pressure Wave Gunshot
    this.audio.playGunshot(st.def.caliber, stats.suppressed, 0, 0);

    // Alert AI Bots if unsuppressed!
    if (!stats.suppressed) {
      for (const bot of this.bots) {
        bot.notifySoundHeard(this.playerPos);
      }
    }

    // 2. Muzzle Flash & Bolt Kick
    if (!stats.suppressed) {
      (this.weaponRig.muzzleFlashMesh.material as THREE.MeshBasicMaterial).opacity = 0.92;
      this.weaponRig.muzzleFlashMesh.rotation.z = Math.random() * Math.PI * 2;
      this.weaponRig.muzzleFlashLight.intensity = 5.5;
    }
    this.boltSlideOffset = st.def.visual.isPistol ? 0.045 : 0.065;

    // 3. Eject 3D Brass Casing
    if (!st.def.visual.isRevolver) {
      this.spawnEjectedBrass(st.def.category === 'Shotguns');
    }

    // 4. Ballistic Raycast along True 3D Weapon Barrel Vector!
    const pellets = st.def.pellets || 1;
    this.shotsFired++;
    let anyPelletHit = false;

    const muzzleWorldPos = new THREE.Vector3();
    const muzzleQuat = new THREE.Quaternion();
    this.weaponRig.muzzlePoint.getWorldPosition(muzzleWorldPos);
    this.weaponRig.muzzlePoint.getWorldQuaternion(muzzleQuat);
    const baseBarrelDir = new THREE.Vector3(0, 0, -1).applyQuaternion(muzzleQuat).normalize();

    // Optional Mobile Aim Magnetism: gently pull barrel vector toward nearest visible target/bot within 4.8 degrees
    if (this.aimAssistEnabled) {
      const assistedDir = this.computeAimAssistVector(muzzleWorldPos, baseBarrelDir);
      if (assistedDir) {
        baseBarrelDir.lerp(assistedDir, this.isADS ? 0.68 : 0.52).normalize();
      }
    }

    const activeSpread = this.isADS ? st.def.adsSpread : stats.spread * 0.45;

    for (let p = 0; p < pellets; p++) {
      const shotDir = baseBarrelDir.clone();
      if (pellets > 1 || activeSpread > 0.0005) {
        shotDir.x += (Math.random() - 0.5) * activeSpread;
        shotDir.y += (Math.random() - 0.5) * activeSpread;
        shotDir.z += (Math.random() - 0.5) * activeSpread;
        shotDir.normalize();
      }

      const hitResult = this.performBallisticRaycast(muzzleWorldPos, shotDir, st.def);
      if (hitResult) {
        anyPelletHit = true;
      }
    }

    if (anyPelletHit) {
      this.shotsHit++;
    }
    this.updateTelemetryAccuracy();

    // 5. Apply Procedural Physical Recoil & Chromatic Shockwave
    const adsMult = this.isADS ? 0.68 : 1.0;
    const vertClimb = stats.vRecoil * stats.kick * adsMult;
    const horizDrift = (Math.random() - 0.46) * stats.hRecoil * stats.kick * 1.8 * adsMult;

    this.recoilPitch += vertClimb;
    this.recoilYaw += horizDrift;
    this.recoilKickZ = Math.min(0.09, this.recoilKickZ + 0.032 * stats.kick);
    this.recoilChromaticSpike = Math.min(1.0, this.recoilChromaticSpike + 0.45 * stats.kick);

    // Push free-aim slightly upward on sustained fire
    this.freeAimY = THREE.MathUtils.clamp(this.freeAimY + vertClimb * 0.45, -0.22, 0.22);
    this.freeAimX = THREE.MathUtils.clamp(this.freeAimX + horizDrift * 0.45, -0.28, 0.28);

    // Small stress bump from firing
    this.operatorStress = Math.min(1.0, this.operatorStress + 0.018);

    // Haptic vibration on mobile devices
    if (navigator.vibrate) {
      navigator.vibrate(18);
    }

    this.updateHUDWeaponCard();
  }

  private computeAimAssistVector(
    origin: THREE.Vector3,
    barrelDir: THREE.Vector3
  ): THREE.Vector3 | null {
    let bestDir: THREE.Vector3 | null = null;
    let bestDot = Math.cos(THREE.MathUtils.degToRad(5.2)); // 5.2 degree magnetism cone

    // Check living hostile bots
    for (const bot of this.bots) {
      if (bot.isDead || bot.team === 'ALLY') continue;
      const chestPos = bot.root.position.clone().add(new THREE.Vector3(0, 1.28, 0));
      const toBot = chestPos.sub(origin).normalize();
      const dot = barrelDir.dot(toBot);
      if (dot > bestDot) {
        bestDot = dot;
        bestDir = toBot;
      }
    }

    // Check standing reactive targets
    for (const rt of this.builtMap.reactiveTargets) {
      if (rt.isDown) continue;
      const targetCenter = new THREE.Vector3();
      rt.bodyMesh.getWorldPosition(targetCenter);
      const toTarget = targetCenter.sub(origin).normalize();
      const dot = barrelDir.dot(toTarget);
      if (dot > bestDot) {
        bestDot = dot;
        bestDir = toTarget;
      }
    }

    return bestDir;
  }

  private performBallisticRaycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    weapon: WeaponDef
  ): boolean {
    const raycaster = new THREE.Raycaster(origin, dir, 0.1, 150);

    // Gather all raycastable meshes (world + reactive targets + bot hitboxes)
    const testObjects: THREE.Object3D[] = [...this.builtMap.raycastMeshes];
    for (const bot of this.bots) {
      if (!bot.isDead) {
        testObjects.push(...bot.hitMeshes);
      }
    }

    const hits = raycaster.intersectObjects(testObjects, false);
    if (hits.length === 0) return false;

    const hit = hits[0];
    const hitPoint = hit.point;
    const hitObj = hit.object;
    const distMeters = Math.round(hit.distance * 10) / 10;

    // 1. Check if we hit a Tactical AI Bot!
    if (hitObj.userData?.botId) {
      const bot = this.bots.find((b) => b.id === hitObj.userData.botId);
      if (bot && !bot.isDead) {
        const zone = (hitObj.userData.hitZone || 'TORSO') as 'HEAD' | 'TORSO' | 'LIMB';
        const mult =
          zone === 'HEAD' ? weapon.headshotMult : zone === 'LIMB' ? weapon.limbMult : 1.0;
        const dmg = Math.round(weapon.damage * mult);

        const res = bot.applyHit(dmg, zone, dir);
        this.spawnImpactParticles(hitPoint, zone === 'HEAD' ? 0xffaa22 : 0xaa1111, 7);
        this.audio.playHitSound(zone === 'HEAD' ? 'HEADSHOT_HELMET' : 'FLESH');
        this.triggerHitmarker(zone === 'HEAD');

        const lastHitEl = document.getElementById('telemetry-last-hit');
        if (lastHitEl) {
          lastHitEl.textContent = `BOT HIT: ${bot.callsign} [${zone}] · ${dmg} DMG @ ${distMeters}m`;
        }

        if (res.killed) {
          this.totalKills++;
          if (res.headshot) this.headshotsCount++;
          const rpEarned = res.headshot ? 150 : 100;
          this.awardReissadPoints(rpEarned);
          this.addKillfeedEntry(
            `ELIMINATED ${bot.callsign} [${weapon.name}${res.headshot ? ' // HEADSHOT' : ''}] +${rpEarned} RP`,
            res.headshot ? '#f59e0b' : '#22c55e'
          );

          // Gun Game Progression!
          if (this.currentModeId === 'GUNGAME') {
            this.gunGameIndex = (this.gunGameIndex + 1) % BODYCAM_WEAPONS.length;
            const nextWep = BODYCAM_WEAPONS[this.gunGameIndex];
            this.primaryState.def = nextWep;
            this.primaryState.magAmmo = nextWep.magCapacity;
            this.primaryState.chambered = 1;
            this.equipWeaponSlot('PRIMARY');
            this.showDiegeticBanner(`GUN GAME LEVEL ${this.gunGameIndex + 1}: ${nextWep.name}!`);
          }
        }
        return true;
      }
    }

    // 2. Check if we hit a Reactive Steel Range Target!
    if (hitObj.userData?.targetId) {
      const rt = this.builtMap.reactiveTargets.find((t) => t.id === hitObj.userData.targetId);
      if (rt && !rt.isDown) {
        const zone = (hitObj.userData.hitZone || 'BODY') as 'HEAD' | 'BODY';
        const isHead = zone === 'HEAD';
        const dmg = Math.round(weapon.damage * (isHead ? weapon.headshotMult : 1.0));

        this.audio.playHitSound(isHead ? 'STEEL_HEAD' : 'STEEL_BODY');
        this.spawnImpactParticles(hitPoint, 0xffcc44, 8);
        this.triggerHitmarker(isHead);

        rt.isDown = true;
        rt.downTimer = rt.isDrillTarget ? 999 : 2.1;
        if (isHead) this.headshotsCount++;

        const reactionMs = Math.round(performance.now() - this.lastTargetPopUpTime);
        const rpGain = isHead ? 50 : 25;
        this.awardReissadPoints(rpGain);

        const lastHitEl = document.getElementById('telemetry-last-hit');
        if (lastHitEl) {
          lastHitEl.textContent = `TARGET [${zone}] @ ${distMeters}m · ${dmg} DMG · +${rpGain} RP`;
        }

        if (this.drillActive && rt.isDrillTarget) {
          this.drillScore += isHead ? 150 : 100;
          this.lastTargetPopUpTime = performance.now();
          // Pop up another random drill target!
          const downedDrill = this.builtMap.reactiveTargets.filter(
            (t) => t.isDrillTarget && t.isDown && t.id !== rt.id
          );
          if (downedDrill.length > 0) {
            const pick = downedDrill[Math.floor(Math.random() * downedDrill.length)];
            pick.isDown = false;
            pick.downTimer = 0;
          }
          const drillEl = document.getElementById('telemetry-drill');
          if (drillEl) {
            drillEl.textContent = `DRILL SCORE: ${this.drillScore} PTS · REACTION: ${reactionMs}ms (${Math.ceil(this.drillTimeLeft)}s LEFT)`;
          }
        }
        return true;
      }
    }

    // 3. World Geometry Impact (Bullet Hole Decal + Ricochet Sparks)
    if (hit.face) {
      this.spawnBulletDecal(hitPoint, hit.face.normal);
      this.spawnImpactParticles(hitPoint, 0xffdd88, 4);
    }
    return false;
  }

  public startReload(): void {
    if (this.isReloading) return;
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);

    if (st.spareMags <= 0) {
      this.showDiegeticBanner('NO SPARE MAGAZINES REMAINING!');
      return;
    }
    if (st.magAmmo >= stats.magCap && st.chambered === 1) return;

    this.isReloading = true;
    this.isADS = false;
    this.reloadTimer = 0;
    // v0.8 Stress-Driven Reload Engine: if stress > 48%, operator fumbles and takes longer!
    this.reloadIsStressed = this.operatorStress > 0.48;
    this.reloadDuration = this.reloadIsStressed ? stats.reloadStressed : stats.reloadCalm;
    this.reloadStepFlags = { out: false, fumble: false, in: false, bolt: false };

    if (this.reloadIsStressed) {
      this.showDiegeticBanner('⚠️ HIGH COMBAT STRESS — FUMBLED / PANICKED RELOAD!');
    } else {
      this.showDiegeticBanner('RELOADING...');
    }
  }

  public triggerMagCheck(): void {
    if (this.isReloading || this.magCheckTimer > 0) return;
    this.magCheckTimer = 1.45;
    this.audio.playReloadStep('magCheck');

    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);
    const ratio = st.magAmmo / stats.magCap;
    let desc = 'EMPTY (0 RNDS)';
    if (ratio >= 0.95) desc = `FULL (~${st.magAmmo} RNDS)`;
    else if (ratio >= 0.65) desc = `MORE THAN HALF (~${st.magAmmo} RNDS)`;
    else if (ratio >= 0.35) desc = `ABOUT HALF (~${st.magAmmo} RNDS)`;
    else if (st.magAmmo > 0) desc = `ALMOST EMPTY (~${st.magAmmo} RNDS)`;

    const chamberText = st.chambered ? '+1 CHAMBERED' : 'CHAMBER EMPTY';
    this.showDiegeticBanner(
      `🔍 MAG CHECK: ${desc} · ${chamberText} · ${st.spareMags} SPARE MAGS`,
      2800
    );
  }

  public throwGrenade(): void {
    if (this.grenadesRemaining <= 0) {
      this.showDiegeticBanner('OUT OF GRENADES!');
      return;
    }
    this.grenadesRemaining--;
    const isFlash = this.selectedGrenade === 'FLASH';

    const gGroup = new THREE.Group();
    const bodyGeo = isFlash
      ? new THREE.CylinderGeometry(0.032, 0.032, 0.11, 10)
      : new THREE.SphereGeometry(0.045, 10, 10);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: isFlash ? 0xd1d5db : 0x3f4d34,
      roughness: 0.5,
      metalness: 0.4,
    });
    gGroup.add(new THREE.Mesh(bodyGeo, bodyMat));

    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    gGroup.position.copy(this.camera.position).addScaledVector(camDir, 0.6);
    this.scene.add(gGroup);

    const throwVel = camDir.multiplyScalar(15.5).add(new THREE.Vector3(0, 3.2, 0));
    this.activeGrenades.push({
      mesh: gGroup,
      vel: throwVel,
      isFlashbang: isFlash,
      fuseTimer: 2.35,
    });

    this.audio.playReloadStep('magOut');
    this.showDiegeticBanner(
      isFlash
        ? `⚡ M84 STUN FLASHBANG OUT! (${this.grenadesRemaining} LEFT)`
        : `💣 M67 FRAG GRENADE OUT! (${this.grenadesRemaining} LEFT)`
    );
  }

  public toggleGadgetDeploy(): void {
    if (this.gadgets.activeGadget) {
      this.gadgets.recallOrDestroy(4.0);
      this.audio.setDroneMotorState(false);
      this.operatorBodyStandin.visible = false;
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

    this.operatorBodyStandin.position.copy(this.playerPos);
    this.operatorBodyStandin.rotation.y = this.playerYaw;
    this.operatorBodyStandin.visible = true;
    document.getElementById('drone-osd')?.classList.add('visible');
    this.updateDroneOSD();
  }

  public detonateGadgetPayload(): void {
    if (!this.gadgets.activeGadget) return;
    const blastPos = this.gadgets.pos.clone();
    const distToPlayer = blastPos.distanceTo(this.playerPos);

    this.audio.playExplosion(false, distToPlayer);
    this.spawnImpactParticles(blastPos, 0xff7722, 22);

    // Damage nearby bots!
    for (const bot of this.bots) {
      if (bot.isDead) continue;
      const d = bot.root.position.distanceTo(blastPos);
      if (d < 9.5) {
        const dmg = Math.round(160 * (1 - d / 9.5));
        const dir = bot.root.position.clone().sub(blastPos).normalize();
        const res = bot.applyHit(dmg, 'TORSO', dir);
        if (res.killed) {
          this.totalKills++;
          this.awardReissadPoints(125);
          this.addKillfeedEntry(
            `ELIMINATED ${bot.callsign} [${this.gadgets.activeGadget} C4 STRIKE] +125 RP`,
            '#38bdf8'
          );
        }
      }
    }

    this.gadgets.recallOrDestroy(7.0);
    this.audio.setDroneMotorState(false);
    this.operatorBodyStandin.visible = false;
    document.getElementById('drone-osd')?.classList.remove('visible');
  }

  private awardReissadPoints(amount: number): void {
    this.reissadPoints += amount;
    const rpEl = document.getElementById('tablet-rp-balance');
    if (rpEl) rpEl.textContent = `${this.reissadPoints.toLocaleString()} RP`;
    this.updateAxonHeader();
  }

  // ==================== VISUAL POOLS (BRASS, DECALS, PARTICLES) ====================
  private spawnEjectedBrass(isShotgunHull: boolean): void {
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    this.weaponRig.ejectionPoint.getWorldPosition(worldPos);
    this.weaponRig.ejectionPoint.getWorldQuaternion(worldQuat);

    const geo = new THREE.CylinderGeometry(
      isShotgunHull ? 0.009 : 0.0045,
      isShotgunHull ? 0.009 : 0.0045,
      isShotgunHull ? 0.055 : 0.032,
      6
    );
    const mat = new THREE.MeshStandardMaterial({
      color: isShotgunHull ? 0xb91c1c : 0xd4af37,
      roughness: 0.3,
      metalness: isShotgunHull ? 0.2 : 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(worldPos);
    this.scene.add(mesh);

    const rightDir = new THREE.Vector3(1, 0.45, 0.15)
      .applyQuaternion(worldQuat)
      .normalize()
      .multiplyScalar(2.2 + Math.random() * 1.1);

    this.ejectedBrass.push({
      mesh,
      vel: rightDir,
      rotVel: new THREE.Vector3(
        Math.random() * 18,
        Math.random() * 18,
        Math.random() * 18
      ),
      life: 2.5,
    });
  }

  private spawnBulletDecal(point: THREE.Vector3, normal: THREE.Vector3): void {
    const decalGeo = new THREE.CircleGeometry(0.038, 8);
    const decalMat = new THREE.MeshBasicMaterial({
      color: 0x0b0d10,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const decal = new THREE.Mesh(decalGeo, decalMat);
    decal.position.copy(point).addScaledVector(normal, 0.008);
    decal.lookAt(point.clone().add(normal));
    this.scene.add(decal);
    this.bulletDecals.push(decal);

    if (this.bulletDecals.length > 55) {
      const old = this.bulletDecals.shift();
      if (old) this.scene.remove(old);
    }
  }

  private spawnImpactParticles(pos: THREE.Vector3, colorHex: number, count: number): void {
    const geo = new THREE.BoxGeometry(0.028, 0.028, 0.028);
    const mat = new THREE.MeshBasicMaterial({ color: colorHex });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      this.scene.add(mesh);
      this.impactParticles.push({
        mesh,
        vel: new THREE.Vector3(
          (Math.random() - 0.5) * 5.5,
          1.2 + Math.random() * 3.8,
          (Math.random() - 0.5) * 5.5
        ),
        life: 0.35 + Math.random() * 0.25,
      });
    }
  }

  private clearDecalsAndBrass(): void {
    for (const d of this.bulletDecals) this.scene.remove(d);
    this.bulletDecals = [];
    for (const b of this.ejectedBrass) this.scene.remove(b.mesh);
    this.ejectedBrass = [];
  }

  // ==================== MAIN SIMULATION LOOP ====================
  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.getElapsedTime();

    this.updateClockStamp();

    if (this.gadgets.activeGadget) {
      this.updateGadgetMode(dt);
    } else {
      this.updatePlayerMovementAndCamera(dt, elapsed);
      this.updateWeaponMechanicsAndInertia(dt, elapsed);
    }

    this.updateReactiveTargetsAndDrill(dt);
    this.updateBotsAI(dt);
    this.updateGrenadesAndPools(dt);
    this.updatePhysiologyAndStress(dt, elapsed);

    const activeCam = this.gadgets.activeGadget ? this.gadgets.camera : this.camera;
    this.postProcess.render(this.renderer, this.scene, activeCam, elapsed, {
      stress: this.operatorStress,
      damage: this.damageFlash,
      flashbang: this.flashbangBlind,
      adsAmount: this.adsAmount,
      recoilChromaticSpike: this.recoilChromaticSpike,
      droneMode: this.gadgets.activeGadget !== null,
      exposure: this.builtMap.defaultExposure,
    });
  };

  private updateGadgetMode(dt: number): void {
    let moveFwd = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0) + this.touchMoveVec.y;
    let moveRight = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0) + this.touchMoveVec.x;
    let vert = (this.keys['Space'] ? 1 : 0) - (this.keys['ControlLeft'] ? 1 : 0);

    moveFwd = THREE.MathUtils.clamp(moveFwd, -1, 1);
    moveRight = THREE.MathUtils.clamp(moveRight, -1, 1);

    const lookDX = this.touchLookDelta.x * 0.005 * this.lookSensitivity;
    const lookDY = this.touchLookDelta.y * 0.005 * this.lookSensitivity;
    this.touchLookDelta.set(0, 0);

    const res = this.gadgets.update(
      dt,
      { moveForward: moveFwd, moveRight, vertical: vert, lookDeltaX: lookDX, lookDeltaY: lookDY },
      this.builtMap.colliders
    );

    if (this.gadgets.activeGadget) {
      this.audio.setDroneMotorState(
        true,
        res.throttleLevel,
        this.gadgets.activeGadget === 'RC_CAR'
      );
      this.updateDroneOSD();
    } else {
      this.audio.setDroneMotorState(false);
      this.operatorBodyStandin.visible = false;
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
      const dist = this.gadgets.pos.distanceTo(this.playerPos).toFixed(1);
      coordsEl.textContent = `ALT: ${this.gadgets.pos.y.toFixed(1)}m // RANGE: ${dist}m`;
    }
  }

  private updatePlayerMovementAndCamera(dt: number, elapsed: number): void {
    // 1. Apply Touch / Mouse Look into Bodycam Free-Aim Deadzone + Torso Orientation
    const dx = this.touchLookDelta.x * 0.0032 * this.lookSensitivity;
    const dy = this.touchLookDelta.y * 0.0032 * this.lookSensitivity;
    this.touchLookDelta.set(0, 0);

    // In Bodycam, small aim adjustments move the hands inside the free-aim deadzone first;
    // when pushing toward the deadzone edge (or when ADSing), the chest camera turns smoothly!
    const deadzoneLimitX = this.isADS ? 0.035 : 0.19;
    const deadzoneLimitY = this.isADS ? 0.03 : 0.14;

    this.freeAimX -= dx * (this.isADS ? 0.25 : 0.65);
    this.freeAimY -= dy * (this.isADS ? 0.25 : 0.65);
    this.swayVelX -= dx * 0.8;
    this.swayVelY -= dy * 0.8;

    // Overflow beyond deadzone rotates the operator's torso/camera immediately
    if (Math.abs(this.freeAimX) > deadzoneLimitX) {
      const excessX = this.freeAimX - Math.sign(this.freeAimX) * deadzoneLimitX;
      this.playerYaw += excessX;
      this.freeAimX = Math.sign(this.freeAimX) * deadzoneLimitX;
    }
    if (Math.abs(this.freeAimY) > deadzoneLimitY) {
      const excessY = this.freeAimY - Math.sign(this.freeAimY) * deadzoneLimitY;
      this.playerPitch = THREE.MathUtils.clamp(this.playerPitch + excessY, -1.35, 1.35);
      this.freeAimY = Math.sign(this.freeAimY) * deadzoneLimitY;
    }

    // Also turn torso directly by a portion of look input + spring-center free-aim
    this.playerYaw -= dx * (this.isADS ? 0.85 : 0.55);
    this.playerPitch = THREE.MathUtils.clamp(
      this.playerPitch - dy * (this.isADS ? 0.85 : 0.55),
      -1.35,
      1.35
    );

    const centerRecenterRate = this.isADS ? 10.0 : 2.8;
    this.freeAimX = THREE.MathUtils.lerp(this.freeAimX, 0, dt * centerRecenterRate);
    this.freeAimY = THREE.MathUtils.lerp(this.freeAimY, 0, dt * centerRecenterRate);

    // 2. Movement Vector (Keyboard WASD + Mobile Virtual Thumbstick)
    let moveFwd = (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0) -
      (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0) +
      this.touchMoveVec.y;
    let moveRight = (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0) -
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
      !this.isCrouching;

    const baseSpeed = this.isCrouching ? 2.65 : isSprinting ? 6.4 : this.isADS ? 3.1 : 4.45;

    const forwardVec = new THREE.Vector3(-Math.sin(this.playerYaw), 0, -Math.cos(this.playerYaw));
    const rightVec = new THREE.Vector3(Math.cos(this.playerYaw), 0, -Math.sin(this.playerYaw));

    const wishVel = new THREE.Vector3();
    wishVel.addScaledVector(forwardVec, moveFwd * baseSpeed);
    wishVel.addScaledVector(rightVec, moveRight * baseSpeed);

    this.playerVel.lerp(wishVel, dt * 11.0);

    // Sliding collision resolution on X and Z axes separately
    const radius = 0.38;
    const tryX = this.playerPos.clone();
    tryX.x += this.playerVel.x * dt;
    if (!this.checkPlayerCollision(tryX, radius)) {
      this.playerPos.x = tryX.x;
    }

    const tryZ = this.playerPos.clone();
    tryZ.z += this.playerVel.z * dt;
    if (!this.checkPlayerCollision(tryZ, radius)) {
      this.playerPos.z = tryZ.z;
    }

    // 3. Stance Height & Q/E Corner Leaning
    const targetHeight = this.isCrouching ? 1.05 : 1.62;
    this.currentEyeHeight = THREE.MathUtils.lerp(this.currentEyeHeight, targetHeight, dt * 10);

    let kbLean = (this.keys['KeyE'] ? 1 : 0) - (this.keys['KeyQ'] ? 1 : 0);
    const activeLean = kbLean !== 0 ? kbLean : this.leanTarget;
    this.leanCurrent = THREE.MathUtils.lerp(this.leanCurrent, activeLean, dt * 9.5);

    // 4. True Body Chest-Camera Bob, Breathing & Footsteps
    const horizSpeed = Math.hypot(this.playerVel.x, this.playerVel.z);
    let bobY = Math.sin(elapsed * 2.1) * 0.008;
    let bobRoll = Math.cos(elapsed * 1.4) * 0.004;

    if (horizSpeed > 0.4) {
      const freq = isSprinting ? 11.5 : 8.2;
      this.walkBobTimer += dt * freq;
      const amp = isSprinting ? 0.052 : 0.026;
      bobY += Math.sin(this.walkBobTimer) * amp;
      bobRoll += Math.cos(this.walkBobTimer * 0.5) * (amp * 0.45);

      const stepCycle = Math.floor(this.walkBobTimer / Math.PI);
      if (stepCycle !== this.lastFootstepCycle) {
        this.lastFootstepCycle = stepCycle;
        this.audio.playFootstep(this.builtMap.surfaceType, isSprinting);
      }
    }

    // Apply Lean horizontal offset + roll to Camera
    const leanOffset = rightVec.clone().multiplyScalar(this.leanCurrent * 0.42);
    this.camera.position
      .copy(this.playerPos)
      .add(leanOffset)
      .add(new THREE.Vector3(0, this.currentEyeHeight + bobY, 0));

    const camEuler = new THREE.Euler(
      THREE.MathUtils.clamp(this.playerPitch + this.recoilPitch * 0.65, -1.45, 1.45),
      this.playerYaw + this.recoilYaw * 0.65,
      -this.leanCurrent * 0.24 + bobRoll,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(camEuler);
  }

  private checkPlayerCollision(pos: THREE.Vector3, radius: number): boolean {
    const pBox = new THREE.Box3(
      new THREE.Vector3(pos.x - radius, 0.1, pos.z - radius),
      new THREE.Vector3(pos.x + radius, 1.8, pos.z + radius)
    );
    for (const c of this.builtMap.colliders) {
      if (c.intersectsBox(pBox)) return true;
    }
    return false;
  }

  private updateWeaponMechanicsAndInertia(dt: number, elapsed: number): void {
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);

    // 1. ADS Interpolation & Optic FOV Zoom
    const wantADS = this.isADS && !this.isReloading && this.magCheckTimer <= 0;
    this.adsAmount = THREE.MathUtils.lerp(
      this.adsAmount,
      wantADS ? 1.0 : 0.0,
      dt * stats.adsSpeed * 1.8
    );

    const targetFov = THREE.MathUtils.lerp(92, 92 / stats.opticZoom, this.adsAmount);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }

    // 2. Decay Recoil, Muzzle Flash, Bolt Slide & Switch Animation
    this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, 0, dt * 8.5);
    this.recoilYaw = THREE.MathUtils.lerp(this.recoilYaw, 0, dt * 8.5);
    this.recoilKickZ = THREE.MathUtils.lerp(this.recoilKickZ, 0, dt * 14.0);
    this.recoilChromaticSpike = THREE.MathUtils.lerp(this.recoilChromaticSpike, 0, dt * 9.0);
    this.boltSlideOffset = THREE.MathUtils.lerp(this.boltSlideOffset, 0, dt * 22.0);
    this.swayVelX = THREE.MathUtils.lerp(this.swayVelX, 0, dt * 10.0);
    this.swayVelY = THREE.MathUtils.lerp(this.swayVelY, 0, dt * 10.0);

    if (this.switchAnimTimer > 0) {
      this.switchAnimTimer = Math.max(0, this.switchAnimTimer - dt * stats.switchSpeed);
    }
    if (this.pumpCycleTimer > 0) {
      this.pumpCycleTimer = Math.max(0, this.pumpCycleTimer - dt);
    }

    const flashMat = this.weaponRig.muzzleFlashMesh.material as THREE.MeshBasicMaterial;
    if (flashMat.opacity > 0) {
      flashMat.opacity = Math.max(0, flashMat.opacity - dt * 18);
      this.weaponRig.muzzleFlashLight.intensity = flashMat.opacity * 5.0;
    }

    // Lock slide back if pistol is completely empty
    const isEmpty = st.magAmmo + st.chambered === 0;
    this.weaponRig.boltGroup.position.z = isEmpty ? 0.038 : this.boltSlideOffset;

    if (this.pumpCycleTimer > 0) {
      const pumpCurve = Math.sin((this.pumpCycleTimer / 0.55) * Math.PI);
      this.weaponRig.pumpGroup.position.z = Math.max(0, pumpCurve * 0.075);
    } else {
      this.weaponRig.pumpGroup.position.z = 0;
    }

    // 3. Handle Multi-Stage Articulated Reload (Calm vs Stressed v0.8 Fumble!)
    let reloadDipY = 0;
    let reloadRollZ = 0;
    let reloadPitchX = 0;

    if (this.isReloading) {
      this.reloadTimer += dt;
      const p = Math.min(1, this.reloadTimer / this.reloadDuration);

      if (p > 0.12 && !this.reloadStepFlags.out) {
        this.reloadStepFlags.out = true;
        this.audio.playReloadStep('magOut');
      }
      if (this.reloadIsStressed && p > 0.42 && !this.reloadStepFlags.fumble) {
        this.reloadStepFlags.fumble = true;
        this.audio.playReloadStep('magFumble');
      }
      if (p > 0.65 && !this.reloadStepFlags.in) {
        this.reloadStepFlags.in = true;
        this.audio.playReloadStep('magIn');
      }
      if (p > 0.86 && !this.reloadStepFlags.bolt) {
        this.reloadStepFlags.bolt = true;
        this.audio.playReloadStep('boltSlap');
        this.boltSlideOffset = 0.055;
      }

      // Animate magazine detaching and re-inserting (with stressed jitter if panicked!)
      const stressJitter = this.reloadIsStressed
        ? Math.sin(elapsed * 48) * 0.014
        : 0;
      const magPull = p < 0.35 ? p / 0.35 : p < 0.68 ? 1.0 : 1.0 - (p - 0.68) / 0.32;
      this.weaponRig.magazineGroup.position.y =
        -st.def.visual.receiverHeight * 0.5 - magPull * 0.22 + stressJitter;
      this.weaponRig.magazineGroup.position.x = stressJitter * 1.4;

      reloadDipY = -Math.sin(p * Math.PI) * 0.045;
      reloadRollZ = Math.sin(p * Math.PI) * 0.38 + stressJitter * 2.5;
      reloadPitchX = Math.sin(p * Math.PI) * 0.18;

      if (p >= 1.0) {
        this.isReloading = false;
        this.weaponRig.magazineGroup.position.set(
          0,
          -st.def.visual.receiverHeight * 0.5,
          st.def.visual.isPistol ? 0.035 : -0.045
        );
        const hadRoundInChamber = st.magAmmo + st.chambered > 0;
        st.spareMags = Math.max(0, st.spareMags - 1);
        st.magAmmo = stats.magCap;
        st.chambered = hadRoundInChamber ? 1 : 0;
        this.updateHUDWeaponCard();
      }
    } else if (this.magCheckTimer > 0) {
      // Diegetic [M] Mag Check Animation: tilt rifle and pull magazine down slightly to view brass bullet!
      this.magCheckTimer = Math.max(0, this.magCheckTimer - dt);
      const checkAmt = Math.sin(Math.min(1, this.magCheckTimer / 1.45) * Math.PI);
      this.weaponRig.magazineGroup.position.y =
        -st.def.visual.receiverHeight * 0.5 - checkAmt * 0.065;
      this.weaponRig.brassBulletMesh.visible = st.magAmmo > 0;
      reloadRollZ = 0.52 * checkAmt;
      reloadDipY = 0.035 * checkAmt;
    } else {
      this.weaponRig.magazineGroup.position.set(
        0,
        -st.def.visual.receiverHeight * 0.5,
        st.def.visual.isPistol ? 0.035 : -0.045
      );
    }

    // 4. Position 3D Weapon Rig (Hip Chest-Cam Position ↔ True Optic Sight Alignment)
    const hipPos = new THREE.Vector3(
      0.135,
      -0.145 - this.switchAnimTimer * 0.4 + reloadDipY,
      -0.31 + this.recoilKickZ
    );
    const adsPos = new THREE.Vector3(
      0,
      -this.weaponRig.sightAlignLocal.y,
      st.def.visual.isPistol ? -0.26 : -0.22 + this.recoilKickZ * 0.65
    );

    this.weaponRig.root.position.lerpVectors(hipPos, adsPos, this.adsAmount);

    // Apply Free-Aim Deadzone Angles + Procedural Stress Hand Tremor + Walk Sway
    const stressTremor = this.operatorStress > 0.35 ? (this.operatorStress - 0.35) * 0.015 : 0;
    const tremorX = Math.sin(elapsed * 19.3) * stressTremor;
    const tremorY = Math.cos(elapsed * 23.7) * stressTremor;

    this.weaponRig.root.rotation.set(
      this.freeAimY + this.recoilPitch * 0.8 + reloadPitchX + tremorY + this.swayVelY * 0.05,
      this.freeAimX + this.recoilYaw * 0.8 + tremorX + this.swayVelX * 0.05,
      reloadRollZ - this.swayVelX * 0.08,
      'YXZ'
    );

    // 5. Update 3D Laser Beam & World Laser Hit Dot
    this.updateTacticalLaser();

    // 6. Handle Continuous / Auto Firing (plus Optional Smart Mobile Auto-Fire when barrel locks onto target!)
    if (this.fireTimer > 0) {
      this.fireTimer -= dt;
    }

    let smartAutoTrigger = false;
    if (
      this.aimAssistEnabled &&
      !this.isReloading &&
      this.fireTimer <= 0 &&
      (this.touchLookIdActive() || this.moveTouchId !== null)
    ) {
      // Check if barrel is directly aimed at an enemy bot within 1.8 degrees
      const muzzlePos = new THREE.Vector3();
      const muzzleQuat = new THREE.Quaternion();
      this.weaponRig.muzzlePoint.getWorldPosition(muzzlePos);
      this.weaponRig.muzzlePoint.getWorldQuaternion(muzzleQuat);
      const barrelDir = new THREE.Vector3(0, 0, -1).applyQuaternion(muzzleQuat).normalize();
      for (const bot of this.bots) {
        if (bot.isDead || bot.team === 'ALLY') continue;
        const botChest = bot.root.position.clone().add(new THREE.Vector3(0, 1.25, 0));
        const dist = muzzlePos.distanceTo(botChest);
        if (dist < 28 && barrelDir.dot(botChest.sub(muzzlePos).normalize()) > 0.9992) {
          smartAutoTrigger = true;
          break;
        }
      }
    }

    if ((this.isFiring || smartAutoTrigger) && this.fireTimer <= 0) {
      this.tryFireWeapon();
    }
  }

  private touchLookIdActive(): boolean {
    return this.lookTouchId !== null || this.fireTouchId !== null;
  }

  private updateTacticalLaser(): void {
    if (!this.weaponRig.hasLaser || this.isReloading) {
      this.weaponRig.laserBeamMesh.visible = false;
      this.weaponRig.laserDotMesh.visible = false;
      return;
    }

    this.weaponRig.laserBeamMesh.visible = true;
    const beamOrigin = new THREE.Vector3();
    const beamQuat = new THREE.Quaternion();
    this.weaponRig.laserBeamMesh.getWorldPosition(beamOrigin);
    this.weaponRig.root.getWorldQuaternion(beamQuat);
    const beamDir = new THREE.Vector3(0, 0, -1).applyQuaternion(beamQuat).normalize();

    const rc = new THREE.Raycaster(beamOrigin, beamDir, 0.1, 65);
    const testObjs: THREE.Object3D[] = [...this.builtMap.raycastMeshes];
    for (const b of this.bots) {
      if (!b.isDead) testObjs.push(...b.hitMeshes);
    }
    const hits = rc.intersectObjects(testObjs, false);

    if (hits.length > 0) {
      const dist = hits[0].distance;
      this.weaponRig.laserBeamMesh.scale.set(1, 1, dist);
      this.weaponRig.laserDotMesh.position
        .copy(hits[0].point)
        .addScaledVector(beamDir, -0.02);
      this.weaponRig.laserDotMesh.visible = true;
    } else {
      this.weaponRig.laserBeamMesh.scale.set(1, 1, 35);
      this.weaponRig.laserDotMesh.visible = false;
    }
  }

  // ==================== REACTIVE TARGETS & 30s REFLEX DRILL ====================
  private updateReactiveTargetsAndDrill(dt: number): void {
    const elapsed = this.clock.getElapsedTime();

    for (const rt of this.builtMap.reactiveTargets) {
      // Smooth hinge flip animation when knocked down or popped up
      const targetAngle = rt.isDown ? -Math.PI / 2 : 0;
      rt.pivot.rotation.x = THREE.MathUtils.lerp(rt.pivot.rotation.x, targetAngle, dt * 12);

      if (rt.isDown && !rt.isDrillTarget) {
        rt.downTimer -= dt;
        if (rt.downTimer <= 0) {
          rt.isDown = false;
        }
      }

      // Lateral motorized rail movement
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
          drillEl.textContent = `🏆 DRILL COMPLETE! SCORE: ${this.drillScore} PTS (+${bonusRP} RP BONUS)`;
        }
        this.showDiegeticBanner(
          `🏆 30s REFLEX DRILL FINISHED: ${this.drillScore} PTS (+${bonusRP} RP)!`,
          3800
        );
      } else if (drillEl) {
        drillEl.textContent = `⏱️ DRILL ACTIVE: ${this.drillScore} PTS · ${this.drillTimeLeft.toFixed(1)}s REMAINING`;
      }
    }
  }

  // ==================== TACTICAL AI BOTS & RAGDOLL STUMBLING ====================
  private updateBotsAI(dt: number): void {
    const wps = this.builtMap.botWaypoints;

    for (const bot of this.bots) {
      if (bot.muzzleFlash.material) {
        const mfMat = bot.muzzleFlash.material as THREE.MeshBasicMaterial;
        if (mfMat.opacity > 0) mfMat.opacity = Math.max(0, mfMat.opacity - dt * 16);
      }

      // 1. Handle Ragdoll Collapse & Respawn
      if (bot.isDead) {
        bot.bodyPivot.rotation.x = THREE.MathUtils.lerp(
          bot.bodyPivot.rotation.x,
          bot.deathFallPitch,
          dt * 8.5
        );
        bot.bodyPivot.rotation.z = THREE.MathUtils.lerp(
          bot.bodyPivot.rotation.z,
          bot.deathFallRoll,
          dt * 8.5
        );
        bot.bodyPivot.position.y = THREE.MathUtils.lerp(bot.bodyPivot.position.y, 0.15, dt * 8);

        if (bot.helmetDetached) {
          bot.helmetMesh.position.addScaledVector(bot.helmetVel, dt);
          bot.helmetVel.y -= 9.8 * dt;
          bot.helmetMesh.rotation.x += dt * 12;
        }

        bot.respawnTimer -= dt;
        if (bot.respawnTimer <= 0 && wps.length > 0) {
          const spawnWp = wps[Math.floor(Math.random() * wps.length)];
          bot.respawn(spawnWp);
        }
        continue;
      }

      // 2. Handle M84 Flashbang Blindness
      if (bot.flashedTimer > 0) {
        bot.flashedTimer -= dt;
        bot.leftArm.rotation.x = -2.2; // Shield eyes
        bot.bodyPivot.rotation.z = Math.sin(performance.now() * 0.012) * 0.22;
        continue;
      } else {
        bot.leftArm.rotation.x = 0;
      }

      // 3. Handle Bodycam Ragdoll Stumbling Physics on non-lethal hits!
      if (bot.stumbleTimer > 0) {
        bot.stumbleTimer -= dt;
        bot.root.position.addScaledVector(bot.stumbleDir, dt * 2.1);
        bot.bodyPivot.rotation.z = Math.sin(bot.stumbleTimer * 18) * 0.35;
        bot.bodyPivot.rotation.x = 0.28;
        continue;
      } else {
        bot.bodyPivot.rotation.x = THREE.MathUtils.lerp(bot.bodyPivot.rotation.x, 0, dt * 8);
        bot.bodyPivot.rotation.z = THREE.MathUtils.lerp(
          bot.bodyPivot.rotation.z,
          bot.leanAngle,
          dt * 8
        );
      }

      // 4. Target Selection (Hostile Bots target Player or Allied Bots; Allies target Hostiles)
      let targetPos: THREE.Vector3 | null = null;
      let targetIsPlayer = false;

      if (bot.team === 'ALLY') {
        let closestDist = 45;
        for (const other of this.bots) {
          if (other.isDead || other.team === 'ALLY') continue;
          const d = bot.root.position.distanceTo(other.root.position);
          if (d < closestDist) {
            closestDist = d;
            targetPos = other.root.position;
          }
        }
      } else {
        // Hostile / Zombie bot
        const distToPlayer = bot.root.position.distanceTo(this.playerPos);
        // In Training Range HUB, bots only engage player if player is inside the Killhouse wing (x > 7.5) or shoots at them!
        const playerInCombatZone =
          this.currentMapId !== 'SHOOTING_RANGE' ||
          this.playerPos.x > 7.5 ||
          bot.alertTimer > 0;

        if (playerInCombatZone && distToPlayer < 42) {
          targetPos = this.playerPos;
          targetIsPlayer = true;
        }
      }

      // Check Line of Sight
      let canSeeTarget = false;
      if (targetPos) {
        const eyeOrigin = bot.root.position.clone().add(new THREE.Vector3(0, 1.5, 0));
        const targetEye = targetPos.clone().add(new THREE.Vector3(0, 1.3, 0));
        const dist = eyeOrigin.distanceTo(targetEye);
        const dir = targetEye.clone().sub(eyeOrigin).normalize();

        const rc = new THREE.Raycaster(eyeOrigin, dir, 0.2, dist - 0.3);
        const wallHits = rc.intersectObjects(this.builtMap.raycastMeshes, false);
        canSeeTarget = wallHits.length === 0;
      }

      if (canSeeTarget && targetPos) {
        bot.state = 'ENGAGE';
        const dx = targetPos.x - bot.root.position.x;
        const dz = targetPos.z - bot.root.position.z;
        const desiredYaw = Math.atan2(-dx, -dz);
        bot.root.rotation.y = THREE.MathUtils.lerp(bot.root.rotation.y, desiredYaw, dt * 8);

        if (bot.team === 'ZOMBIE') {
          // Sprint straight at target and melee!
          const moveDir = new THREE.Vector3(dx, 0, dz).normalize();
          bot.root.position.addScaledVector(moveDir, dt * 4.8);
          this.animateBotLegs(bot, dt, 12);
          if (bot.root.position.distanceTo(this.playerPos) < 1.65 && bot.fireCooldown <= 0) {
            bot.fireCooldown = 1.1;
            this.applyDamageToPlayer(18, moveDir);
          }
        } else {
          // Tactical Strafe, Corner Peek Lean & Burst Fire
          bot.strafeTimer -= dt;
          if (bot.strafeTimer <= 0) {
            bot.strafeTimer = 1.2 + Math.random() * 1.4;
            bot.strafeDir = Math.random() > 0.5 ? 1 : -1;
            bot.leanAngle = (Math.random() - 0.5) * 0.28;
          }

          if (bot.behavior !== 'STATIONARY_GUARD') {
            const rightSide = new THREE.Vector3(Math.cos(desiredYaw), 0, -Math.sin(desiredYaw));
            const nextP = bot.root.position
              .clone()
              .addScaledVector(rightSide, bot.strafeDir * dt * 2.1);
            if (!this.checkPlayerCollision(nextP, 0.4)) {
              bot.root.position.copy(nextP);
              this.animateBotLegs(bot, dt, 6.5);
            }
          }

          bot.fireCooldown -= dt;
          if (bot.fireCooldown <= 0) {
            bot.fireCooldown = 0.24 + Math.random() * 0.38;
            this.botFireShot(bot, targetPos, targetIsPlayer);
          }
        }
      } else {
        // Patrol between waypoints or investigate sound!
        bot.leanAngle = 0;
        if (bot.behavior === 'STATIONARY_GUARD') {
          this.animateBotLegs(bot, dt, 0);
          continue;
        }

        if (bot.alertTimer > 0) {
          bot.alertTimer -= dt;
          bot.targetWaypoint.copy(bot.alertPos);
        } else if (bot.root.position.distanceTo(bot.targetWaypoint) < 1.4 && wps.length > 0) {
          bot.targetWaypoint.copy(wps[Math.floor(Math.random() * wps.length)]);
        }

        const toWp = bot.targetWaypoint.clone().sub(bot.root.position);
        toWp.y = 0;
        if (toWp.lengthSq() > 0.2) {
          toWp.normalize();
          const desiredYaw = Math.atan2(-toWp.x, -toWp.z);
          bot.root.rotation.y = THREE.MathUtils.lerp(bot.root.rotation.y, desiredYaw, dt * 5);
          const nextP = bot.root.position.clone().addScaledVector(toWp, dt * 2.7);
          if (!this.checkPlayerCollision(nextP, 0.4)) {
            bot.root.position.copy(nextP);
          } else if (wps.length > 0) {
            bot.targetWaypoint.copy(wps[Math.floor(Math.random() * wps.length)]);
          }
          this.animateBotLegs(bot, dt, 7.5);
        }
      }
    }
  }

  private animateBotLegs(bot: TacticalBot, dt: number, speed: number): void {
    if (speed <= 0.1) {
      bot.leftLeg.rotation.x = THREE.MathUtils.lerp(bot.leftLeg.rotation.x, 0, dt * 8);
      bot.rightLeg.rotation.x = THREE.MathUtils.lerp(bot.rightLeg.rotation.x, 0, dt * 8);
      return;
    }
    bot.walkCycle += dt * speed;
    bot.leftLeg.rotation.x = Math.sin(bot.walkCycle) * 0.55;
    bot.rightLeg.rotation.x = -Math.sin(bot.walkCycle) * 0.55;
  }

  private botFireShot(bot: TacticalBot, targetPos: THREE.Vector3, targetIsPlayer: boolean): void {
    (bot.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = 0.9;
    const dist = bot.root.position.distanceTo(this.playerPos);

    // Compute stereo pan relative to player camera
    const toBot = bot.root.position.clone().sub(this.playerPos).normalize();
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const pan = camRight.dot(toBot);

    this.audio.playGunshot('5.56x45mm', false, dist, pan);

    if (targetIsPlayer) {
      // Supersonic bullet crack & Stress Suppression increase!
      this.audio.playBulletCrack(pan);
      this.operatorStress = Math.min(1.0, this.operatorStress + 0.14);
      this.recoilChromaticSpike = Math.min(1.0, this.recoilChromaticSpike + 0.35);

      // Hit probability based on distance & player movement/cover
      const hitChance = Math.max(0.08, 0.34 - dist * 0.006);
      if (Math.random() < hitChance) {
        this.applyDamageToPlayer(14, toBot.negate());
      }
    } else {
      // Bot vs Bot engagement
      for (const other of this.bots) {
        if (other.id !== bot.id && !other.isDead && other.root.position.distanceTo(targetPos) < 1.5) {
          if (Math.random() < 0.35) {
            other.applyHit(28, 'TORSO', new THREE.Vector3(0, 0, 1));
          }
          break;
        }
      }
    }
  }

  private applyDamageToPlayer(dmg: number, dir: THREE.Vector3): void {
    // Invulnerable while on the firing lanes in Shooting Range HUB
    if (this.currentMapId === 'SHOOTING_RANGE' && this.playerPos.x < 7.5) {
      return;
    }

    this.playerHealth = Math.max(0, this.playerHealth - dmg);
    this.damageFlash = Math.min(1.0, this.damageFlash + 0.75);
    this.operatorStress = Math.min(1.0, this.operatorStress + 0.28);
    this.recoilPitch += (Math.random() - 0.3) * 0.08;
    this.recoilYaw += dir.x * 0.06;

    if (navigator.vibrate) navigator.vibrate([40, 30, 60]);

    if (this.playerHealth <= 0) {
      this.showDiegeticBanner('💀 OPERATOR DOWN — RESPAWNING WITH FRESH KIT...', 2500);
      this.playerHealth = 100;
      this.operatorStress = 0.1;
      this.playerPos.copy(this.builtMap.playerSpawn);
    }
  }

  // ==================== GRENADES, BODY BOMB & PARTICLE POOLS ====================
  private updateGrenadesAndPools(dt: number): void {
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i];
      g.vel.y -= 14.5 * dt;
      const nextP = g.mesh.position.clone().addScaledVector(g.vel, dt);

      if (nextP.y < 0.06) {
        nextP.y = 0.06;
        g.vel.y = Math.abs(g.vel.y) * 0.45;
        g.vel.x *= 0.72;
        g.vel.z *= 0.72;
      }
      if (this.checkPlayerCollision(nextP, 0.1)) {
        g.vel.x *= -0.55;
        g.vel.z *= -0.55;
      } else {
        g.mesh.position.copy(nextP);
      }

      g.fuseTimer -= dt;
      if (g.fuseTimer <= 0) {
        const gPos = g.mesh.position.clone();
        const distPlayer = gPos.distanceTo(this.playerPos);
        this.audio.playExplosion(g.isFlashbang, distPlayer);
        this.spawnImpactParticles(gPos, g.isFlashbang ? 0xffffff : 0xff6611, 24);

        if (g.isFlashbang) {
          // M84 Stun Grenade: Blind player if looking near it & stun bots!
          if (distPlayer < 16) {
            this.flashbangBlind = Math.min(1.0, (1 - distPlayer / 18) * 1.25);
            this.operatorStress = Math.min(1.0, this.operatorStress + 0.45);
          }
          for (const bot of this.bots) {
            const d = bot.root.position.distanceTo(gPos);
            if (d < 15) bot.applyFlashbang(1 - d / 15);
          }
        } else {
          // M67 Frag Grenade shrapnel damage!
          for (const bot of this.bots) {
            if (bot.isDead) continue;
            const d = bot.root.position.distanceTo(gPos);
            if (d < 10) {
              const dmg = Math.round(150 * (1 - d / 10));
              const res = bot.applyHit(
                dmg,
                'TORSO',
                bot.root.position.clone().sub(gPos).normalize()
              );
              if (res.killed) {
                this.totalKills++;
                this.awardReissadPoints(110);
                this.addKillfeedEntry(`ELIMINATED ${bot.callsign} [M67 FRAG] +110 RP`, '#f59e0b');
              }
            }
          }
        }

        this.scene.remove(g.mesh);
        this.activeGrenades.splice(i, 1);
      }
    }

    // Update Ejected Brass Casings
    for (let i = this.ejectedBrass.length - 1; i >= 0; i--) {
      const b = this.ejectedBrass[i];
      b.vel.y -= 9.8 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
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
        this.scene.remove(b.mesh);
        this.ejectedBrass.splice(i, 1);
      }
    }

    // Update Impact Sparks
    for (let i = this.impactParticles.length - 1; i >= 0; i--) {
      const p = this.impactParticles[i];
      p.vel.y -= 9.8 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.impactParticles.splice(i, 1);
      }
    }
  }

  private updatePhysiologyAndStress(dt: number, elapsed: number): void {
    // Natural stress decay when out of fire, health regen
    this.operatorStress = Math.max(0.05, this.operatorStress - dt * 0.055);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    this.flashbangBlind = Math.max(0, this.flashbangBlind - dt * 0.36);

    if (this.playerHealth < 100 && this.damageFlash <= 0.05) {
      this.playerHealth = Math.min(100, this.playerHealth + dt * 4.5);
    }

    this.audio.updateStressAudio(this.operatorStress, elapsed);

    // Update Vitals HUD
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
      const stance = this.isCrouching ? 'CROUCH' : 'STAND';
      const leanTxt =
        Math.abs(this.leanCurrent) > 0.2
          ? this.leanCurrent > 0
            ? ' · LEAN RIGHT'
            : ' · LEAN LEFT'
          : '';
      stressState.textContent =
        this.operatorStress > 0.48
          ? `STATE: ⚠️ PANICKED (${Math.round(this.operatorStress * 100)}% STRESS — FUMBLE RISK) · ${stance}${leanTxt}`
          : `STATE: CALM (${Math.round(this.operatorStress * 100)}% STRESS — TACTICAL RELOAD) · ${stance}${leanTxt}`;
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
    el.textContent = `2026-10-18 ${hh}:${mm}:${ss} UTC · 1080P 60FPS · ${
      this.postProcess.nvgEnabled ? 'IR NIGHT VISION' : 'TRUE BODY OPTICS'
    }`;
  }

  private updateAxonHeader(): void {
    const el = document.getElementById('axon-mode-line');
    if (!el) return;
    const mapDef = BODYCAM_MAPS.find((m) => m.id === this.currentMapId);
    const modeDef = BODYCAM_MODES.find((m) => m.id === this.currentModeId);
    el.textContent = `MAP: ${mapDef?.name.toUpperCase()} · MODE: ${modeDef?.name.toUpperCase()} · RP: ${this.reissadPoints.toLocaleString()}`;
  }

  private updateHUDWeaponCard(): void {
    const st = this.getActiveWeaponState();
    const stats = this.getComputedWeaponStats(st);
    const nameEl = document.getElementById('hud-weapon-name');
    const attEl = document.getElementById('hud-weapon-attachments');
    const ammoEl = document.getElementById('hud-ammo-estimate');

    if (nameEl) {
      nameEl.textContent = `${st.def.name} [${st.def.caliber}]`;
    }
    if (attEl) {
      attEl.textContent = `${st.attachments.optic.name} · ${st.attachments.muzzle.name}`;
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
      ammoEl.textContent = `MAG: ${feel} · SPARE: ${st.spareMags} MAGS · [${modeName}]`;
    }
  }

  private updateTelemetryAccuracy(): void {
    const el = document.getElementById('telemetry-accuracy');
    if (!el) return;
    const pct = this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    el.textContent = `HITS: ${this.shotsHit} / ${this.shotsFired} (${pct}%) · HEADSHOTS: ${this.headshotsCount} · KILLS: ${this.totalKills}`;
  }

  // ==================== INPUT BINDINGS (MOBILE TOUCH + DESKTOP KB/MOUSE) ====================
  private bindInputs(): void {
    window.addEventListener('keydown', (e) => {
      this.audio.init();
      this.keys[e.code] = true;

      if (e.code === 'KeyR') this.startReload();
      if (e.code === 'KeyM') this.triggerMagCheck();
      if (e.code === 'KeyF') this.toggleFlashlight();
      if (e.code === 'KeyN') this.toggleNVG();
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

    // Desktop Mouse PointerLock + Drag fallback
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
        document.getElementById('tbtn-ads')?.classList.toggle('active', this.isADS);
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
        this.touchLookDelta.x += e.movementX;
        this.touchLookDelta.y += e.movementY;
      } else if (e.buttons === 1 && this.moveTouchId === null) {
        // Allow mouse drag-to-look even if PointerLock is blocked in iframe preview!
        this.touchLookDelta.x += e.movementX * 1.3;
        this.touchLookDelta.y += e.movementY * 1.3;
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
        joystickBase.style.left = `${Math.max(16, t.clientX - 59)}px`;
        joystickBase.style.bottom = `${Math.max(16, window.innerHeight - t.clientY - 59)}px`;
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
            const maxR = 52;
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

    // Right-Half Touch Look Zone
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
            this.touchLookDelta.x += (t.clientX - this.lookTouchLast.x) * 1.65;
            this.touchLookDelta.y += (t.clientY - this.lookTouchLast.y) * 1.65;
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

    // Primary Right-Thumb Fire Button (Supports Dragging to Aim while holding Fire!)
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
        this.touchLookDelta.x += (e.clientX - this.fireTouchLast.x) * 1.5;
        this.touchLookDelta.y += (e.clientY - this.fireTouchLast.y) * 1.5;
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

    // Left-Hand Claw Fire Button
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

    // Bind Mobile Action Buttons (work with both Touch & Click!)
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
      document.getElementById('tbtn-ads')?.classList.toggle('active', this.isADS);
    });
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

    // Optional Mobile Gyroscope Orientation Listener
    window.addEventListener('deviceorientation', (e) => {
      if (!this.gyroEnabled || e.gamma === null || e.beta === null) return;
      this.touchLookDelta.x += e.gamma * 0.04;
      this.touchLookDelta.y += (e.beta - 45) * 0.03;
    });
  }

  private toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.weaponRig.flashlightSpot.intensity =
      this.flashlightOn && this.weaponRig.hasFlashlight ? 3.8 : 0;
    this.audio.playUIClick(1400);
  }

  private toggleNVG(): void {
    this.postProcess.nvgEnabled = !this.postProcess.nvgEnabled;
    document
      .getElementById('btn-toggle-nvg')
      ?.classList.toggle('active', this.postProcess.nvgEnabled);
    this.audio.playUIClick(1750);
  }

  private togglePureDiegeticHUD(): void {
    this.pureDiegeticHud = !this.pureDiegeticHud;
    const tel = document.getElementById('hud-telemetry-row');
    const bot = document.getElementById('hud-bottom-cluster');
    if (tel) tel.style.display = this.pureDiegeticHud ? 'none' : 'flex';
    if (bot) bot.style.display = this.pureDiegeticHud ? 'none' : 'flex';
    document.getElementById('btn-pure-bodycam')?.classList.toggle('active', this.pureDiegeticHud);
    this.showDiegeticBanner(
      this.pureDiegeticHud
        ? 'PURE BODYCAM MODE: ON (NO HUD — USE [M] TO CHECK MAG)'
        : 'TACTICAL TELEMETRY HUD: RESTORED'
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
      this.showDiegeticBanner(`🤖 SPAWNED ${nextCount} TACTICAL AI BOTS IN ARENA`);
    });

    document.getElementById('btn-zone-jump')?.addEventListener('click', () => {
      const inKillhouse = this.playerPos.x > 8;
      if (inKillhouse) {
        this.playerPos.set(-2.5, 0, 3.2);
        this.playerYaw = 0;
        this.showDiegeticBanner('TELEPORTED TO 10m–75m CALIBRATED FIRING LANES');
      } else {
        this.playerPos.set(14.5, 0, 2.5);
        this.playerYaw = 0;
        this.showDiegeticBanner('ENTERED CQB BREACHING KILLHOUSE — AI BOTS ACTIVE!');
      }
      const btn = document.getElementById('btn-zone-jump');
      if (btn) btn.textContent = inKillhouse ? '🏠 TO KILLHOUSE' : '🎯 TO FIRING LANES';
    });

    document
      .getElementById('btn-deploy-drone')
      ?.addEventListener('click', () => this.toggleGadgetDeploy());
    document.getElementById('btn-toggle-nvg')?.addEventListener('click', () => this.toggleNVG());

    document.getElementById('btn-toggle-assist')?.addEventListener('click', (e) => {
      this.aimAssistEnabled = !this.aimAssistEnabled;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.aimAssistEnabled);
      btn.textContent = `🧲 AIM ASSIST: ${this.aimAssistEnabled ? 'ON' : 'OFF'}`;
    });

    document
      .getElementById('btn-pure-bodycam')
      ?.addEventListener('click', () => this.togglePureDiegeticHUD());

    // Drone OSD Buttons
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

    // Tablet Tabs
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

    // Shader & Control Sliders
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
      btn.textContent = `📱 ON-SCREEN MOBILE TOUCH BUTTONS: ${hidden ? 'VISIBLE' : 'HIDDEN'}`;
    });

    document.getElementById('opt-toggle-gyro')?.addEventListener('click', (e) => {
      this.gyroEnabled = !this.gyroEnabled;
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.gyroEnabled);
      btn.textContent = `🧭 MOBILE GYROSCOPE TILT AIMING: ${this.gyroEnabled ? 'ON' : 'OFF'}`;
    });

    document.getElementById('opt-toggle-centerdot')?.addEventListener('click', (e) => {
      const dot = document.getElementById('freeaim-reticle')!;
      const visible = dot.style.display === 'block';
      dot.style.display = visible ? 'none' : 'block';
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', !visible);
      btn.textContent = `➕ FAINT CENTER POINT-AIM DOT: ${!visible ? 'ON' : 'OFF (TRUE BODYCAM)'}`;
    });
  }

  private populateTabletUI(filterCat = 'ALL'): void {
    // 1. Weapon Category Filter Chips
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

    // 2. Render Weapon Cards
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

    // 3. Render 5 Attachment Slots
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

    // 4. Render 8-Stat Inspector Bars (Bodycam v0.8 Official Attachment Effects)
    const titleEl = document.getElementById('inspector-weapon-title')!;
    const descEl = document.getElementById('inspector-weapon-desc')!;
    const barsEl = document.getElementById('inspector-stat-bars')!;

    titleEl.textContent = `${st.def.name} — ${st.def.realCounterpart}`;
    descEl.textContent = st.def.description;

    const cStats = this.getComputedWeaponStats(st);
    const statRows = [
      { label: '1. Damage (Stopping Power)', val: Math.min(100, st.def.damage * (st.def.pellets || 1) * 0.85) },
      { label: '2. Fire Rate (RPM)', val: Math.min(100, (st.def.rpm / 1200) * 100) },
      { label: '3. ADS Speed', val: Math.min(100, (cStats.adsSpeed / 10) * 100) },
      { label: '4. Reload Speed (Calm)', val: Math.min(100, (3.2 / cStats.reloadCalm) * 65) },
      { label: '5. Vertical Recoil Control', val: Math.max(10, 100 - cStats.vRecoil * 1100) },
      { label: '6. Horizontal Stability', val: Math.max(10, 100 - cStats.hRecoil * 1800) },
      { label: '7. Hip/Point-Fire Accuracy', val: Math.max(10, 100 - cStats.spread * 1200) },
      { label: `8. Magazine Capacity (${cStats.magCap} Rnds)`, val: Math.min(100, (cStats.magCap / 40) * 100) },
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

    // 5. Grenade & Gadget Selectors
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

    // 6. Populate Maps & Modes Tab
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

    // Bot Controls in Tablet
    const addBotBtn = document.getElementById('tab-btn-bot-add');
    if (addBotBtn && !addBotBtn.dataset.bound) {
      addBotBtn.dataset.bound = '1';
      addBotBtn.addEventListener('click', () => {
        this.spawnBotsForCurrentMode(this.bots.length + 1);
      });
      document.getElementById('tab-btn-bot-ally')?.addEventListener('click', () => {
        const wp = this.builtMap.botWaypoints[0] || this.playerPos.clone();
        const ally = new TacticalBot(
          `ally_${Date.now()}`,
          'WINGMAN-1',
          'ALLY',
          wp.clone(),
          'PATROL_COMBAT'
        );
        this.bots.push(ally);
        this.scene.add(ally.root);
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

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.gadgets.camera.aspect = w / h;
    this.gadgets.camera.updateProjectionMatrix();
    this.postProcess.setSize(w, h);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new BodycamGameEngine();
});
