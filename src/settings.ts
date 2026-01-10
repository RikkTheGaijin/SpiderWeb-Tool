import type { Settings } from './types';
import { DEFAULT_NODE_SIZE_CM, nodeSizeCmToInternal } from './config/nodeSizeScale';

export function createDefaultSettings(): Settings {
  return {
    intermediateNodes: 3,
    nodeSize: nodeSizeCmToInternal(DEFAULT_NODE_SIZE_CM),
    connectionThreshold: 0.7,
    useDistanceSpacing: true,
    distanceSpacing: 3,
    maxConnections: 3,
    interpolateConnections: true,
    connectToAnchors: false,
    connectToSiblings: false,
    enablePhysics: true,
    enableCollision: true,
    gravity: 9.8,
    damping: 0.99,
    substeps: 25,
    structuralStiffness: 0.9,
    connectionStiffness: 0.2,
    connectionRestLengthFactor: 0.5,
    interpolatedConnectionStiffness: 1.2,
    nodeColor: 0x8ab4f8,
    threadColor: 0xffffff,
    showWireframe: true,
    customMeshUnitScale: 0.01
  };
}
