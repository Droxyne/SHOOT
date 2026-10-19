import { Vector3 } from '@babylonjs/core';

/**
 * 2nd-Order Harmonic Spring-Damper Solver for AAA Procedural FPS Weapon & Camera Motion
 * Simulates physical mass, stiffness, damping, and impulse forces (recoil, sway, footsteps, wall bump).
 */
export class SpringVector3 {
  public position: Vector3;
  public velocity: Vector3;
  public target: Vector3;
  public stiffness: number;
  public damping: number;

  constructor(stiffness = 160, damping = 18, initial = Vector3.Zero()) {
    this.position = initial.clone();
    this.velocity = Vector3.Zero();
    this.target = initial.clone();
    this.stiffness = stiffness;
    this.damping = damping;
  }

  public impulse(force: Vector3): void {
    this.velocity.addInPlace(force);
  }

  public impulseXYZ(x: number, y: number, z: number): void {
    this.velocity.x += x;
    this.velocity.y += y;
    this.velocity.z += z;
  }

  public update(dt: number): Vector3 {
    // Sub-step to guarantee stability even on mobile frame drops
    const steps = dt > 0.02 ? 2 : 1;
    const stepDt = Math.min(dt, 0.04) / steps;

    for (let i = 0; i < steps; i++) {
      const fx = (this.target.x - this.position.x) * this.stiffness - this.velocity.x * this.damping;
      const fy = (this.target.y - this.position.y) * this.stiffness - this.velocity.y * this.damping;
      const fz = (this.target.z - this.position.z) * this.stiffness - this.velocity.z * this.damping;

      this.velocity.x += fx * stepDt;
      this.velocity.y += fy * stepDt;
      this.velocity.z += fz * stepDt;

      this.position.x += this.velocity.x * stepDt;
      this.position.y += this.velocity.y * stepDt;
      this.position.z += this.velocity.z * stepDt;
    }

    return this.position;
  }

  public reset(): void {
    this.position.copyFrom(this.target);
    this.velocity.setAll(0);
  }
}
