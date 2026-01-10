import { simulatePhysics, type Particle, DistanceConstraint } from './physics';
import type { Settings } from '../types';
import type { AppState } from '../state';
import type { SceneManager } from '../scene/sceneManager';

interface WorkerStepMessage {
  type: 'step';
  dt: number;
  draggedIndex: number;
  particleCount: number;
  particleBuffer: ArrayBuffer;
  constraintCount: number;
  constraintBuffer: ArrayBuffer;
  constraintIndices: ArrayBuffer;
  constraintFlags: ArrayBuffer;
  settings: Settings;
  revision: number;
}

interface WorkerMeshMessage {
  type: 'set-mesh';
  objText: string;
  unitScale: number;
}

interface WorkerClearMeshMessage {
  type: 'clear-mesh';
}

interface WorkerConfigureMessage {
  type: 'configure';
  cubeSize: number;
}

interface WorkerResponseStep {
  type: 'step-result';
  particleBuffer: ArrayBuffer;
  particleCount: number;
  revision: number;
}

interface WorkerResponseError {
  type: 'error';
  message: string;
}

type WorkerOutboundMessage = WorkerStepMessage | WorkerMeshMessage | WorkerClearMeshMessage | WorkerConfigureMessage;
type WorkerInboundMessage = WorkerResponseStep | WorkerResponseError;

interface WorkerPayload {
  message: WorkerStepMessage;
  transfer: ArrayBuffer[];
}

export class PhysicsController {
  private worker: Worker | null = null;
  private pendingStep: Promise<void> | null = null;
  private resolveStep: (() => void) | null = null;
  private rejectStep: ((reason?: unknown) => void) | null = null;
  private pendingRevision: number | null = null;
  constructor(
    private readonly settings: Settings,
    private readonly state: AppState,
    private readonly sceneManager: SceneManager
  ) {
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('../workers/physicsWorker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = event => this.handleWorkerMessage(event.data as WorkerInboundMessage);
        this.worker.onerror = error => {
          console.error('Physics worker error', error);
          this.disposeWorker();
        };
        this.worker.postMessage({ type: 'configure', cubeSize: this.sceneManager.cubeSize } satisfies WorkerConfigureMessage);
      } catch (error) {
        console.warn('Failed to start physics worker, falling back to main thread', error);
        this.worker = null;
      }
    }
  }

  step(dt: number, draggedParticle: Particle | null) {
    if (!this.worker) {
      const effectiveSettings = this.createEffectiveSettings();
      simulatePhysics({
        settings: effectiveSettings,
        particles: this.state.particles,
        constraints: this.state.constraints,
        draggedParticle,
        dt,
        substeps: effectiveSettings.substeps,
        enableCollision: effectiveSettings.enableCollision,
        enforceCollision: particle => this.sceneManager.enforceEnvironmentCollision(particle),
        updateThreadGeometries: () => this.sceneManager.updateThreadGeometries()
      });
      return null;
    }

    if (this.pendingStep) {
      return this.pendingStep;
    }

    const payload = this.buildWorkerPayload(dt, draggedParticle);
    if (!payload) {
      return null;
    }

    this.pendingStep = new Promise((resolve, reject) => {
      this.resolveStep = resolve;
      this.rejectStep = reject;
    });

    this.worker.postMessage(payload.message, payload.transfer);
    return this.pendingStep;
  }

  setCustomMesh(objText: string) {
    if (!this.worker) return;
    const message: WorkerMeshMessage = {
      type: 'set-mesh',
      objText,
      unitScale: this.settings.customMeshUnitScale ?? 1
    };
    this.worker.postMessage(message);
  }

  clearCustomMesh() {
    if (!this.worker) return;
    const message: WorkerClearMeshMessage = { type: 'clear-mesh' };
    this.worker.postMessage(message);
  }

  dispose() {
    this.disposeWorker();
  }

  private disposeWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.pendingStep) {
      this.rejectStep?.(new Error('Physics worker terminated'));
      this.pendingStep = null;
    }
  }

  private handleWorkerMessage(message: WorkerInboundMessage) {
    if (message.type === 'step-result') {
      if (message.revision === this.state.structureRevision) {
        this.applyWorkerResult(message);
      } else {
        console.warn('Discarding stale physics result', { workerRevision: message.revision, stateRevision: this.state.structureRevision });
      }
      this.resolveStep?.();
      this.pendingStep = null;
      this.resolveStep = null;
      this.rejectStep = null;
      this.pendingRevision = null;
      this.sceneManager.updateThreadGeometries();
      return;
    }

    if (message.type === 'error') {
      console.error('Physics worker reported error:', message.message);
      this.rejectStep?.(new Error(message.message));
      this.pendingStep = null;
      this.resolveStep = null;
      this.rejectStep = null;
      this.pendingRevision = null;
      this.disposeWorker();
    }
  }

  private buildWorkerPayload(dt: number, draggedParticle: Particle | null): WorkerPayload | null {
    const particles = this.state.particles;
    const constraints = this.state.constraints;
    if (particles.length === 0) {
      this.sceneManager.updateThreadGeometries();
      return null;
    }

    const particleData = new Float32Array(particles.length * 7);
    const particleIndex = new Map<Particle, number>();
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const base = i * 7;
      particleIndex.set(p, i);
      particleData[base] = p.pos.x;
      particleData[base + 1] = p.pos.y;
      particleData[base + 2] = p.pos.z;
      particleData[base + 3] = p.prevPos.x;
      particleData[base + 4] = p.prevPos.y;
      particleData[base + 5] = p.prevPos.z;
      particleData[base + 6] = p.invMass;
    }

    const draggedIndex = draggedParticle ? (particleIndex.get(draggedParticle) ?? -1) : -1;

    const constraintCount = constraints.length;
    const constraintBuffer = new Float32Array(constraintCount * 4);
    const constraintIndices = new Uint32Array(constraintCount * 2);
    const constraintFlags = new Uint8Array(constraintCount);

    for (let i = 0; i < constraintCount; i++) {
      const constraint = constraints[i];
      const p1Index = particleIndex.get(constraint.p1);
      const p2Index = particleIndex.get(constraint.p2);
      if (p1Index === undefined || p2Index === undefined) continue;
      const dataBase = i * 4;
      constraintIndices[i * 2] = p1Index;
      constraintIndices[i * 2 + 1] = p2Index;
      constraintBuffer[dataBase] = constraint.restLength;
      constraintBuffer[dataBase + 1] = constraint.baseRestLength;
      constraintBuffer[dataBase + 2] = constraint.stiffness;
      constraintBuffer[dataBase + 3] = this.encodeConnectionType(constraint);
      constraintFlags[i] = constraint.isExtra ? 1 : 0;
    }

    const revision = this.state.structureRevision;
    const settings = this.createEffectiveSettings();
    const message: WorkerStepMessage = {
      type: 'step',
      dt,
      draggedIndex,
      particleCount: particles.length,
      particleBuffer: particleData.buffer,
      constraintCount,
      constraintBuffer: constraintBuffer.buffer,
      constraintIndices: constraintIndices.buffer,
      constraintFlags: constraintFlags.buffer,
      settings,
      revision
    };

    this.pendingRevision = revision;

    return {
      message,
      transfer: [
        particleData.buffer,
        constraintBuffer.buffer,
        constraintIndices.buffer,
        constraintFlags.buffer
      ]
    };
  }

  private encodeConnectionType(constraint: DistanceConstraint) {
    switch (constraint.connectionType) {
      case 'connection':
        return 1;
      case 'interpolated':
        return 2;
      default:
        return 0;
    }
  }

  private applyWorkerResult(message: WorkerResponseStep) {
    const result = new Float32Array(message.particleBuffer);
    const count = Math.min(this.state.particles.length, message.particleCount);
    for (let i = 0; i < count; i++) {
      const p = this.state.particles[i];
      const base = i * 6;
      p.pos.set(result[base], result[base + 1], result[base + 2]);
      p.prevPos.set(result[base + 3], result[base + 4], result[base + 5]);
      if (p.mesh) {
        p.mesh.position.copy(p.pos);
      }
    }
  }

  private createEffectiveSettings(): Settings {
    const cloned = structuredClone(this.settings);
    cloned.nodeSize = this.sceneManager.getNodeSizeWorldUnits();
    return cloned;
  }
}
