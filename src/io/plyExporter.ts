import type * as THREE from 'three';
import type { AppState } from '../state';
import type { Particle } from '../physics/physics';

interface StrandVertex {
  position: THREE.Vector3;
  isAnchor: boolean;
}

const STRAND_POINTS = 2;

export function generatePly(state: AppState): string {
  const strandVertices: StrandVertex[] = [];

  state.threads.forEach(thread => {
    const startParticle = thread.p1 as Particle;
    const endParticle = thread.p2 as Particle;
    strandVertices.push({ position: startParticle.pos.clone(), isAnchor: startParticle.invMass === 0 });
    strandVertices.push({ position: endParticle.pos.clone(), isAnchor: endParticle.invMass === 0 });
  });

  const header = buildHeader(strandVertices.length, STRAND_POINTS);
  const vertexLines = strandVertices.map(v => formatVertex(v));
  return [header, ...vertexLines].join('\n');
}

function buildHeader(vertexCount: number, pointsPerStrand: number): string {
  const lines = [
    'ply',
    'format ascii 1.0',
    `comment points_per_strand ${pointsPerStrand}`,
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar anchor',
    'end_header'
  ];
  return lines.join('\n');
}

function formatVertex(vertex: StrandVertex): string {
  const anchor = vertex.isAnchor ? 1 : 0;
  const { x, y, z } = vertex.position;
  return `${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)} ${anchor}`;
}
