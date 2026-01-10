import type * as THREE from 'three';
import type { DistanceConstraint, Particle } from './physics/physics';
import type { HistoryAction, ThreadConnection } from './types';

export class AppState {
  nodes: THREE.Mesh[] = [];
  threads: ThreadConnection[] = [];
  particles: Particle[] = [];
  constraints: DistanceConstraint[] = [];
  history: HistoryAction[] = [];
  lastNode: THREE.Mesh | null = null;
  pendingNewOrigin = false;
  isUndoing = false;
  customMeshPath: string | null = null;
  customMeshText: string | null = null;
  structureRevision = 0;

  incrementStructureRevision() {
    this.structureRevision++;
  }
}
