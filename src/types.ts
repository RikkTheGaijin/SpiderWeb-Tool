import type * as THREE from 'three';
import type { DistanceConstraint, Particle } from './physics/physics';

export interface Settings {
  intermediateNodes: number;
  nodeSize: number;
  connectionThreshold: number;
  useDistanceSpacing: boolean;
  distanceSpacing: number;
  maxConnections: number;
  interpolateConnections: boolean;
  connectToAnchors: boolean;
  connectToSiblings: boolean;
  enablePhysics: boolean;
  enableCollision: boolean;
  gravity: number;
  damping: number;
  substeps: number;
  structuralStiffness: number;
  connectionStiffness: number;
  connectionRestLengthFactor: number;
  interpolatedConnectionStiffness: number;
  nodeColor: number;
  threadColor: number;
  showWireframe: boolean;
  customMeshUnitScale: number;
}

export interface ThreadConnection {
  p1: Particle;
  p2: Particle;
  color: number;
  opacity: number;
  isExtra: boolean;
  constraint?: DistanceConstraint;
}

export interface HistoryThreadBundle {
  nodes: THREE.Mesh[];
  threads: ThreadConnection[];
  constraints: DistanceConstraint[];
}

export type HistoryAction =
  | {
      type: 'add';
      node: THREE.Mesh;
      previousLastNode: THREE.Mesh | null;
      threads: HistoryThreadBundle;
    }
  | {
      type: 'connect';
      previousLastNode: THREE.Mesh | null;
      threads: HistoryThreadBundle;
    };
