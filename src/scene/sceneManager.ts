import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { AppState } from '../state';
import type { Settings, ThreadConnection } from '../types';
import {
  Particle,
  DistanceConstraint,
  canAddExtraConnection,
  incrementExtraConnection,
  incrementStructuralConnection,
  decrementExtraConnection,
  decrementStructuralConnection,
  applyConnectionRestLength
} from '../physics/physics';

const MAX_INTERMEDIATE_NODES = 150;
const THREAD_BASE_THICKNESS = 0.01;
const THREAD_RAYCAST_THRESHOLD = THREAD_BASE_THICKNESS * 4;
const THREAD_LINE_WIDTH = THREAD_BASE_THICKNESS * 40;

(THREE.Mesh as unknown as { prototype: { raycast: typeof THREE.Mesh.prototype.raycast } }).prototype.raycast = acceleratedRaycast;

export interface ThreadCreationResult {
  nodes: THREE.Mesh[];
  threads: ThreadConnection[];
  constraints: DistanceConstraint[];
}

export interface SceneBounds {
  center: THREE.Vector3;
  radius: number;
}

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly raycaster = new THREE.Raycaster();
  private readonly cutRaycaster = new THREE.Raycaster();
  private readonly cutThresholdRange = { min: 0.01, max: 0.5 };
  readonly mouse = new THREE.Vector2();
  readonly cubeGroup: THREE.Group;
  readonly cubeSize = 5;
  readonly cubeBounds: THREE.Box3;
  webLineSegments: THREE.LineSegments;
  readonly newOriginButton: HTMLButtonElement | null;
  private draggedParticle: Particle | null = null;
  private customMeshGroup: THREE.Group | null = null;
  private readonly objLoader = new OBJLoader();
  private readonly collisionRaycaster = new THREE.Raycaster();
  private readonly movementVector = new THREE.Vector3();
  private readonly movementDirection = new THREE.Vector3();
  private readonly collisionNormal = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly tempBox = new THREE.Box3();
  private readonly tempCenter = new THREE.Vector3();
  private readonly tempSize = new THREE.Vector3();
  private meshCollisionFrame = 0;
  private readonly meshCollisionStride = 2;
  private readonly wireframeOverlays = new Map<string, THREE.LineSegments>();
  private readonly nodeGeometry = new THREE.SphereGeometry(1, 16, 16);

  constructor(private settings: Settings, private state: AppState) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0a);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(4, 3, 6);
    this.camera.lookAt(0, 0, 0);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);

    const pointLight = new THREE.PointLight(0xffffff, 1);
    pointLight.position.set(10, 10, 10);
    this.scene.add(pointLight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.raycaster.params.Line = { threshold: THREAD_RAYCAST_THRESHOLD };
    this.cutRaycaster.params.Line = { threshold: THREAD_BASE_THICKNESS }; // will be overridden per cut

    this.cubeGroup = this.buildCubeRoom();
    this.scene.add(this.cubeGroup);
    const half = this.cubeSize / 2;
    this.cubeBounds = new THREE.Box3(new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, half, half));

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const material = new THREE.LineBasicMaterial({ color: this.settings.threadColor, transparent: true, opacity: 0.9 });
    this.webLineSegments = new THREE.LineSegments(geometry, material);
    this.scene.add(this.webLineSegments);

    this.newOriginButton = document.getElementById('new-origin') as HTMLButtonElement | null;
  }

  attachRenderer(container: HTMLElement) {
    container.appendChild(this.renderer.domElement);
  }

  resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  hasCustomMesh() {
    return !!this.customMeshGroup;
  }

  async setCustomMeshFromText(objText: string) {
    const group = this.objLoader.parse(objText);
    this.applyCustomMesh(group);
  }

  clearCustomMesh() {
    if (!this.customMeshGroup) {
      this.cubeGroup.visible = true;
      this.refreshNodeSizes();
      return;
    }
    this.scene.remove(this.customMeshGroup);
    this.disposeObject(this.customMeshGroup);
    this.customMeshGroup = null;
    this.cubeGroup.visible = true;
    this.refreshNodeSizes();
  }

  setWireframeVisible(visible: boolean) {
    // Add or remove an overlay LineSegments showing edges for every mesh.
    this.scene.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.userData.particle) return; // Skip web nodes
      const key = mesh.uuid;
      if (visible) {
        if (this.wireframeOverlays.has(key)) return;
        const geom = new THREE.EdgesGeometry(mesh.geometry as THREE.BufferGeometry);
        const mat = new THREE.LineBasicMaterial({ color: (mesh.material as any).color ? (mesh.material as any).color.getHex() : 0xffffff, transparent: true, opacity: (mesh.material as any).opacity ?? 1.0 });
        const lines = new THREE.LineSegments(geom, mat);
        lines.renderOrder = 9999;
        mesh.add(lines);
        this.wireframeOverlays.set(key, lines);
      } else {
        const existing = this.wireframeOverlays.get(key);
        if (existing) {
          existing.geometry.dispose();
          (existing.material as THREE.Material).dispose?.();
          if (existing.parent) existing.parent.remove(existing);
          this.wireframeOverlays.delete(key);
        }
      }
    });
    // If turning off overlays, ensure cube remains visible state is managed elsewhere.
  }

  private applyCustomMesh(group: THREE.Group) {
    if (this.customMeshGroup) {
      this.scene.remove(this.customMeshGroup);
      this.disposeObject(this.customMeshGroup);
    }

    const standardMaterial = new THREE.MeshStandardMaterial({ color: 0x3c3c4a, side: THREE.DoubleSide, transparent: true, opacity: 0.8 });
    group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.material = standardMaterial.clone();
        obj.castShadow = false;
        obj.receiveShadow = true;
        this.prepareMeshForAcceleration(obj);
      }
    });

    const unitScale = this.settings.customMeshUnitScale ?? 1;
    if (unitScale !== 1) {
      group.scale.setScalar(unitScale);
    }

    group.updateMatrixWorld(true);
    // Removed centering logic to preserve original world coordinates for Maya export alignment
    // const bbox = new THREE.Box3().setFromObject(group);
    // const center = bbox.getCenter(new THREE.Vector3());
    // if (center.lengthSq() > 0) {
    //   group.position.sub(center);
    //   group.updateMatrixWorld(true);
    // }
    group.name = 'CustomMesh';

    this.scene.add(group);
    this.customMeshGroup = group;
    this.cubeGroup.visible = false;
    this.refreshNodeSizes();
  }

  private disposeObject(object: THREE.Object3D) {
    object.traverse(child => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose?.();
        (child.geometry as THREE.BufferGeometry | undefined)?.disposeBoundsTree?.();
        const material = child.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) {
          material.forEach(mat => mat.dispose?.());
        } else {
          material?.dispose?.();
        }
      }
    });
  }

  private buildCubeRoom() {
    const group = new THREE.Group();
    const faces = [
      { pos: [0, 0, -this.cubeSize / 2], rot: [0, 0, 0] },
      { pos: [-this.cubeSize / 2, 0, 0], rot: [0, Math.PI / 2, 0] },
      { pos: [this.cubeSize / 2, 0, 0], rot: [0, -Math.PI / 2, 0] },
      { pos: [0, this.cubeSize / 2, 0], rot: [Math.PI / 2, 0, 0] },
      { pos: [0, -this.cubeSize / 2, 0], rot: [-Math.PI / 2, 0, 0] }
    ];

    faces.forEach(({ pos, rot }) => {
      const geometry = new THREE.PlaneGeometry(this.cubeSize, this.cubeSize);
      const material = new THREE.MeshBasicMaterial({ color: 0x1c1c28, side: THREE.DoubleSide, transparent: true, opacity: 0.4 });
      const plane = new THREE.Mesh(geometry, material);
      plane.position.set(pos[0], pos[1], pos[2]);
      plane.rotation.set(rot[0], rot[1], rot[2]);
      group.add(plane);
    });

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(this.cubeSize, this.cubeSize, this.cubeSize));
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x2f2f40 }));
    group.add(line);
    return group;
  }

  private prepareMeshForAcceleration(mesh: THREE.Mesh) {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    geometry?.computeBoundsTree?.();
  }

  private getCubeFaces() {
    return this.cubeGroup.children.filter(child => child instanceof THREE.Mesh) as THREE.Mesh[];
  }

  getPlacementPoint(raycaster: THREE.Raycaster) {
    if (this.customMeshGroup) {
      this.customMeshGroup.updateMatrixWorld(true);
      const meshHit = raycaster.intersectObject(this.customMeshGroup, true);
      if (meshHit.length > 0) {
        return { point: meshHit[0].point.clone(), anchorType: 'mesh' as const };
      }
      return null;
    }

    const cubeFaces = this.getCubeFaces();
    const faceHit = raycaster.intersectObjects(cubeFaces);
    if (faceHit.length > 0) {
      return { point: faceHit[0].point.clone(), anchorType: 'cube' as const };
    }

    const fallback = this.getCubeIntersectionPoint(raycaster.ray);
    if (!fallback) return null;
    return { point: fallback, anchorType: null };
  }

  projectAnchorDrag(particle: Particle, raycaster: THREE.Raycaster) {
    const mesh = particle.mesh as THREE.Mesh | null;
    const anchorTarget: 'cube' | 'mesh' | null = mesh?.userData.anchorTarget ?? null;

    if (anchorTarget === 'mesh' && this.customMeshGroup) {
      this.customMeshGroup.updateMatrixWorld(true);
      const meshHit = raycaster.intersectObject(this.customMeshGroup, true);
      if (meshHit.length > 0) {
        particle.pos.copy(meshHit[0].point);
        particle.prevPos.copy(meshHit[0].point);
        return true;
      }
      return false;
    }

    const cubeFaces = this.getCubeFaces();
    const faceHit = raycaster.intersectObjects(cubeFaces);
    if (faceHit.length > 0) {
      particle.pos.copy(faceHit[0].point);
      particle.prevPos.copy(faceHit[0].point);
      return true;
    }
    return false;
  }

  updateThreadGeometries() {
    if (!this.webLineSegments) return;
    if (this.state.threads.length === 0) {
      this.webLineSegments.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      this.webLineSegments.geometry.computeBoundingSphere();
      this.webLineSegments.geometry.computeBoundingBox();
      return;
    }

    const positions = new Float32Array(this.state.threads.length * 6);
    for (let i = 0; i < this.state.threads.length; i++) {
      const thread = this.state.threads[i];
      const offset = i * 6;
      positions[offset] = thread.p1.pos.x;
      positions[offset + 1] = thread.p1.pos.y;
      positions[offset + 2] = thread.p1.pos.z;
      positions[offset + 3] = thread.p2.pos.x;
      positions[offset + 4] = thread.p2.pos.y;
      positions[offset + 5] = thread.p2.pos.z;
    }

    this.webLineSegments.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.webLineSegments.geometry.attributes.position.needsUpdate = true;
    this.webLineSegments.geometry.computeBoundingSphere();
    this.webLineSegments.geometry.computeBoundingBox();
  }

  refreshNodeSizes() {
    const nodeSize = this.getNodeSizeWorldUnits();
    this.state.nodes.forEach(node => {
      node.userData.baseScale = nodeSize;
      const hoverOverlay = node.userData._hoverOverlay as THREE.Object3D | undefined;
      const multiplier = hoverOverlay ? 2 : 1;
      node.scale.setScalar(nodeSize * multiplier);
    });
  }

  refreshNodeColors() {
    this.state.nodes.forEach(node => {
      const material = node.material as THREE.MeshBasicMaterial;
      material.color.setHex(this.settings.nodeColor);
      node.userData.baseColor = this.settings.nodeColor;
    });
  }

  getNodeSizeWorldUnits() {
    const unitScale = this.customMeshGroup ? (this.settings.customMeshUnitScale ?? 1) : 1 / 20;
    return this.settings.nodeSize * unitScale;
  }

  refreshThreadAppearance() {
    if (!this.raycaster.params.Line) {
      this.raycaster.params.Line = { threshold: THREAD_RAYCAST_THRESHOLD };
    } else {
      this.raycaster.params.Line.threshold = THREAD_RAYCAST_THRESHOLD;
    }
    if (this.webLineSegments && this.webLineSegments.material) {
      const material = this.webLineSegments.material as THREE.LineBasicMaterial;
      material.linewidth = THREAD_LINE_WIDTH;
      material.color.setHex(this.settings.threadColor);
      material.needsUpdate = true;
    }
    this.updateThreadGeometries();
  }

  private buildNode(position: THREE.Vector3, color: number, anchorType: 'cube' | 'mesh' | null) {
    const isAnchor = anchorType !== null;
    const geometry = this.nodeGeometry;
    const material = new THREE.MeshBasicMaterial({ color });
    const node = new THREE.Mesh(geometry, material);
    const nodeSize = this.getNodeSizeWorldUnits();
    node.userData.baseScale = nodeSize;
    node.scale.setScalar(nodeSize);
    node.position.copy(position);

    this.scene.add(node);
    this.state.nodes.push(node);

    const mass = isAnchor ? 0 : 1;
    const particle = new Particle(position.x, position.y, position.z, mass);
    particle.mesh = node;
    node.userData.particle = particle;
    node.userData.baseColor = color;
    node.userData.anchorTarget = anchorType;
    this.state.particles.push(particle);
    this.state.incrementStructureRevision();
    return node;
  }

  createNode(position: THREE.Vector3, color: number, anchorType: 'cube' | 'mesh' | null = null) {
    return this.buildNode(position, color, anchorType);
  }

  setDraggedParticle(particle: Particle | null) {
    this.draggedParticle = particle;
  }

  getCubeIntersectionPoint(ray: THREE.Ray) {
    const point = new THREE.Vector3();
    const hit = ray.intersectBox(this.cubeBounds, point);
    return hit ? point.clone() : null;
  }

  getIntermediateNodeCount(start: THREE.Vector3, end: THREE.Vector3) {
    if (!this.settings.useDistanceSpacing) {
      return this.settings.intermediateNodes;
    }
    // Convert centimeter spacing into world units. Custom meshes rely on their import scale,
    // while the fallback maintains the legacy cube room behavior.
    const unitScale = this.customMeshGroup ? (this.settings.customMeshUnitScale ?? 1) : 1 / 20;
    const spacingUnits = Math.max(0.001, this.settings.distanceSpacing * unitScale);
    const totalDistance = start.distanceTo(end);
    const count = Math.floor(totalDistance / spacingUnits) - 1;
    return Math.max(0, Math.min(MAX_INTERMEDIATE_NODES, count));
  }

  private createInterpolatedConnection(p1: Particle, p2: Particle, color: number, createdNodes: THREE.Mesh[], createdThreads: ThreadConnection[], createdConstraints: DistanceConstraint[]) {
    const chain: Particle[] = [p1];
    let intermediateCount = 0;
    if (this.settings.interpolateConnections) {
      intermediateCount = this.getIntermediateNodeCount(p1.pos, p2.pos);
      for (let i = 1; i <= intermediateCount; i++) {
        const t = i / (intermediateCount + 1);
        const point = new THREE.Vector3().lerpVectors(p1.pos, p2.pos, t);
        const node = this.createNode(point, color, null);
        createdNodes.push(node);
        chain.push(node.userData.particle as Particle);
      }
    }
    chain.push(p2);

    const useInterpolated = intermediateCount > 0;
    const stiffness = useInterpolated ? this.settings.connectionStiffness * this.settings.interpolatedConnectionStiffness : this.settings.connectionStiffness;
    const connectionType: 'interpolated' | 'connection' = useInterpolated ? 'interpolated' : 'connection';

    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const constraint = new DistanceConstraint(a, b, stiffness);
      constraint.isExtra = true;
      constraint.connectionType = connectionType;
      applyConnectionRestLength(constraint, this.settings.connectionRestLengthFactor);
      this.state.constraints.push(constraint);
      createdConstraints.push(constraint);
      incrementExtraConnection(a);
      incrementExtraConnection(b);

      const threadConnection: ThreadConnection = { p1: a, p2: b, color, opacity: 0.5, isExtra: true, constraint };
      this.state.threads.push(threadConnection);
      createdThreads.push(threadConnection);
      this.state.incrementStructureRevision();
    }
  }

  createThread(start: THREE.Vector3, end: THREE.Vector3, color: number): ThreadCreationResult {
    const intermediateCount = this.getIntermediateNodeCount(start, end);
    const createdNodes: THREE.Mesh[] = [];
    const createdThreads: ThreadConnection[] = [];
    const createdConstraints: DistanceConstraint[] = [];

    const startNode = this.state.nodes.find(n => n.position.equals(start));
    const startParticle = startNode ? (startNode.userData.particle as Particle) : null;
    const intermediateParticles: Particle[] = [];

    for (let i = 1; i <= intermediateCount; i++) {
      const t = i / (intermediateCount + 1);
      const point = new THREE.Vector3().lerpVectors(start, end, t);
      const node = this.createNode(point, color, null);
      createdNodes.push(node);
      intermediateParticles.push(node.userData.particle as Particle);
    }

    const endNode = this.state.nodes.find(n => n.position.equals(end));
    const endParticle = endNode ? (endNode.userData.particle as Particle) : null;
    const allParticles = [startParticle, ...intermediateParticles, endParticle].filter(Boolean) as Particle[];

    for (let i = 0; i < allParticles.length - 1; i++) {
      const constraint = new DistanceConstraint(allParticles[i], allParticles[i + 1], this.settings.structuralStiffness);
      constraint.isExtra = false;
      constraint.connectionType = 'structural';
      this.state.constraints.push(constraint);
      createdConstraints.push(constraint);
      incrementStructuralConnection(allParticles[i]);
      incrementStructuralConnection(allParticles[i + 1]);

      const threadConnection: ThreadConnection = { p1: allParticles[i], p2: allParticles[i + 1], color, opacity: 0.8, isExtra: false, constraint };
      this.state.threads.push(threadConnection);
      createdThreads.push(threadConnection);
      this.state.incrementStructureRevision();
    }

    this.connectNearbyNodes(intermediateParticles, createdNodes, createdThreads, createdConstraints, color, startParticle, endParticle);
    return { nodes: createdNodes, threads: createdThreads, constraints: createdConstraints };
  }

  private connectNearbyNodes(newParticles: Particle[], createdNodes: THREE.Mesh[], createdThreads: ThreadConnection[], createdConstraints: DistanceConstraint[], color: number, startParticle: Particle | null, endParticle: Particle | null) {
    const threshold = this.settings.connectionThreshold;
    const anchorSet = new Set<Particle>();
    if (startParticle) anchorSet.add(startParticle);
    if (endParticle) anchorSet.add(endParticle);
    const newParticleSet = new Set(newParticles);

    for (const node of this.state.nodes) {
      const existingParticle = node.userData.particle as Particle | undefined;
      if (!existingParticle) continue;

      const isAnchor = anchorSet.has(existingParticle);
      const isSibling = newParticleSet.has(existingParticle);
      if (isAnchor && !this.settings.connectToAnchors) continue;
      if (isSibling && !this.settings.connectToSiblings) continue;
      if (isSibling) continue;

      for (let j = 0; j < newParticles.length; j++) {
        const targetParticle = newParticles[j];
        const dist = node.position.distanceTo(targetParticle.pos);
        if (dist >= threshold || dist < 0.01) continue;
        if (!canAddExtraConnection(existingParticle, this.settings.maxConnections) || !canAddExtraConnection(targetParticle, this.settings.maxConnections)) continue;
        this.createInterpolatedConnection(existingParticle, targetParticle, color, createdNodes, createdThreads, createdConstraints);
      }
    }

    if (this.settings.connectToSiblings) {
      for (let i = 0; i < newParticles.length; i++) {
        for (let j = i + 1; j < newParticles.length; j++) {
          const a = newParticles[i];
          const b = newParticles[j];
          const dist = a.pos.distanceTo(b.pos);
          if (dist >= threshold) continue;
          if (!canAddExtraConnection(a, this.settings.maxConnections) || !canAddExtraConnection(b, this.settings.maxConnections)) continue;
          this.createInterpolatedConnection(a, b, color, createdNodes, createdThreads, createdConstraints);
        }
      }
    }
  }

  updateStats() {
    const nodeCountEl = document.getElementById('node-count');
    const threadCountEl = document.getElementById('thread-count');
    if (nodeCountEl) nodeCountEl.textContent = this.state.nodes.length.toString();
    if (threadCountEl) threadCountEl.textContent = this.state.threads.length.toString();
  }

  beginPhysicsStep() {
    this.meshCollisionFrame++;
  }

  enforceEnvironmentCollision(particle: Particle) {
    if (!this.settings.enableCollision || particle.invMass === 0) return;
    if (this.customMeshGroup && this.resolveMeshCollision(particle)) {
      return;
    }
    if (!this.customMeshGroup) {
      this.resolveCubeCollision(particle);
    }
  }

  private resolveCubeCollision(particle: Particle) {
    const padding = this.getNodeSizeWorldUnits() * 1.2;
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
    if (!this.customMeshGroup) return false;
    this.customMeshGroup.updateMatrixWorld(true);
    this.movementVector.subVectors(particle.pos, particle.prevPos);
    const distance = this.movementVector.length();
    const nodeSize = this.getNodeSizeWorldUnits();
    if (distance < nodeSize * 0.1) {
      return false;
    }
    if (this.meshCollisionStride > 1 && (this.meshCollisionFrame % this.meshCollisionStride !== 0) && distance < nodeSize * 0.75) {
      return false;
    }
    this.movementDirection.copy(this.movementVector).normalize();
    this.collisionRaycaster.set(particle.prevPos, this.movementDirection);
    this.collisionRaycaster.near = 0;
    this.collisionRaycaster.far = distance + nodeSize * 1.2;
    const hits = this.collisionRaycaster.intersectObject(this.customMeshGroup, true);
    if (!hits.length) {
      return false;
    }
    const hit = hits[0];
    particle.pos.copy(hit.point);
    if (hit.face) {
      this.collisionNormal.copy(hit.face.normal);
      this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      this.collisionNormal.applyMatrix3(this.normalMatrix).normalize();
      particle.pos.addScaledVector(this.collisionNormal, nodeSize * 0.6);
    }
    particle.prevPos.copy(particle.pos);
    return true;
  }

  removeConstraintInstance(constraint: DistanceConstraint, skipCleanup = false) {
    if (!constraint) return;
    if (constraint.isExtra) {
      decrementExtraConnection(constraint.p1);
      decrementExtraConnection(constraint.p2);
    } else {
      decrementStructuralConnection(constraint.p1);
      decrementStructuralConnection(constraint.p2);
    }
    const idx = this.state.constraints.indexOf(constraint);
    if (idx > -1) {
      this.state.constraints.splice(idx, 1);
    }
    if (!skipCleanup) {
      this.cleanupOrphanNodes();
    }
    this.state.incrementStructureRevision();
  }

  cleanupOrphanNodes() {
    let removed = false;
    for (let i = this.state.nodes.length - 1; i >= 0; i--) {
      const node = this.state.nodes[i];
      const particle = node.userData.particle as Particle | undefined;
      if (!particle) continue;
      if (particle === this.draggedParticle) continue;
      if (particle.extraConnections + particle.structuralConnections > 0) continue;
      this.removeNode(node);
      removed = true;
    }
    if (removed) {
      this.updateThreadGeometries();
      this.updateStats();
    }
  }

  removeNode(node: THREE.Mesh) {
    const particle = node.userData.particle as Particle | undefined;
    this.scene.remove(node);
    const nodeIdx = this.state.nodes.indexOf(node);
    if (nodeIdx > -1) this.state.nodes.splice(nodeIdx, 1);
    if (particle) {
      if (this.draggedParticle === particle) {
        this.draggedParticle = null;
      }
      if (particle.mesh === node) {
        particle.mesh = null;
      }
      const pIdx = this.state.particles.indexOf(particle);
      if (pIdx > -1) this.state.particles.splice(pIdx, 1);
    }
    if (this.state.lastNode === node) {
      this.state.lastNode = null;
    }
    this.state.incrementStructureRevision();
  }

  performCut(raycaster: THREE.Raycaster) {
    if (!this.webLineSegments || this.state.threads.length === 0) return false;
    const cutThreshold = this.getCutDistanceThreshold();
    if (!this.cutRaycaster.params.Line) {
      this.cutRaycaster.params.Line = { threshold: cutThreshold };
    } else {
      this.cutRaycaster.params.Line.threshold = cutThreshold;
    }
    this.cutRaycaster.ray.copy(raycaster.ray);
    this.cutRaycaster.near = raycaster.near;
    this.cutRaycaster.far = raycaster.far;
    this.cutRaycaster.camera = raycaster.camera;
    const intersections = this.cutRaycaster.intersectObject(this.webLineSegments, false);
    if (!intersections.length) return false;

    const hit = intersections.find(result => (result.distanceToRay ?? Infinity) <= cutThreshold) ?? intersections[0];
    const segmentIndex = Math.floor((hit.index ?? 0) / 2);
    const thread = this.state.threads[segmentIndex];
    if (!thread) return false;

    this.state.threads.splice(segmentIndex, 1);
    if (thread.constraint) {
      this.removeConstraintInstance(thread.constraint);
    }
    this.updateThreadGeometries();
    this.updateStats();
    return true;
  }

  private getCutDistanceThreshold() {
    const nodeSize = this.getNodeSizeWorldUnits();
    const dynamic = nodeSize * 1.5;
    return THREE.MathUtils.clamp(dynamic, this.cutThresholdRange.min, this.cutThresholdRange.max);
  }

  clearWeb() {
    this.state.nodes.forEach(node => this.scene.remove(node));
    this.state.nodes.length = 0;
    this.state.threads.length = 0;
    this.state.particles.length = 0;
    this.state.constraints.length = 0;
    this.state.lastNode = null;
    this.state.history.length = 0;
    this.state.pendingNewOrigin = false;
    this.draggedParticle = null;
    if (this.newOriginButton) {
      this.newOriginButton.classList.remove('active');
    }

    if (this.webLineSegments) {
      this.webLineSegments.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    }
    this.updateStats();
    this.state.incrementStructureRevision();
  }

  getSceneBounds(): SceneBounds {
    const custom = this.getCustomMeshBounds();
    if (custom) return custom;
    const nodes = this.getNodeBounds();
    if (nodes) return nodes;
    return {
      center: new THREE.Vector3(0, 0, 0),
      radius: this.cubeSize * 0.75
    };
  }

  private getCustomMeshBounds(): SceneBounds | null {
    if (!this.customMeshGroup) return null;
    this.customMeshGroup.updateMatrixWorld(true);
    this.tempBox.setFromObject(this.customMeshGroup);
    if (!isFinite(this.tempBox.min.x) || !isFinite(this.tempBox.max.x)) {
      return null;
    }
    const center = this.tempBox.getCenter(this.tempCenter);
    const size = this.tempBox.getSize(this.tempSize);
    const radius = Math.max(size.length() / 2, 0.5);
    return { center: center.clone(), radius };
  }

  private getNodeBounds(): SceneBounds | null {
    if (this.state.nodes.length === 0) return null;
    this.tempBox.makeEmpty();
    this.state.nodes.forEach(node => this.tempBox.expandByPoint(node.position));
    const center = this.tempBox.getCenter(this.tempCenter);
    const size = this.tempBox.getSize(this.tempSize);
    const radius = Math.max(size.length() / 2, 0.5);
    return { center: center.clone(), radius };
  }

}
