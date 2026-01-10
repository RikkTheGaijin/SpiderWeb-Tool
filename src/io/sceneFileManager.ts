import * as THREE from 'three';
import type { Settings, ThreadConnection } from '../types';
import type { AppState } from '../state';
import { SceneManager } from '../scene/sceneManager';
import {
  Particle,
  DistanceConstraint,
  incrementExtraConnection,
  incrementStructuralConnection
} from '../physics/physics';

export interface SerializedVector3 {
  x: number;
  y: number;
  z: number;
}

export interface SerializedNode {
  position: SerializedVector3;
  color: number;
  anchorType: 'cube' | 'mesh' | null;
}

export interface SerializedConstraint {
  restLength: number;
  baseRestLength: number;
  stiffness: number;
  connectionType: DistanceConstraint['connectionType'];
  isExtra: boolean;
}

export interface SerializedThread {
  start: number;
  end: number;
  color: number;
  opacity: number;
  constraint: SerializedConstraint;
}

export interface SerializedScene {
  version: 1;
  settings: Settings;
  camera: {
    position: SerializedVector3;
    target: SerializedVector3;
  };
  nodes: SerializedNode[];
  threads: SerializedThread[];
  lastNodeIndex: number | null;
  pendingNewOrigin: boolean;
  customMeshPath: string | null;
  customMeshData?: string | null;
}

interface SerializeContext {
  sceneManager: SceneManager;
  state: AppState;
  settings: Settings;
}

interface RestoreContext {
  sceneManager: SceneManager;
  state: AppState;
}

export function serializeScene(context: SerializeContext): SerializedScene {
  const { sceneManager, state, settings } = context;
  const nodes: SerializedNode[] = [];
  const particleIndex = new Map<Particle, number>();

  state.nodes.forEach((node, index) => {
    const particle = node.userData.particle as Particle | undefined;
    if (!particle) return;
    const material = node.material as THREE.MeshBasicMaterial;
    const anchorTarget = (node.userData.anchorTarget as 'cube' | 'mesh' | null) ?? (particle.invMass === 0 ? 'cube' : null);
    nodes.push({
      position: vectorToObject(node.position),
      color: material.color.getHex(),
      anchorType: anchorTarget
    });
    particleIndex.set(particle, index);
  });

  const threads: SerializedThread[] = state.threads.map(thread => {
    const start = particleIndex.get(thread.p1);
    const end = particleIndex.get(thread.p2);
    if (start === undefined || end === undefined) {
      return null;
    }
    const constraint = thread.constraint;
    const constraintData: SerializedConstraint = constraint
      ? {
          restLength: constraint.restLength,
          baseRestLength: constraint.baseRestLength,
          stiffness: constraint.stiffness,
          connectionType: constraint.connectionType,
          isExtra: constraint.isExtra
        }
      : {
          restLength: thread.p1.pos.distanceTo(thread.p2.pos),
          baseRestLength: thread.p1.pos.distanceTo(thread.p2.pos),
          stiffness: thread.isExtra ? settings.connectionStiffness : settings.structuralStiffness,
          connectionType: thread.isExtra ? 'connection' : 'structural',
          isExtra: thread.isExtra
        };

    return {
      start,
      end,
      color: thread.color,
      opacity: thread.opacity,
      constraint: constraintData
    };
  }).filter((thread): thread is SerializedThread => !!thread);

  const cameraDirection = new THREE.Vector3();
  sceneManager.camera.getWorldDirection(cameraDirection);
  const cameraTarget = new THREE.Vector3().copy(sceneManager.camera.position).add(cameraDirection);

  const lastNodeIndex = state.lastNode ? state.nodes.indexOf(state.lastNode) : null;

  return {
    version: 1,
    settings: JSON.parse(JSON.stringify(settings)) as Settings,
    camera: {
      position: vectorToObject(sceneManager.camera.position),
      target: vectorToObject(cameraTarget)
    },
    nodes,
    threads,
    lastNodeIndex,
    pendingNewOrigin: state.pendingNewOrigin,
    customMeshPath: state.customMeshPath ?? null,
    customMeshData: state.customMeshText ?? null
  };
}

export function restoreSceneFromData(data: SerializedScene, context: RestoreContext) {
  const { sceneManager, state } = context;
  const createdNodes: THREE.Mesh[] = [];

  data.nodes.forEach(nodeData => {
    const position = new THREE.Vector3(nodeData.position.x, nodeData.position.y, nodeData.position.z);
    const node = sceneManager.createNode(position, nodeData.color, nodeData.anchorType ?? null);
    createdNodes.push(node);
  });

  const particles = createdNodes.map(node => node.userData.particle as Particle);

  data.threads.forEach(threadData => {
    const p1 = particles[threadData.start];
    const p2 = particles[threadData.end];
    if (!p1 || !p2) return;

    const constraint = new DistanceConstraint(p1, p2, threadData.constraint.stiffness);
    constraint.connectionType = threadData.constraint.connectionType;
    constraint.isExtra = threadData.constraint.isExtra;
    constraint.restLength = threadData.constraint.restLength;
    constraint.baseRestLength = threadData.constraint.baseRestLength;
    state.constraints.push(constraint);

    if (constraint.isExtra) {
      incrementExtraConnection(p1);
      incrementExtraConnection(p2);
    } else {
      incrementStructuralConnection(p1);
      incrementStructuralConnection(p2);
    }

    const threadConnection: ThreadConnection = {
      p1,
      p2,
      color: threadData.color,
      opacity: threadData.opacity,
      isExtra: threadData.constraint.isExtra,
      constraint
    };
    state.threads.push(threadConnection);
  });

  state.lastNode = typeof data.lastNodeIndex === 'number' ? createdNodes[data.lastNodeIndex] ?? null : null;
  state.pendingNewOrigin = data.pendingNewOrigin;
  if (sceneManager.newOriginButton) {
    sceneManager.newOriginButton.classList.toggle('active', data.pendingNewOrigin);
  }

  sceneManager.updateThreadGeometries();
  sceneManager.updateStats();
  // Restore custom mesh metadata into state so caller can load mesh (host handles actual loading)
  state.customMeshPath = data.customMeshPath ?? null;
  state.customMeshText = data.customMeshData ?? null;
}

function vectorToObject(vector: THREE.Vector3): SerializedVector3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}
