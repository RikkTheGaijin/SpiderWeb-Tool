/// <reference lib="dom" />
/// <reference lib="webworker" />

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { simulatePhysics, Particle, DistanceConstraint } from '../physics/physics';
import type { Settings } from '../types';

(THREE.Mesh as unknown as { prototype: { raycast: typeof THREE.Mesh.prototype.raycast } }).prototype.raycast = acceleratedRaycast;

interface StepMessage {
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

interface ConfigureMessage {
  type: 'configure';
  cubeSize: number;
}

interface SetMeshMessage {
  type: 'set-mesh';
  objText: string;
  unitScale: number;
}

interface ClearMeshMessage {
  type: 'clear-mesh';
}

type IncomingMessage = StepMessage | ConfigureMessage | SetMeshMessage | ClearMeshMessage;

const ctx = self as DedicatedWorkerGlobalScope;

class GpuIntegrator {
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private particleBuffer: GPUBuffer | null = null;
  private stagingBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private bufferCapacity = 0;
  private readyPromise: Promise<void> | null = null;
  private lastDt = 0;

  constructor() {
    if (typeof navigator !== 'undefined' && (navigator as Navigator & { gpu?: GPU }).gpu) {
      this.readyPromise = this.initialize();
    }
  }

  private async initialize() {
    const adapter = await (navigator as Navigator & { gpu: GPU }).gpu.requestAdapter();
    if (!adapter) return;
    this.device = await adapter.requestDevice();
    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
      ]
    });
    this.pipeline = this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      compute: {
        module: this.device.createShaderModule({ code: this.buildShader() }),
        entryPoint: 'main'
      }
    });
  }

  async integrate(source: Float32Array, draggedIndex: number, dt: number, settings: Settings, prevDt: number) {
    this.lastDt = prevDt;
    if (!this.readyPromise) return null;
    await this.readyPromise;
    if (!this.device || !this.pipeline || !this.uniformBuffer) return null;
    await this.ensureBuffers(source.byteLength);
    if (!this.particleBuffer || !this.stagingBuffer || !this.bindGroupLayout) return null;

    this.device.queue.writeBuffer(this.particleBuffer, 0, source.buffer, source.byteOffset, source.byteLength);

    const particleCount = Math.floor(source.length / 7);
    const uniformBuffer = new ArrayBuffer(32);
    const floatView = new Float32Array(uniformBuffer, 0, 4);
    floatView[0] = dt;
    floatView[1] = settings.gravity;
    floatView[2] = settings.damping;
    floatView[3] = this.lastDt > 0 ? dt / this.lastDt : 1.0;
    const intView = new Int32Array(uniformBuffer, 16, 4);
    intView[0] = draggedIndex;
    intView[1] = particleCount;
    intView[2] = 0;
    intView[3] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformBuffer);

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        { binding: 1, resource: { buffer: this.uniformBuffer } }
      ]
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    const workgroupSize = 64;
    pass.dispatchWorkgroups(Math.ceil(particleCount / workgroupSize));
    pass.end();

    encoder.copyBufferToBuffer(this.particleBuffer, 0, this.stagingBuffer!, 0, source.byteLength);
    this.device.queue.submit([encoder.finish()]);
    await this.stagingBuffer!.mapAsync(GPUMapMode.READ);
    const mapped = this.stagingBuffer!.getMappedRange();
    const copy = new Float32Array(mapped.slice(0));
    this.stagingBuffer!.unmap();
    return copy;
  }

  private async ensureBuffers(byteLength: number) {
    if (!this.device) return;
    if (byteLength <= this.bufferCapacity) return;
    const aligned = Math.max(byteLength, 1024);
    this.particleBuffer?.destroy();
    this.stagingBuffer?.destroy();
    this.particleBuffer = this.device.createBuffer({
      size: aligned,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });
    this.stagingBuffer = this.device.createBuffer({
      size: aligned,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    this.bufferCapacity = aligned;
  }

  private buildShader() {
    return /* wgsl */`
      struct Config {
        dt : f32,
        gravity : f32,
        damping : f32,
        correction : f32,
        draggedIndex : i32,
        particleCount : i32,
        padA : i32,
        padB : i32,
      };

      @group(0) @binding(0) var<storage, read_write> particleData : array<f32>;
      @group(0) @binding(1) var<uniform> config : Config;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {
        let index = i32(GlobalInvocationID.x);
        if (config.particleCount <= 0 || index >= config.particleCount) {
          return;
        }
        if (index == config.draggedIndex) {
          return;
        }
        let base = index * 7;
        let invMass = particleData[base + 6];
        if (invMass == 0.0) {
          return;
        }
        var pos = vec3<f32>(
          particleData[base],
          particleData[base + 1],
          particleData[base + 2]
        );
        let prev = vec3<f32>(
          particleData[base + 3],
          particleData[base + 4],
          particleData[base + 5]
        );
        var velocity = pos - prev;
        velocity *= config.damping * config.correction;
        let gravity = vec3<f32>(0.0, -config.gravity * config.dt, 0.0);
        let newPrev = pos;
        pos = pos + velocity + gravity * config.dt;
        particleData[base] = pos.x;
        particleData[base + 1] = pos.y;
        particleData[base + 2] = pos.z;
        particleData[base + 3] = newPrev.x;
        particleData[base + 4] = newPrev.y;
        particleData[base + 5] = newPrev.z;
      }
    `;
  }
}

class WorkerCollisionSystem {
  private settings: Settings | null = null;
  private cubeSize = 5;
  private cubeBounds: THREE.Box3;
  private customMesh: THREE.Group | null = null;
  private readonly objLoader = new OBJLoader();
  private readonly raycaster = new THREE.Raycaster();
  private readonly movementVector = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly collisionNormal = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private meshCollisionFrame = 0;
  private readonly meshCollisionStride = 2;

  constructor() {
    const half = this.cubeSize / 2;
    this.cubeBounds = new THREE.Box3(new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, half, half));
  }

  configure(cubeSize: number) {
    this.cubeSize = cubeSize;
    const half = cubeSize / 2;
    this.cubeBounds = new THREE.Box3(new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, half, half));
  }

  updateSettings(settings: Settings) {
    this.settings = settings;
  }

  beginFrame() {
    this.meshCollisionFrame++;
  }

  setCustomMeshFromText(objText: string, unitScale: number) {
    if (this.customMesh) {
      this.disposeMesh();
    }
    const group = this.objLoader.parse(objText);
    const material = new THREE.MeshBasicMaterial({ color: 0x3c3c4a, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.material = material;
        if (unitScale !== 1) {
          obj.scale.setScalar(unitScale);
        }
        obj.geometry?.computeBoundsTree?.();
      }
    });
    group.updateMatrixWorld(true);
    this.customMesh = group;
  }

  clearCustomMesh() {
    this.disposeMesh();
    this.customMesh = null;
  }

  enforceCollision(particle: Particle) {
    if (!this.settings || particle.invMass === 0) return;
    if (this.customMesh && this.resolveMeshCollision(particle)) {
      return;
    }
    this.resolveCubeCollision(particle);
  }

  private resolveCubeCollision(particle: Particle) {
    if (!this.settings) return;
    const padding = this.settings.nodeSize * 1.2;
    const halfSize = this.cubeSize / 2 - padding;
    let clamped = false;
    if (particle.pos.x > halfSize) { particle.pos.x = halfSize; clamped = true; }
    if (particle.pos.x < -halfSize) { particle.pos.x = -halfSize; clamped = true; }
    if (particle.pos.y > halfSize) { particle.pos.y = halfSize; clamped = true; }
    if (particle.pos.y < -halfSize) { particle.pos.y = -halfSize; clamped = true; }
    if (particle.pos.z > halfSize) { particle.pos.z = halfSize; clamped = true; }
    if (particle.pos.z < -halfSize) { particle.pos.z = -halfSize; clamped = true; }
    if (clamped) {
      particle.prevPos.copy(particle.pos);
    }
  }

  private resolveMeshCollision(particle: Particle) {
    if (!this.customMesh || !this.settings) return false;
    this.customMesh.updateMatrixWorld(true);
    this.movementVector.subVectors(particle.pos, particle.prevPos);
    const distance = this.movementVector.length();
    if (distance < this.settings.nodeSize * 0.1) {
      return false;
    }
    if (this.meshCollisionStride > 1 && (this.meshCollisionFrame % this.meshCollisionStride !== 0) && distance < this.settings.nodeSize * 0.75) {
      return false;
    }
    this.movementDirection.copy(this.movementVector).normalize();
    this.raycaster.set(particle.prevPos, this.movementDirection);
    this.raycaster.near = 0;
    this.raycaster.far = distance + this.settings.nodeSize * 1.2;
    const hits = this.raycaster.intersectObject(this.customMesh, true);
    if (!hits.length) {
      return false;
    }
    const hit = hits[0];
    particle.pos.copy(hit.point);
    if (hit.face) {
      this.collisionNormal.copy(hit.face.normal);
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      this.collisionNormal.applyMatrix3(this.normalMatrix).normalize();
      particle.pos.addScaledVector(this.collisionNormal, this.settings.nodeSize * 0.6);
    }
    particle.prevPos.copy(particle.pos);
    return true;
  }

  private disposeMesh() {
    if (!this.customMesh) return;
    this.customMesh.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose?.();
        child.geometry?.disposeBoundsTree?.();
      }
    });
  }
}

const collisionSystem = new WorkerCollisionSystem();
const gpuIntegrator = new GpuIntegrator();
let particles: Particle[] = [];
let constraints: DistanceConstraint[] = [];
let lastDt = 0;

ctx.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const data = event.data as IncomingMessage;
  switch (data.type) {
    case 'configure':
      collisionSystem.configure(data.cubeSize);
      break;
    case 'set-mesh':
      collisionSystem.setCustomMeshFromText(data.objText, data.unitScale);
      break;
    case 'clear-mesh':
      collisionSystem.clearCustomMesh();
      break;
    case 'step':
      void handleStep(data);
      break;
  }
};

const FIXED_TIMESTEP = 1 / 60;
let accumulator = 0;

async function handleStep(data: StepMessage) {
  try {
    collisionSystem.updateSettings(data.settings);
    collisionSystem.beginFrame();

    // Accumulate time
    accumulator += data.dt;

    // Prevent spiral of death
    if (accumulator > 0.2) {
      accumulator = 0.2;
    }

    syncParticles(new Float32Array(data.particleBuffer), data.particleCount);
    const activeConstraints = syncConstraints(data, particles);
    const dragged = data.draggedIndex >= 0 ? particles[data.draggedIndex] ?? null : null;

    // Fixed time step loop
    while (accumulator >= FIXED_TIMESTEP) {
      simulatePhysics({
        settings: data.settings,
        particles,
        constraints: activeConstraints,
        draggedParticle: dragged,
        dt: FIXED_TIMESTEP,
        substeps: data.settings.substeps,
        enableCollision: data.settings.enableCollision,
        enforceCollision: particle => collisionSystem.enforceCollision(particle),
        updateThreadGeometries: () => { },
        preintegrated: false // GPU disabled for stability
      });
      accumulator -= FIXED_TIMESTEP;
    }

    const result = new Float32Array(data.particleCount * 6);
    for (let i = 0; i < data.particleCount; i++) {
      const p = particles[i];
      const base = i * 6;
      result[base] = p.pos.x;
      result[base + 1] = p.pos.y;
      result[base + 2] = p.pos.z;
      result[base + 3] = p.prevPos.x;
      result[base + 4] = p.prevPos.y;
      result[base + 5] = p.prevPos.z;
    }
    ctx.postMessage({ type: 'step-result', particleBuffer: result.buffer, particleCount: data.particleCount, revision: data.revision } satisfies WorkerResponseStep, [result.buffer]);
  } catch (error) {
    ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies WorkerResponseError);
  }
}

function syncParticles(data: Float32Array, count: number) {
  if (particles.length < count) {
    for (let i = particles.length; i < count; i++) {
      particles.push(new Particle(0, 0, 0, 1));
    }
  } else if (particles.length > count) {
    particles.length = count;
  }
  for (let i = 0; i < count; i++) {
    const base = i * 7;
    const p = particles[i];
    p.pos.set(data[base], data[base + 1], data[base + 2]);
    p.prevPos.set(data[base + 3], data[base + 4], data[base + 5]);
    p.invMass = data[base + 6];
  }
}

function syncConstraints(data: StepMessage, currentParticles: Particle[]) {
  const values = new Float32Array(data.constraintBuffer);
  const indices = new Uint32Array(data.constraintIndices);
  const flags = new Uint8Array(data.constraintFlags);
  const count = data.constraintCount;
  if (constraints.length < count) {
    for (let i = constraints.length; i < count; i++) {
      constraints.push(new DistanceConstraint(currentParticles[0], currentParticles[0], 1));
    }
  } else if (constraints.length > count) {
    constraints.length = count;
  }
  const active: DistanceConstraint[] = [];
  for (let i = 0; i < count; i++) {
    const idx1 = indices[i * 2];
    const idx2 = indices[i * 2 + 1];
    const p1 = currentParticles[idx1];
    const p2 = currentParticles[idx2];
    const base = i * 4;
    let constraint = constraints[i];
    if (!constraint) {
      constraint = new DistanceConstraint(p1, p2, values[base + 2]);
      constraints[i] = constraint;
    }
    constraint.p1 = p1;
    constraint.p2 = p2;
    constraint.restLength = values[base];
    constraint.baseRestLength = values[base + 1];
    constraint.stiffness = values[base + 2];
    constraint.connectionType = decodeConnectionType(values[base + 3]);
    constraint.isExtra = flags[i] === 1;
    active.push(constraint);
  }
  return active;
}

function decodeConnectionType(code: number): 'structural' | 'connection' | 'interpolated' {
  if (code === 1) return 'connection';
  if (code === 2) return 'interpolated';
  return 'structural';
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
