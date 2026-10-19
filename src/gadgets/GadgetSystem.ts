import * as THREE from 'three';

export type GadgetType = 'FPV_DRONE' | 'RC_CAR';
export type DroneFlightMode = 'CASUAL' | 'ACRO';

export interface ActiveGrenade {
  mesh: THREE.Group;
  vel: THREE.Vector3;
  isFlashbang: boolean;
  fuseTimer: number;
}

export class GadgetSystem {
  public activeGadget: GadgetType | null = null;
  public droneFlightMode: DroneFlightMode = 'CASUAL';
  public meshGroup: THREE.Group;
  public camera: THREE.PerspectiveCamera;
  public pos = new THREE.Vector3();
  public vel = new THREE.Vector3();
  public euler = new THREE.Euler(0, 0, 0, 'YXZ');
  public battery = 100; // 100% down to 0%
  public cooldown = 0;

  // Body Bomb state
  public bombPlanted = false;
  public bombPos = new THREE.Vector3();
  public bombTimer = 40;
  public bombBeepTimer = 0;
  public bombMesh: THREE.Group;
  private bombLight: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.camera = new THREE.PerspectiveCamera(98, window.innerWidth / window.innerHeight, 0.05, 160);
    this.meshGroup = new THREE.Group();
    this.meshGroup.visible = false;
    scene.add(this.meshGroup);

    // Build 3D Quadcopter / RC Car visual mesh
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 0.4, metalness: 0.7 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.28), bodyMat);
    this.meshGroup.add(frame);

    const c4Brick = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.05, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x657353, roughness: 0.8 })
    );
    c4Brick.position.set(0, 0.05, 0);
    this.meshGroup.add(c4Brick);

    // Build 3D Body Bomb Briefcase
    this.bombMesh = new THREE.Group();
    this.bombMesh.visible = false;
    const caseMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.38, 0.12, 0.28),
      new THREE.MeshStandardMaterial({ color: 0x2b2d30, roughness: 0.5, metalness: 0.6 })
    );
    caseMesh.position.y = 0.06;
    this.bombMesh.add(caseMesh);

    this.bombLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    this.bombLight.position.set(0, 0.13, 0);
    this.bombMesh.add(this.bombLight);
    scene.add(this.bombMesh);
  }

  public deploy(
    type: GadgetType,
    flightMode: DroneFlightMode,
    operatorPos: THREE.Vector3,
    operatorYaw: number
  ): boolean {
    if (this.cooldown > 0 || this.activeGadget !== null) return false;
    this.activeGadget = type;
    this.droneFlightMode = flightMode;
    this.battery = 100;

    const forward = new THREE.Vector3(-Math.sin(operatorYaw), 0, -Math.cos(operatorYaw));
    this.pos.copy(operatorPos).addScaledVector(forward, 0.9);
    this.pos.y = type === 'FPV_DRONE' ? 1.55 : 0.22;
    this.vel.set(0, 0, 0);
    this.euler.set(0, operatorYaw, 0, 'YXZ');

    this.meshGroup.position.copy(this.pos);
    this.meshGroup.rotation.copy(this.euler);
    this.meshGroup.visible = true;
    return true;
  }

  public recallOrDestroy(triggerCooldown = 8.0): void {
    this.activeGadget = null;
    this.meshGroup.visible = false;
    this.cooldown = triggerCooldown;
  }

  public update(
    dt: number,
    input: {
      moveForward: number; // -1..1
      moveRight: number; // -1..1
      vertical: number; // -1..1 (up/down)
      lookDeltaX: number;
      lookDeltaY: number;
    },
    colliders: THREE.Box3[]
  ): { throttleLevel: number } {
    if (this.cooldown > 0) {
      this.cooldown = Math.max(0, this.cooldown - dt);
    }

    if (!this.activeGadget) return { throttleLevel: 0 };

    this.battery = Math.max(0, this.battery - dt * 3.8);
    if (this.battery <= 0) {
      this.recallOrDestroy(6.0);
      return { throttleLevel: 0 };
    }

    let throttleLevel = 0.35;

    if (this.activeGadget === 'FPV_DRONE') {
      if (this.droneFlightMode === 'CASUAL') {
        // Stabilized Casual Mode: auto-levels pitch/roll and holds altitude
        this.euler.y -= input.lookDeltaX * 1.1;
        this.euler.x = THREE.MathUtils.clamp(
          this.euler.x - input.lookDeltaY * 0.8,
          -0.85,
          0.85
        );
        // Gentle visual bank on strafe/forward
        const targetRoll = -input.moveRight * 0.22;
        this.euler.z = THREE.MathUtils.lerp(this.euler.z, targetRoll, dt * 8);

        const forward = new THREE.Vector3(-Math.sin(this.euler.y), 0, -Math.cos(this.euler.y));
        const right = new THREE.Vector3(Math.cos(this.euler.y), 0, -Math.sin(this.euler.y));

        const wishVel = new THREE.Vector3();
        wishVel.addScaledVector(forward, input.moveForward * 9.5);
        wishVel.addScaledVector(right, input.moveRight * 8.5);
        wishVel.y = input.vertical * 5.5;

        this.vel.lerp(wishVel, dt * 6.5);
        throttleLevel = Math.min(1, 0.3 + this.vel.length() / 10);
      } else {
        // ACRO Mode: Full Manual FPV Physics (no auto-level, thrust along quadcopter up-axis!)
        this.euler.y -= input.moveRight * dt * 2.2 + input.lookDeltaX * 0.9;
        this.euler.x = THREE.MathUtils.clamp(
          this.euler.x - input.lookDeltaY * 1.25 - input.moveForward * dt * 1.8,
          -1.25,
          1.25
        );
        this.euler.z = THREE.MathUtils.clamp(
          this.euler.z - input.moveRight * dt * 2.4,
          -1.15,
          1.15
        );

        const quat = new THREE.Quaternion().setFromEuler(this.euler);
        const thrustDir = new THREE.Vector3(0, 1, -0.35).applyQuaternion(quat).normalize();
        const thrustPower = 11.2 + input.vertical * 7.5 + Math.abs(input.moveForward) * 4.5;

        // Gravity + Air Drag + Quadcopter Thrust
        this.vel.y -= 9.8 * dt;
        this.vel.addScaledVector(thrustDir, thrustPower * dt);
        this.vel.multiplyScalar(Math.max(0, 1 - dt * 1.8));
        throttleLevel = Math.min(1, 0.45 + Math.abs(input.vertical) * 0.4 + this.vel.length() / 14);
      }

      const nextPos = this.pos.clone().addScaledVector(this.vel, dt);
      nextPos.y = Math.max(0.25, Math.min(22, nextPos.y));

      // Simple sphere-box collision check
      const droneBox = new THREE.Box3().setFromCenterAndSize(
        nextPos,
        new THREE.Vector3(0.35, 0.25, 0.35)
      );
      let blocked = false;
      for (const c of colliders) {
        if (c.intersectsBox(droneBox)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        this.pos.copy(nextPos);
      } else {
        this.vel.multiplyScalar(-0.35);
      }
    } else {
      // RC_CAR Mode: Fast ground-hugging explosive recon rover
      this.euler.y -= (input.moveRight * dt * 2.8 + input.lookDeltaX * 1.0);
      this.euler.x = 0.08; // Slight upward camera tilt from floor level
      this.euler.z = 0;

      const forward = new THREE.Vector3(-Math.sin(this.euler.y), 0, -Math.cos(this.euler.y));
      const targetSpeed = input.moveForward * 11.5;
      const wishVel = forward.multiplyScalar(targetSpeed);
      this.vel.lerp(wishVel, dt * 8.0);
      this.pos.y = 0.2;

      const nextPos = this.pos.clone().addScaledVector(this.vel, dt);
      const carBox = new THREE.Box3().setFromCenterAndSize(
        nextPos,
        new THREE.Vector3(0.35, 0.25, 0.35)
      );
      let blocked = false;
      for (const c of colliders) {
        if (c.intersectsBox(carBox)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        this.pos.copy(nextPos);
      } else {
        this.vel.set(0, 0, 0);
      }
      throttleLevel = Math.min(1, 0.2 + this.vel.length() / 11.5);
    }

    this.meshGroup.position.copy(this.pos);
    this.meshGroup.rotation.copy(this.euler);
    this.camera.position.copy(this.pos);
    this.camera.rotation.copy(this.euler);

    return { throttleLevel };
  }

  public plantBodyBomb(pos: THREE.Vector3): void {
    this.bombPlanted = true;
    this.bombTimer = 40.0;
    this.bombBeepTimer = 0;
    this.bombPos.copy(pos);
    this.bombPos.y = 0;
    this.bombMesh.position.copy(this.bombPos);
    this.bombMesh.visible = true;
  }

  public defuseOrResetBomb(): void {
    this.bombPlanted = false;
    this.bombMesh.visible = false;
  }

  public updateBomb(dt: number): { beeped: boolean; exploded: boolean } {
    if (!this.bombPlanted) return { beeped: false, exploded: false };

    this.bombTimer -= dt;
    this.bombBeepTimer -= dt;

    let beeped = false;
    // Beep frequency accelerates as timer approaches 0!
    const interval = Math.max(0.14, (this.bombTimer / 40) * 1.1);
    if (this.bombBeepTimer <= 0) {
      this.bombBeepTimer = interval;
      beeped = true;
      (this.bombLight.material as THREE.MeshBasicMaterial).color.setHex(
        this.bombLight.visible ? 0xff2222 : 0x440000
      );
    }

    if (this.bombTimer <= 0) {
      this.bombPlanted = false;
      this.bombMesh.visible = false;
      return { beeped: false, exploded: true };
    }

    return { beeped, exploded: false };
  }
}
