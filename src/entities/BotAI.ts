import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

export type BotTeam = 'ENEMY' | 'ALLY' | 'ZOMBIE';
export type BotBehaviorMode = 'PATROL_COMBAT' | 'STATIONARY_GUARD' | 'ZOMBIE_RUSH';

export class TacticalBot {
  public id: string;
  public callsign: string;
  public team: BotTeam;
  public behavior: BotBehaviorMode;
  public root: TransformNode;
  public bodyPivot: TransformNode;
  public headGroup: TransformNode;
  public helmetMesh: Mesh;
  public torsoMesh: Mesh;
  public leftArm: TransformNode;
  public rightArm: TransformNode;
  public leftLeg: TransformNode;
  public rightLeg: TransformNode;
  public muzzleFlash: Mesh;

  public hitMeshes: Mesh[] = [];

  public hp = 100;
  public maxHp = 100;
  public isDead = false;
  public respawnTimer = 0;

  public stumbleTimer = 0;
  public stumbleDir = Vector3.Zero();
  public flashedTimer = 0;
  public deathFallPitch = 0;
  public deathFallRoll = 0;
  public helmetDetached = false;
  public helmetVel = Vector3.Zero();

  public state: 'PATROL' | 'ALERT_INVESTIGATE' | 'ENGAGE' = 'PATROL';
  public targetWaypoint = Vector3.Zero();
  public alertPos = Vector3.Zero();
  public alertTimer = 0;
  public fireCooldown = 0;
  public strafeDir = 1;
  public strafeTimer = 0;
  public leanAngle = 0;
  public walkCycle = 0;

  private static censorTex: DynamicTexture | null = null;

  private static getPixelatedFaceTexture(scene: Scene): DynamicTexture {
    if (this.censorTex) return this.censorTex;
    const dt = new DynamicTexture('censorFaceTex', { width: 64, height: 64 }, scene, false);
    const ctx = dt.getContext() as unknown as CanvasRenderingContext2D;
    const blockSize = 8;
    const tones = ['#c89b7b', '#a8795b', '#dfc4a8', '#7d563c', '#523828', '#e6b89c'];
    for (let y = 0; y < 64; y += blockSize) {
      for (let x = 0; x < 64; x += blockSize) {
        ctx.fillStyle = tones[Math.floor(Math.random() * tones.length)];
        ctx.fillRect(x, y, blockSize, blockSize);
      }
    }
    dt.update(false);
    this.censorTex = dt;
    return dt;
  }

  constructor(
    scene: Scene,
    id: string,
    callsign: string,
    team: BotTeam,
    spawnPos: Vector3,
    behavior: BotBehaviorMode = 'PATROL_COMBAT'
  ) {
    this.id = id;
    this.callsign = callsign;
    this.team = team;
    this.behavior = behavior;

    this.root = new TransformNode(`botRoot_${id}`, scene);
    this.root.position.copyFrom(spawnPos);

    this.bodyPivot = new TransformNode(`botPivot_${id}`, scene);
    this.bodyPivot.parent = this.root;

    const isAlly = team === 'ALLY';
    const isZombie = team === 'ZOMBIE';

    const uniformMat = new PBRMaterial(`botUni_${id}`, scene);
    uniformMat.albedoColor = isZombie
      ? new Color3(0.24, 0.3, 0.2)
      : isAlly
      ? new Color3(0.16, 0.25, 0.32)
      : new Color3(0.26, 0.23, 0.2);
    uniformMat.roughness = 0.78;
    uniformMat.metallic = 0.08;

    const vestMat = new PBRMaterial(`botVest_${id}`, scene);
    vestMat.albedoColor = isZombie
      ? new Color3(0.18, 0.15, 0.12)
      : isAlly
      ? new Color3(0.12, 0.32, 0.75)
      : new Color3(0.36, 0.16, 0.14);
    vestMat.roughness = 0.6;
    vestMat.metallic = 0.2;

    const helmetMat = new PBRMaterial(`botHelm_${id}`, scene);
    helmetMat.albedoColor = isZombie
      ? new Color3(0.28, 0.32, 0.22)
      : isAlly
      ? new Color3(0.14, 0.24, 0.38)
      : new Color3(0.16, 0.18, 0.2);
    helmetMat.roughness = 0.42;
    helmetMat.metallic = 0.45;

    const gunMat = new PBRMaterial(`botGun_${id}`, scene);
    gunMat.albedoColor = new Color3(0.1, 0.11, 0.13);
    gunMat.roughness = 0.32;
    gunMat.metallic = 0.85;

    const registerHitMesh = (mesh: Mesh, zone: 'HEAD' | 'TORSO' | 'LIMB') => {
      mesh.isPickable = true;
      mesh.metadata = { botId: this.id, hitZone: zone };
      this.hitMeshes.push(mesh);
    };

    // 1. Torso & Plate Carrier Vest (+Z is Bot's forward facing direction!)
    this.torsoMesh = MeshBuilder.CreateBox(
      `torso_${id}`,
      { width: 0.44, height: 0.56, depth: 0.25 },
      scene
    );
    this.torsoMesh.position.set(0, 1.16, 0);
    this.torsoMesh.material = uniformMat;
    this.torsoMesh.parent = this.bodyPivot;
    registerHitMesh(this.torsoMesh, 'TORSO');

    const vestMesh = MeshBuilder.CreateBox(
      `vest_${id}`,
      { width: 0.47, height: 0.42, depth: 0.29 },
      scene
    );
    vestMesh.position.set(0, 0.02, 0);
    vestMesh.material = vestMat;
    vestMesh.parent = this.torsoMesh;
    vestMesh.isPickable = false;

    // Glowing IFF Chemlight Patch (Warm/Red on enemies so Thermal & Night Vision highlight them!)
    const patchMat = new StandardMaterial(`patchMat_${id}`, scene);
    patchMat.disableLighting = true;
    patchMat.emissiveColor = isZombie
      ? new Color3(0.6, 1.8, 0.2)
      : isAlly
      ? new Color3(0.2, 1.4, 2.4)
      : new Color3(2.4, 0.3, 0.2);

    const frontPatch = MeshBuilder.CreateBox(
      `patch_${id}`,
      { width: 0.14, height: 0.05, depth: 0.305 },
      scene
    );
    frontPatch.position.set(0, 0.12, 0);
    frontPatch.material = patchMat;
    frontPatch.parent = this.torsoMesh;
    frontPatch.isPickable = false;

    // 2. Head + Authentic Reissad Bodycam Pixelated Mosaic Face Plate + FAST Helmet
    this.headGroup = new TransformNode(`headGrp_${id}`, scene);
    this.headGroup.position.set(0, 1.58, 0);
    this.headGroup.parent = this.bodyPivot;

    const headBox = MeshBuilder.CreateBox(
      `headBox_${id}`,
      { width: 0.23, height: 0.25, depth: 0.23 },
      scene
    );
    headBox.material = uniformMat;
    headBox.parent = this.headGroup;
    registerHitMesh(headBox, 'HEAD');

    const faceMat = new StandardMaterial(`faceMat_${id}`, scene);
    faceMat.diffuseTexture = TacticalBot.getPixelatedFaceTexture(scene);
    faceMat.emissiveColor = new Color3(0.45, 0.35, 0.28);

    const censorFace = MeshBuilder.CreatePlane(
      `censorFace_${id}`,
      { width: 0.24, height: 0.22, sideOrientation: Mesh.DOUBLESIDE },
      scene
    );
    censorFace.position.set(0, 0, 0.122);
    censorFace.material = faceMat;
    censorFace.parent = this.headGroup;
    censorFace.isPickable = false;

    this.helmetMesh = MeshBuilder.CreateBox(
      `helmet_${id}`,
      { width: 0.26, height: 0.14, depth: 0.27 },
      scene
    );
    this.helmetMesh.position.set(0, 0.09, -0.01);
    this.helmetMesh.material = helmetMat;
    this.helmetMesh.parent = this.headGroup;
    registerHitMesh(this.helmetMesh, 'HEAD');

    // 3. Arms & Weapon (+Z forward)
    this.leftArm = new TransformNode(`lArm_${id}`, scene);
    this.leftArm.position.set(-0.29, 1.38, 0);
    this.leftArm.parent = this.bodyPivot;
    const lArmMesh = MeshBuilder.CreateBox(
      `lArmMesh_${id}`,
      { width: 0.13, height: 0.52, depth: 0.13 },
      scene
    );
    lArmMesh.position.set(0, -0.22, 0.14);
    lArmMesh.rotation.x = isZombie ? -1.35 : -0.85;
    lArmMesh.material = uniformMat;
    lArmMesh.parent = this.leftArm;
    registerHitMesh(lArmMesh, 'LIMB');

    this.rightArm = new TransformNode(`rArm_${id}`, scene);
    this.rightArm.position.set(0.29, 1.38, 0);
    this.rightArm.parent = this.bodyPivot;
    const rArmMesh = MeshBuilder.CreateBox(
      `rArmMesh_${id}`,
      { width: 0.13, height: 0.52, depth: 0.13 },
      scene
    );
    rArmMesh.position.set(0, -0.22, 0.14);
    rArmMesh.rotation.x = isZombie ? -1.35 : -0.85;
    rArmMesh.material = uniformMat;
    rArmMesh.parent = this.rightArm;
    registerHitMesh(rArmMesh, 'LIMB');

    const mfMat = new StandardMaterial(`botMf_${id}`, scene);
    mfMat.disableLighting = true;
    mfMat.emissiveColor = new Color3(3.2, 1.8, 0.5);
    mfMat.alpha = 0;

    this.muzzleFlash = MeshBuilder.CreatePolyhedron(
      `botFlash_${id}`,
      { type: 2, size: 0.08 },
      scene
    );
    this.muzzleFlash.material = mfMat;
    this.muzzleFlash.isPickable = false;

    if (!isZombie) {
      const botGun = MeshBuilder.CreateBox(
        `botGun_${id}`,
        { width: 0.06, height: 0.11, depth: 0.65 },
        scene
      );
      botGun.position.set(-0.08, -0.18, 0.38);
      botGun.material = gunMat;
      botGun.parent = this.rightArm;
      botGun.isPickable = false;

      this.muzzleFlash.position.set(-0.08, -0.18, 0.74);
      this.muzzleFlash.parent = this.rightArm;
    }

    // 4. Articulated Legs
    this.leftLeg = new TransformNode(`lLeg_${id}`, scene);
    this.leftLeg.position.set(-0.12, 0.88, 0);
    this.leftLeg.parent = this.bodyPivot;
    const lLegMesh = MeshBuilder.CreateBox(
      `lLegMesh_${id}`,
      { width: 0.16, height: 0.88, depth: 0.17 },
      scene
    );
    lLegMesh.position.set(0, -0.44, 0);
    lLegMesh.material = uniformMat;
    lLegMesh.parent = this.leftLeg;
    registerHitMesh(lLegMesh, 'LIMB');

    this.rightLeg = new TransformNode(`rLeg_${id}`, scene);
    this.rightLeg.position.set(0.12, 0.88, 0);
    this.rightLeg.parent = this.bodyPivot;
    const rLegMesh = MeshBuilder.CreateBox(
      `rLegMesh_${id}`,
      { width: 0.16, height: 0.88, depth: 0.17 },
      scene
    );
    rLegMesh.position.set(0, -0.44, 0);
    rLegMesh.material = uniformMat;
    rLegMesh.parent = this.rightLeg;
    registerHitMesh(rLegMesh, 'LIMB');

    this.targetWaypoint.copyFrom(spawnPos);
  }

  public applyHit(
    damage: number,
    zone: 'HEAD' | 'TORSO' | 'LIMB',
    bulletDir: Vector3
  ): { killed: boolean; headshot: boolean } {
    if (this.isDead) return { killed: false, headshot: false };

    const headshot = zone === 'HEAD';
    this.hp -= damage;

    this.alertPos.copyFrom(this.root.position).addInPlace(bulletDir.scale(-12));
    this.alertTimer = 8.0;
    if (this.state === 'PATROL') this.state = 'ENGAGE';

    if (this.hp <= 0) {
      this.hp = 0;
      this.isDead = true;
      this.respawnTimer = 4.2;
      this.deathFallPitch = (Math.random() > 0.35 ? -1 : 1) * (Math.PI / 2);
      this.deathFallRoll = (Math.random() - 0.5) * 0.6;

      if (headshot && !this.helmetDetached) {
        this.helmetDetached = true;
        this.helmetVel = bulletDir.scale(4.5);
        this.helmetVel.y = 3.8;
      }
      return { killed: true, headshot };
    }

    // Bodycam Ragdoll Stumble on non-lethal hits!
    this.stumbleTimer = zone === 'LIMB' ? 0.68 : 0.45;
    this.stumbleDir = new Vector3(
      bulletDir.x + (Math.random() - 0.5) * 0.6,
      0,
      bulletDir.z + (Math.random() - 0.5) * 0.6
    ).normalize();

    return { killed: false, headshot };
  }

  public applyFlashbang(intensity: number): void {
    if (this.isDead) return;
    this.flashedTimer = Math.max(this.flashedTimer, intensity * 4.5);
    this.stumbleTimer = Math.max(this.stumbleTimer, 0.9);
  }

  public notifySoundHeard(soundOrigin: Vector3): void {
    if (this.isDead || this.team === 'ALLY') return;
    const dist = Vector3.Distance(this.root.position, soundOrigin);
    if (dist < 42) {
      this.alertPos.copyFrom(soundOrigin);
      this.alertTimer = 7.0;
      if (this.state === 'PATROL') {
        this.state = 'ALERT_INVESTIGATE';
      }
    }
  }

  public respawn(pos: Vector3): void {
    this.isDead = false;
    this.hp = this.maxHp;
    this.stumbleTimer = 0;
    this.flashedTimer = 0;
    this.helmetDetached = false;
    this.helmetMesh.position.set(0, 0.09, -0.01);
    this.helmetMesh.rotation.setAll(0);
    this.root.position.copyFrom(pos);
    this.bodyPivot.position.setAll(0);
    this.bodyPivot.rotation.setAll(0);
    this.state = 'PATROL';
    this.targetWaypoint.copyFrom(pos);
  }

  public dispose(): void {
    this.root.dispose();
  }
}
