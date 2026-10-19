import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  UniversalCamera,
  Vector3,
} from '@babylonjs/core';

export type GadgetType = 'FPV_DRONE' | 'RC_CAR';
export type DroneFlightMode = 'CASUAL' | 'ACRO';

export interface ActiveGrenade {
  mesh: TransformNode;
  vel: Vector3;
  isFlashbang: boolean;
  fuseTimer: number;
}

export class GadgetSystem {
  public activeGadget: GadgetType | null = null;
  public droneFlightMode: DroneFlightMode = 'CASUAL';
  public meshGroup: TransformNode;
  public camera: UniversalCamera;
  public pos = Vector3.Zero();
  public vel = Vector3.Zero();
  public rot = Vector3.Zero(); // pitch (x), yaw (y), roll (z)
  public battery = 100;
  public cooldown = 0;

  public bombPlanted = false;
  public bombPos = Vector3.Zero();
  public bombTimer = 40;
  public bombBeepTimer = 0;
  public bombMesh: TransformNode;
  private bombLight: Mesh;

  constructor(scene: Scene) {
    this.camera = new UniversalCamera('gadgetCamera', new Vector3(0, 2, 0), scene);
    this.camera.fov = 1.48; // Wide-angle FPV camera lens
    this.camera.minZ = 0.05;
    this.camera.maxZ = 180;

    this.meshGroup = new TransformNode('gadgetMeshGroup', scene);
    this.meshGroup.setEnabled(false);

    const bodyMat = new PBRMaterial('droneBodyMat', scene);
    bodyMat.albedoColor = new Color3(0.14, 0.16, 0.19);
    bodyMat.metallic = 0.75;
    bodyMat.roughness = 0.35;

    const frame = MeshBuilder.CreateBox(
      'droneFrame',
      { width: 0.24, height: 0.06, depth: 0.28 },
      scene
    );
    frame.material = bodyMat;
    frame.parent = this.meshGroup;
    frame.isPickable = false;

    const c4Mat = new PBRMaterial('c4Mat', scene);
    c4Mat.albedoColor = new Color3(0.4, 0.45, 0.32);
    c4Mat.roughness = 0.8;
    const c4Brick = MeshBuilder.CreateBox(
      'c4Brick',
      { width: 0.12, height: 0.05, depth: 0.16 },
      scene
    );
    c4Brick.position.set(0, 0.05, 0);
    c4Brick.material = c4Mat;
    c4Brick.parent = this.meshGroup;
    c4Brick.isPickable = false;

    this.bombMesh = new TransformNode('bodyBombGroup', scene);
    this.bombMesh.setEnabled(false);
    const caseMesh = MeshBuilder.CreateBox(
      'bombCase',
      { width: 0.38, height: 0.12, depth: 0.28 },
      scene
    );
    caseMesh.position.y = 0.06;
    caseMesh.material = bodyMat;
    caseMesh.parent = this.bombMesh;

    const lightMat = new StandardMaterial('bombLightMat', scene);
    lightMat.disableLighting = true;
    lightMat.emissiveColor = new Color3(3.0, 0.2, 0.2);

    this.bombLight = MeshBuilder.CreateSphere('bombLed', { diameter: 0.06, segments: 8 }, scene);
    this.bombLight.position.set(0, 0.13, 0);
    this.bombLight.material = lightMat;
    this.bombLight.parent = this.bombMesh;
  }

  public deploy(
    type: GadgetType,
    flightMode: DroneFlightMode,
    operatorPos: Vector3,
    operatorYaw: number
  ): boolean {
    if (this.cooldown > 0 || this.activeGadget !== null) return false;
    this.activeGadget = type;
    this.droneFlightMode = flightMode;
    this.battery = 100;

    const forward = new Vector3(Math.sin(operatorYaw), 0, Math.cos(operatorYaw));
    this.pos.copyFrom(operatorPos).addInPlace(forward.scale(0.95));
    this.pos.y = type === 'FPV_DRONE' ? 1.55 : 0.22;
    this.vel.setAll(0);
    this.rot.set(0, operatorYaw, 0);

    this.meshGroup.position.copyFrom(this.pos);
    this.meshGroup.rotation.copyFrom(this.rot);
    this.meshGroup.setEnabled(true);
    return true;
  }

  public recallOrDestroy(triggerCooldown = 6.0): void {
    this.activeGadget = null;
    this.meshGroup.setEnabled(false);
    this.cooldown = triggerCooldown;
  }

  public update(
    dt: number,
    input: {
      moveForward: number;
      moveRight: number;
      vertical: number;
      lookDeltaX: number;
      lookDeltaY: number;
    }
  ): { throttleLevel: number } {
    if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
    }
    if (!this.activeGadget) return { throttleLevel: 0 };

    this.battery = Math.max(0, this.battery - dt * 3.5);
    if (this.battery <= 0) {
      this.recallOrDestroy(5.0);
      return { throttleLevel: 0 };
    }

    let throttleLevel = 0.35;

    if (this.activeGadget === 'FPV_DRONE') {
      if (this.droneFlightMode === 'CASUAL') {
        this.rot.y += input.lookDeltaX * 1.1;
        this.rot.x = Math.max(-0.85, Math.min(0.85, this.rot.x + input.lookDeltaY * 0.8));
        const targetRoll = -input.moveRight * 0.22;
        this.rot.z += (targetRoll - this.rot.z) * Math.min(1, dt * 8);

        const forward = new Vector3(Math.sin(this.rot.y), 0, Math.cos(this.rot.y));
        const right = new Vector3(Math.cos(this.rot.y), 0, -Math.sin(this.rot.y));

        const wishVel = Vector3.Zero();
        wishVel.addInPlace(forward.scale(input.moveForward * 9.8));
        wishVel.addInPlace(right.scale(input.moveRight * 8.5));
        wishVel.y = input.vertical * 5.5;

        Vector3.LerpToRef(this.vel, wishVel, Math.min(1, dt * 6.5), this.vel);
        throttleLevel = Math.min(1, 0.3 + this.vel.length() / 10);
      } else {
        // ACRO Mode: Full Manual FPV Physics
        this.rot.y += input.moveRight * dt * 2.1 + input.lookDeltaX * 0.9;
        this.rot.x = Math.max(
          -1.25,
          Math.min(1.25, this.rot.x + input.lookDeltaY * 1.2 + input.moveForward * dt * 1.8)
        );
        this.rot.z = Math.max(-1.15, Math.min(1.15, this.rot.z - input.moveRight * dt * 2.3));

        const quat = Quaternion.RotationYawPitchRoll(this.rot.y, this.rot.x, this.rot.z);
        const thrustDir = new Vector3(0, 1, 0.35).applyRotationQuaternion(quat).normalize();
        const thrustPower = 11.2 + input.vertical * 7.5 + Math.abs(input.moveForward) * 4.5;

        this.vel.y -= 9.8 * dt;
        this.vel.addInPlace(thrustDir.scale(thrustPower * dt));
        this.vel.scaleInPlace(Math.max(0, 1 - dt * 1.8));
        throttleLevel = Math.min(1, 0.45 + Math.abs(input.vertical) * 0.4 + this.vel.length() / 14);
      }

      this.pos.addInPlace(this.vel.scale(dt));
      this.pos.y = Math.max(0.28, Math.min(22, this.pos.y));
    } else {
      // RC_CAR Mode
      this.rot.y += input.moveRight * dt * 2.8 + input.lookDeltaX * 1.0;
      this.rot.x = -0.08;
      this.rot.z = 0;

      const forward = new Vector3(Math.sin(this.rot.y), 0, Math.cos(this.rot.y));
      const wishVel = forward.scale(input.moveForward * 11.5);
      Vector3.LerpToRef(this.vel, wishVel, Math.min(1, dt * 8.0), this.vel);
      this.pos.addInPlace(this.vel.scale(dt));
      this.pos.y = 0.22;
      throttleLevel = Math.min(1, 0.2 + this.vel.length() / 11.5);
    }

    this.meshGroup.position.copyFrom(this.pos);
    this.meshGroup.rotation.copyFrom(this.rot);
    this.camera.position.copyFrom(this.pos);
    this.camera.rotation.copyFrom(this.rot);

    return { throttleLevel };
  }

  public defuseOrResetBomb(): void {
    this.bombPlanted = false;
    this.bombMesh.setEnabled(false);
  }
}
