import * as THREE from 'three';
import type { Settings } from '../types';

export class Particle {
  pos: THREE.Vector3;
  prevPos: THREE.Vector3;
  invMass: number;
  extraConnections = 0;
  structuralConnections = 0;
  mesh: THREE.Mesh | null = null;

  constructor(x: number, y: number, z: number, mass = 1) {
    this.pos = new THREE.Vector3(x, y, z);
    this.prevPos = new THREE.Vector3(x, y, z);
    this.invMass = mass > 0 ? 1 / mass : 0;
  }
}

export class DistanceConstraint {
  p1: Particle;
  p2: Particle;
  restLength: number;
  baseRestLength: number;
  stiffness: number;
  isExtra = false;
  connectionType: 'structural' | 'connection' | 'interpolated' = 'structural';

  constructor(p1: Particle, p2: Particle, stiffness: number) {
    this.p1 = p1;
    this.p2 = p2;
    this.restLength = p1.pos.distanceTo(p2.pos);
    this.baseRestLength = this.restLength;
    this.stiffness = stiffness;
  }

  solve() {
    const totalInvMass = this.p1.invMass + this.p2.invMass;
    if (totalInvMass === 0) return;

    const delta = new THREE.Vector3().subVectors(this.p2.pos, this.p1.pos);
    const currentDist = delta.length();
    if (currentDist === 0) return;

    const error = (currentDist - this.restLength) / currentDist;
    delta.multiplyScalar(error * this.stiffness);

    if (this.p1.invMass > 0) {
      this.p1.pos.addScaledVector(delta, this.p1.invMass / totalInvMass);
    }
    if (this.p2.invMass > 0) {
      this.p2.pos.addScaledVector(delta, -this.p2.invMass / totalInvMass);
    }
  }
}

export function getTotalConnections(particle: Particle | null): number {
  if (!particle) return 0;
  return (particle.extraConnections || 0) + (particle.structuralConnections || 0);
}

export function canAddExtraConnection(particle: Particle | null, maxConnections: number): boolean {
  if (!particle) return false;
  return getTotalConnections(particle) < maxConnections;
}

export function incrementExtraConnection(particle: Particle | null) {
  if (!particle) return;
  particle.extraConnections = (particle.extraConnections || 0) + 1;
}

export function decrementExtraConnection(particle: Particle | null) {
  if (!particle) return;
  particle.extraConnections = Math.max(0, (particle.extraConnections || 0) - 1);
}

export function incrementStructuralConnection(particle: Particle | null) {
  if (!particle) return;
  particle.structuralConnections = (particle.structuralConnections || 0) + 1;
}

export function decrementStructuralConnection(particle: Particle | null) {
  if (!particle) return;
  particle.structuralConnections = Math.max(0, (particle.structuralConnections || 0) - 1);
}

export function applyConnectionRestLength(constraint: DistanceConstraint, factor: number) {
  if (!constraint) return;
  if (constraint.connectionType === 'connection' || constraint.connectionType === 'interpolated') {
    constraint.restLength = constraint.baseRestLength * factor;
  }
}

interface SimulationOptions {
  settings: Settings;
  particles: Particle[];
  constraints: DistanceConstraint[];
  draggedParticle: Particle | null;
  dt: number;
  substeps: number;
  enableCollision: boolean;
  enforceCollision: (particle: Particle) => void;
  updateThreadGeometries: () => void;
  preintegrated?: boolean;
}

export function simulatePhysics(options: SimulationOptions) {
  if (!options.settings.enablePhysics) return;
  const gravity = new THREE.Vector3(0, -options.settings.gravity * options.dt, 0);

  if (!options.preintegrated) {
    for (const p of options.particles) {
      if (p.invMass === 0) continue;
      if (options.draggedParticle === p) continue;

      const velocity = new THREE.Vector3().subVectors(p.pos, p.prevPos);
      velocity.multiplyScalar(options.settings.damping);

      p.prevPos.copy(p.pos);
      p.pos.add(velocity).addScaledVector(gravity, options.dt);
    }
  }

  for (let i = 0; i < options.substeps; i++) {
    for (const c of options.constraints) {
      c.solve();
    }
  }

  if (options.enableCollision) {
    for (const p of options.particles) {
      if (p.invMass > 0 || p === options.draggedParticle) {
        options.enforceCollision(p);
      }
    }
  }

  for (const p of options.particles) {
    if (p.mesh) {
      p.mesh.position.copy(p.pos);
    }
  }

  options.updateThreadGeometries();
}
