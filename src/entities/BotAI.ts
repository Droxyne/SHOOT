import * as THREE from 'three';

export type BotTeam = 'ENEMY' | 'ALLY' | 'ZOMBIE';
export type BotBehaviorMode = 'PATROL_COMBAT' | 'STATIONARY_GUARD' | 'ZOMBIE_RUSH';

export interface BotHitPart {
  botId: string;
  zone: 'HEAD' | 'TORSO' | 'LIMB';
}

export class TacticalBot {
  public id: string;
  public callsign: string;
  public team: BotTeam;
  public behavior: BotBehaviorMode;
  public root: THREE.Group;
  public bodyPivot: THREE.Group;
  public headGroup: THREE.Group;
  public helmetMesh: THREE.Mesh;
  public torsoMesh: THREE.Mesh;
  public leftArm: THREE.Group;
  public rightArm: THREE.Group;
  public leftLeg: THREE.Group;
  public rightLeg: THREE.Group;
  public muzzleFlash: THREE.Mesh;

  public hitMeshes: THREE.Mesh[] = [];

  public hp = 100;
  public maxHp = 100;
  public isDead = false;
  public respawnTimer = 0;

  // Bodycam Ragdoll Stumbling & Death Physics
  public stumbleTimer = 0;
  public stumbleDir = new THREE.Vector3();
  public flashedTimer = 0;
  public deathVel = new THREE.Vector3();
  public deathFallPitch = 0;
  public deathFallRoll = 0;
  public helmetDetached = false;
  public helmetVel = new THREE.Vector3();

  // Tactical AI State
  public state: 'PATROL' | 'ALERT_INVESTIGATE' | 'ENGAGE' | 'TAKE_COVER' = 'PATROL';
  public targetWaypoint = new THREE.Vector3();
  public alertPos = new THREE.Vector3();
  public alertTimer = 0;
  public fireCooldown = 0;
  public burstRemaining = 0;
  public reactionTimer = 0;
  public strafeDir = 1;
  public strafeTimer = 0;
  public leanAngle = 0;
  public walkCycle = 0;

  private static censorTex: THREE.CanvasTexture | null = null;

  private static getPixelatedFaceTexture(): THREE.CanvasTexture {
    if (this.censorTex) return this.censorTex;
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const blockSize = 8; // Coarse mosaic law-enforcement face blur!
    const tones = ['#c89b7b', '#a8795b', '#dfc4a8', '#7d563c', '#523828', '#e6b89c'];
    for (let y = 0; y < 64; y += blockSize) {
      for (let x = 0; x < 64; x += blockSize) {
        ctx.fillStyle = tones[Math.floor(Math.random() * tones.length)];
        ctx.fillRect(x, y, blockSize, blockSize);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.censorTex = tex;
    return tex;
  }

  constructor(
    id: string,
    callsign: string,
    team: BotTeam,
    spawnPos: THREE.Vector3,
    behavior: BotBehaviorMode = 'PATROL_COMBAT'
  ) {
    this.id = id;
    this.callsign = callsign;
    this.team = team;
    this.behavior = behavior;

    this.root = new THREE.Group();
    this.root.position.copy(spawnPos);

    this.bodyPivot = new THREE.Group();
    this.root.add(this.bodyPivot);

    const isAlly = team === 'ALLY';
    const isZombie = team === 'ZOMBIE';

    const uniformColor = isZombie ? 0x3b4732 : isAlly ? 0x263e4a : 0x3b3630;
    const vestColor = isZombie ? 0x2b241d : isAlly ? 0x1d4ed8 : 0x4b2420;
    const helmetColor = isZombie ? 0x454d38 : isAlly ? 0x1e3a5f : 0x282b2e;

    const uniformMat = new THREE.MeshStandardMaterial({ color: uniformColor, roughness: 0.8 });
    const vestMat = new THREE.MeshStandardMaterial({ color: vestColor, roughness: 0.65 });
    const helmetMat = new THREE.MeshStandardMaterial({
      color: helmetColor,
      roughness: 0.45,
      metalness: 0.35,
    });
    const gunMat = new THREE.MeshStandardMaterial({
      color: 0x181a1c,
      roughness: 0.35,
      metalness: 0.8,
    });

    const registerHitMesh = (mesh: THREE.Mesh, zone: 'HEAD' | 'TORSO' | 'LIMB') => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { botId: this.id, hitZone: zone } as BotHitPart & { hitZone: string };
      this.hitMeshes.push(mesh);
    };

    // 1. Torso & Tactical Plate Carrier
    this.torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.25), uniformMat);
    this.torsoMesh.position.set(0, 1.16, 0);
    this.bodyPivot.add(this.torsoMesh);
    registerHitMesh(this.torsoMesh, 'TORSO');

    const vestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.47, 0.42, 0.29), vestMat);
    vestMesh.position.set(0, 0.02, 0);
    this.torsoMesh.add(vestMesh);

    // Team IFF Chemlight / Patch on Chest & Back
    const patchMat = new THREE.MeshBasicMaterial({
      color: isZombie ? 0x84cc16 : isAlly ? 0x38bdf8 : 0xef4444,
    });
    const frontPatch = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.305), patchMat);
    frontPatch.position.set(0, 0.12, 0);
    this.torsoMesh.add(frontPatch);

    // 2. Head + Authentic Bodycam Pixelated Face Blur + Ballistic Helmet
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 1.58, 0);
    this.bodyPivot.add(this.headGroup);

    const headBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.23, 0.25, 0.23),
      new THREE.MeshStandardMaterial({ color: isZombie ? 0x657854 : 0x262626, roughness: 0.7 })
    );
    this.headGroup.add(headBox);
    registerHitMesh(headBox, 'HEAD');

    // Signature Reissad Studio Bodycam Pixelated Mosaic Censorship Face Plate!
    const censorFace = new THREE.Mesh(
      new THREE.PlaneGeometry(0.24, 0.22),
      new THREE.MeshBasicMaterial({
        map: TacticalBot.getPixelatedFaceTexture(),
        side: THREE.DoubleSide,
      })
    );
    censorFace.position.set(0, 0, -0.122);
    this.headGroup.add(censorFace);

    this.helmetMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.27), helmetMat);
    this.helmetMesh.position.set(0, 0.09, 0.01);
    this.headGroup.add(this.helmetMesh);
    registerHitMesh(this.helmetMesh, 'HEAD');

    // 3. Arms & Weapon
    this.leftArm = new THREE.Group();
    this.leftArm.position.set(-0.29, 1.38, 0);
    const lArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.52, 0.13), uniformMat);
    lArmMesh.position.set(0, -0.22, -0.14);
    lArmMesh.rotation.x = isZombie ? 1.35 : 0.85;
    this.leftArm.add(lArmMesh);
    this.bodyPivot.add(this.leftArm);
    registerHitMesh(lArmMesh, 'LIMB');

    this.rightArm = new THREE.Group();
    this.rightArm.position.set(0.29, 1.38, 0);
    const rArmMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.52, 0.13), uniformMat);
    rArmMesh.position.set(0, -0.22, -0.14);
    rArmMesh.rotation.x = isZombie ? 1.35 : 0.85;
    this.rightArm.add(rArmMesh);
    this.bodyPivot.add(this.rightArm);
    registerHitMesh(rArmMesh, 'LIMB');

    // Bot 3D Rifle + Muzzle Flash
    this.muzzleFlash = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.08, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffaa33,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
      })
    );
    if (!isZombie) {
      const botGun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.11, 0.65), gunMat);
      botGun.position.set(-0.08, -0.18, -0.38);
      this.rightArm.add(botGun);
      this.muzzleFlash.position.set(-0.08, -0.18, -0.74);
      this.rightArm.add(this.muzzleFlash);
    }

    // 4. Legs
    this.leftLeg = new THREE.Group();
    this.leftLeg.position.set(-0.12, 0.88, 0);
    const lLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.88, 0.17), uniformMat);
    lLegMesh.position.set(0, -0.44, 0);
    this.leftLeg.add(lLegMesh);
    this.bodyPivot.add(this.leftLeg);
    registerHitMesh(lLegMesh, 'LIMB');

    this.rightLeg = new THREE.Group();
    this.rightLeg.position.set(0.12, 0.88, 0);
    const rLegMesh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.88, 0.17), uniformMat);
    rLegMesh.position.set(0, -0.44, 0);
    this.rightLeg.add(rLegMesh);
    this.bodyPivot.add(this.rightLeg);
    registerHitMesh(rLegMesh, 'LIMB');

    this.targetWaypoint.copy(spawnPos);
  }

  public applyHit(
    damage: number,
    zone: 'HEAD' | 'TORSO' | 'LIMB',
    bulletDir: THREE.Vector3
  ): { killed: boolean; headshot: boolean } {
    if (this.isDead) return { killed: false, headshot: false };

    const headshot = zone === 'HEAD';
    this.hp -= damage;

    // Alert bot immediately toward shooter
    this.alertPos.copy(this.root.position).addScaledVector(bulletDir, -12);
    this.alertTimer = 8.0;
    if (this.state === 'PATROL') this.state = 'ENGAGE';

    if (this.hp <= 0) {
      this.hp = 0;
      this.isDead = true;
      this.respawnTimer = 4.5;
      this.deathVel.copy(bulletDir).multiplyScalar(headshot ? 3.8 : 2.2);
      this.deathVel.y = 0.8;
      this.deathFallPitch = (Math.random() > 0.35 ? 1 : -1) * (Math.PI / 2);
      this.deathFallRoll = (Math.random() - 0.5) * 0.6;

      if (headshot && !this.helmetDetached) {
        this.helmetDetached = true;
        this.helmetVel.copy(bulletDir).multiplyScalar(4.5);
        this.helmetVel.y = 3.8;
      }
      return { killed: true, headshot };
    }

    // Trigger Bodycam's signature Ragdoll Stumble on non-lethal hits!
    this.stumbleTimer = zone === 'LIMB' ? 0.68 : 0.45;
    this.stumbleDir
      .set(bulletDir.x + (Math.random() - 0.5) * 0.6, 0, bulletDir.z + (Math.random() - 0.5) * 0.6)
      .normalize();

    return { killed: false, headshot };
  }

  public applyFlashbang(intensity: number): void {
    if (this.isDead) return;
    this.flashedTimer = Math.max(this.flashedTimer, intensity * 4.5);
    this.stumbleTimer = Math.max(this.stumbleTimer, 0.9);
  }

  public notifySoundHeard(soundOrigin: THREE.Vector3): void {
    if (this.isDead || this.team === 'ALLY') return;
    const dist = this.root.position.distanceTo(soundOrigin);
    if (dist < 42) {
      this.alertPos.copy(soundOrigin);
      this.alertTimer = 7.0;
      if (this.state === 'PATROL') {
        this.state = 'ALERT_INVESTIGATE';
      }
    }
  }

  public respawn(pos: THREE.Vector3): void {
    this.isDead = false;
    this.hp = this.maxHp;
    this.stumbleTimer = 0;
    this.flashedTimer = 0;
    this.helmetDetached = false;
    this.helmetMesh.position.set(0, 0.09, 0.01);
    this.helmetMesh.rotation.set(0, 0, 0);
    this.root.position.copy(pos);
    this.bodyPivot.position.set(0, 0, 0);
    this.bodyPivot.rotation.set(0, 0, 0);
    this.state = 'PATROL';
    this.targetWaypoint.copy(pos);
  }
}
