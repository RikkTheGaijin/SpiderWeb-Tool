import * as THREE from 'three';
import { createDefaultSettings } from './settings';
import { AppState } from './state';
import { SceneManager, type SceneBounds } from './scene/sceneManager';
import { setupControlPanel, updateSpacingControlsDOM, syncControlsWithSettings } from './ui/panel';
import { serializeScene, restoreSceneFromData, type SerializedScene } from './io/sceneFileManager';
import { generatePly } from './io/plyExporter';
import { HistoryAction, type HistoryThreadBundle, type Settings } from './types';
import { Particle, applyConnectionRestLength } from './physics/physics';
import { PhysicsController } from './physics/physicsController';

export class SpiderWebApp {
  private readonly settings = createDefaultSettings();
  private readonly state = new AppState();
  private readonly sceneManager = new SceneManager(this.settings, this.state);
  private readonly clock = new THREE.Clock();
  private readonly interactionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly mousePoint3D = new THREE.Vector3();
  private readonly hoverHighlightColor = 0xff4d4d;
  private readonly altHoverHighlightColor = 0xffd54f;
  private readonly hoverHitRadiusMultiplier = 2;
  private previousMousePosition = { x: 0, y: 0 };
  private draggedParticle: Particle | null = null;
  private hoveredNode: THREE.Mesh | null = null;
  private isRotating = false;
  private isPanning = false;
  private isCutting = false;
  private isCtrlPressed = false;
  private isAltPressed = false;
  private cameraDistance = 0;
  private cameraTarget = new THREE.Vector3(0, 0, 0);
  private readonly cameraOrbitOffset = new THREE.Vector3();
  private readonly panOffset = new THREE.Vector3();
  private readonly spherical = new THREE.Spherical();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private readonly cameraUp = new THREE.Vector3();
  private isShiftNavigationActive = false;
  private readonly navigationKeys = new Set<string>();
  private shiftYaw = 0;
  private shiftPitch = 0;
  private readonly shiftMousePosition = { x: 0, y: 0 };
  private readonly navigationForward = new THREE.Vector3();
  private readonly navigationRight = new THREE.Vector3();
  private readonly navigationMove = new THREE.Vector3();
  private readonly navigationWorldUp = new THREE.Vector3(0, 1, 0);
  private readonly baseNavigationSpeed = 3;
  private shiftMouseInitialized = false;
  private readonly hoverTempVector = new THREE.Vector3();
  private sceneFileInput: HTMLInputElement | null = null;
  private meshFileInput: HTMLInputElement | null = null;
  private readonly physicsController: PhysicsController;

  constructor() {
    const container = document.getElementById('canvas-container');
    if (!container) {
      throw new Error('Missing canvas container element');
    }
    this.sceneManager.attachRenderer(container);
    this.cameraDistance = this.sceneManager.camera.position.distanceTo(this.cameraTarget);
    this.sceneManager.camera.lookAt(this.cameraTarget);
    this.physicsController = new PhysicsController(this.settings, this.state, this.sceneManager);
    this.bindUI();
    // Ensure UI controls reflect the current default settings
    syncControlsWithSettings(this.settings);
    this.bindEvents();
    this.animate();
  }

  private bindUI() {
    setupControlPanel(this.settings, {
      refreshNodeSizes: () => {
        this.clearHoverState();
        this.sceneManager.refreshNodeSizes();
      },
      refreshThreadAppearance: () => this.sceneManager.refreshThreadAppearance(),
      updateSpacingControls: () => updateSpacingControlsDOM(this.settings.useDistanceSpacing),
      onStructuralStiffnessChange: () => {
        this.state.constraints.forEach(constraint => {
          if (constraint.connectionType === 'structural') {
            constraint.stiffness = this.settings.structuralStiffness;
          }
        });
      },
      onConnectionStiffnessChange: () => {
        this.state.constraints.forEach(constraint => {
          if (constraint.connectionType === 'connection') {
            constraint.stiffness = this.settings.connectionStiffness;
          } else if (constraint.connectionType === 'interpolated') {
            constraint.stiffness = this.settings.connectionStiffness * this.settings.interpolatedConnectionStiffness;
          }
        });
      },
      onConnectionTensionChange: () => {
        this.state.constraints.forEach(constraint => applyConnectionRestLength(constraint, this.settings.connectionRestLengthFactor));
      },
      onInterpolatedBoostChange: () => {
        this.state.constraints.forEach(constraint => {
          if (constraint.connectionType === 'interpolated') {
            constraint.stiffness = this.settings.connectionStiffness * this.settings.interpolatedConnectionStiffness;
          }
        });
      },
      onShowWireframeChange: visible => {
        this.sceneManager.setWireframeVisible(visible);
      },
      onNodeColorChange: () => this.sceneManager.refreshNodeColors()
    });

    const newOrigin = document.getElementById('new-origin');
    newOrigin?.addEventListener('click', () => {
      this.state.pendingNewOrigin = true;
      newOrigin.classList.add('active');
    });

    document.getElementById('clear-web')?.addEventListener('click', () => this.clearWeb());

    document.getElementById('randomize')?.addEventListener('click', () => this.randomizeColors());

    updateSpacingControlsDOM(this.settings.useDistanceSpacing);
    this.setupSceneMenu();
  }

  private bindEvents() {
    const domElement = this.sceneManager.renderer.domElement;
    domElement.addEventListener('mousedown', e => this.onMouseDown(e));
    domElement.addEventListener('mousemove', e => this.onMouseMove(e));
    domElement.addEventListener('mouseup', e => this.onMouseUp(e));
    domElement.addEventListener('wheel', e => this.onMouseWheel(e), { passive: false });
    domElement.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => {
      if (e.key === 'F5') {
        e.preventDefault();
        window.location.reload();
        return;
      }
      if (e.key === 'Shift') {
        this.enterShiftNavigation();
        return;
      }

      const key = e.key.toLowerCase();
      if (this.isShiftNavigationActive && this.isNavigationKey(key)) {
        this.navigationKeys.add(key);
        e.preventDefault();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        this.undo();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && key === 'f') {
        e.preventDefault();
        this.frameCurrentScene();
      }
    });

    window.addEventListener('keyup', e => {
      const key = e.key.toLowerCase();
      if (this.isNavigationKey(key)) {
        this.navigationKeys.delete(key);
      }
      if (e.key === 'Shift') {
        this.exitShiftNavigation();
      }
    });

    window.addEventListener('resize', () => {
      this.sceneManager.resize(window.innerWidth, window.innerHeight);
    });
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    let dt = this.clock.getDelta();
    // Clamp delta time to prevent physics explosion when tab loses focus
    // Maximum of 1/30th second (33ms) to handle tab switching gracefully
    dt = Math.min(dt, 1 / 30);
    this.updateShiftNavigation(dt);
    this.sceneManager.beginPhysicsStep();
    const maybePromise = this.physicsController.step(dt, this.draggedParticle);
    if (maybePromise) {
      maybePromise.catch(error => console.error('Physics worker step failed', error));
    }
    this.sceneManager.renderer.render(this.sceneManager.scene, this.sceneManager.camera);
  };

  private onMouseDown(event: MouseEvent) {
    if (this.isShiftNavigationActive) {
      event.preventDefault();
      return;
    }
    this.updateMouse(event);
    this.isCtrlPressed = event.ctrlKey || event.metaKey;
    this.isAltPressed = event.altKey;
    this.clearHoverState();

    if (event.altKey && event.button === 0) {
      if (this.tryAltConnectToNode()) {
        event.preventDefault();
        return;
      }
    }

    if (event.button === 1) {
      event.preventDefault();
      this.isRotating = !this.isCtrlPressed;
      this.isPanning = this.isCtrlPressed;
      this.previousMousePosition = { x: event.clientX, y: event.clientY };
      return;
    }

    if (event.button === 0 && this.isCtrlPressed) {
      this.startDragging(event);
    } else if (event.button === 0) {
      this.placeNode();
    } else if (event.button === 2 && this.isCtrlPressed) {
      event.preventDefault();
      this.isCutting = true;
      this.performCut();
    }
  }

  private onMouseMove(event: MouseEvent) {
    if (this.isShiftNavigationActive) {
      this.handleShiftMouseLook(event);
      return;
    }
    this.updateMouse(event);
    this.isCtrlPressed = event.ctrlKey || event.metaKey;
    this.isAltPressed = event.altKey;

    if (this.isRotating) {
      const deltaX = event.clientX - this.previousMousePosition.x;
      const deltaY = event.clientY - this.previousMousePosition.y;
      this.rotateCamera(deltaX, deltaY);
      this.previousMousePosition = { x: event.clientX, y: event.clientY };
      return;
    }

    if (this.isPanning) {
      const deltaX = event.clientX - this.previousMousePosition.x;
      const deltaY = event.clientY - this.previousMousePosition.y;
      this.panCamera(deltaX, deltaY);
      this.previousMousePosition = { x: event.clientX, y: event.clientY };
      return;
    }

    if (this.draggedParticle) {
      const dragged = this.draggedParticle;
      this.sceneManager.raycaster.setFromCamera(this.sceneManager.mouse, this.sceneManager.camera);
      if (dragged.invMass === 0) {
        this.sceneManager.projectAnchorDrag(dragged, this.sceneManager.raycaster);
      } else if (this.sceneManager.raycaster.ray.intersectPlane(this.interactionPlane, this.mousePoint3D)) {
        dragged.pos.copy(this.mousePoint3D);
        this.sceneManager.enforceEnvironmentCollision(dragged);
      }
      return;
    }

    if (this.isCutting) {
      this.performCut();
      return;
    }

    const wantsHover = this.isCtrlPressed || this.isAltPressed;
    if (wantsHover) {
      const color = this.isAltPressed ? this.altHoverHighlightColor : this.hoverHighlightColor;
      this.updateHover(color);
    } else {
      this.clearHoverState();
    }
  }

  private onMouseUp(event: MouseEvent) {
    if (event.button === 1) {
      this.isRotating = false;
      this.isPanning = false;
    } else if (event.button === 0) {
      this.draggedParticle = null;
      this.sceneManager.setDraggedParticle(null);
    } else if (event.button === 2) {
      this.isCutting = false;
    }
  }

  private onMouseWheel(event: WheelEvent) {
    if (this.isShiftNavigationActive) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const delta = event.deltaY * 0.001;
    const factor = 1 + delta;
    this.cameraOrbitOffset.copy(this.sceneManager.camera.position).sub(this.cameraTarget);
    this.cameraOrbitOffset.multiplyScalar(factor);
    const newDistance = this.cameraOrbitOffset.length();
    this.sceneManager.camera.position.copy(this.cameraTarget).add(this.cameraOrbitOffset);
    this.cameraDistance = newDistance;
    this.sceneManager.camera.lookAt(this.cameraTarget);
  }

  private updateMouse(event: MouseEvent) {
    const rect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    this.sceneManager.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.sceneManager.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.sceneManager.raycaster.setFromCamera(this.sceneManager.mouse, this.sceneManager.camera);
  }

  private enterShiftNavigation() {
    if (this.isShiftNavigationActive) return;
    this.isShiftNavigationActive = true;
    this.navigationKeys.clear();
    this.syncShiftOrientation();
    this.shiftMouseInitialized = false;
    this.sceneManager.renderer.domElement.style.cursor = 'none';
  }

  private exitShiftNavigation() {
    if (!this.isShiftNavigationActive) return;
    this.isShiftNavigationActive = false;
    this.navigationKeys.clear();
    this.shiftMouseInitialized = false;
    this.sceneManager.renderer.domElement.style.cursor = 'default';
  }

  private handleShiftMouseLook(event: MouseEvent) {
    if (!this.isShiftNavigationActive) return;
    if (!this.shiftMouseInitialized) {
      this.shiftMousePosition.x = event.clientX;
      this.shiftMousePosition.y = event.clientY;
      this.shiftMouseInitialized = true;
      return;
    }
    const deltaX = (event.movementX ?? 0) || event.clientX - this.shiftMousePosition.x;
    const deltaY = (event.movementY ?? 0) || event.clientY - this.shiftMousePosition.y;
    this.shiftMousePosition.x = event.clientX;
    this.shiftMousePosition.y = event.clientY;
    this.rotateShiftCamera(deltaX, deltaY);
  }

  private rotateShiftCamera(deltaX: number, deltaY: number) {
    const lookSpeed = 0.003;
    this.shiftYaw -= deltaX * lookSpeed;
    this.shiftPitch -= deltaY * lookSpeed;
    const limit = Math.PI / 2 - 0.05;
    this.shiftPitch = THREE.MathUtils.clamp(this.shiftPitch, -limit, limit);
    this.applyShiftCameraOrientation();
  }

  private applyShiftCameraOrientation() {
    this.cameraDirection.set(
      Math.sin(this.shiftYaw) * Math.cos(this.shiftPitch),
      Math.sin(this.shiftPitch),
      Math.cos(this.shiftYaw) * Math.cos(this.shiftPitch)
    );
    this.cameraTarget.copy(this.sceneManager.camera.position).add(this.cameraDirection);
    this.sceneManager.camera.lookAt(this.cameraTarget);
  }

  private syncShiftOrientation() {
    this.sceneManager.camera.getWorldDirection(this.cameraDirection);
    this.cameraDirection.normalize();
    this.shiftYaw = Math.atan2(this.cameraDirection.x, this.cameraDirection.z);
    this.shiftPitch = Math.asin(THREE.MathUtils.clamp(this.cameraDirection.y, -0.999, 0.999));
  }

  private startDragging(event: MouseEvent) {
    const node = this.pickNodeUnderCursor(this.hoverHitRadiusMultiplier);
    if (!node) return;

    this.setHoveredNode(node, this.hoverHighlightColor);
    this.sceneManager.renderer.domElement.style.cursor = 'move';

    this.draggedParticle = node.userData.particle as Particle;
    this.sceneManager.setDraggedParticle(this.draggedParticle);

    const cameraDirection = new THREE.Vector3();
    this.sceneManager.camera.getWorldDirection(cameraDirection);
    this.interactionPlane.setFromNormalAndCoplanarPoint(cameraDirection, this.draggedParticle.pos);
  }

  private placeNode() {
    const placement = this.sceneManager.getPlacementPoint(this.sceneManager.raycaster);
    if (!placement) return;
    const newNode = this.sceneManager.createNode(placement.point, this.settings.nodeColor, placement.anchorType ?? null);

    const action: HistoryAction = {
      type: 'add',
      node: newNode,
      threads: { nodes: [], threads: [], constraints: [] },
      previousLastNode: this.state.lastNode
    };

    let connectFrom = this.state.lastNode;
    if (this.state.pendingNewOrigin) {
      connectFrom = null;
      this.state.pendingNewOrigin = false;
      this.sceneManager.newOriginButton?.classList.remove('active');
    }

    if (connectFrom) {
      const threadData = this.sceneManager.createThread(connectFrom.position.clone(), newNode.position.clone(), this.settings.threadColor);
      action.threads = threadData;
    }

    this.state.lastNode = newNode;
    this.state.history.push(action);
    this.sceneManager.updateStats();
    this.sceneManager.updateThreadGeometries();
  }

  private tryAltConnectToNode() {
    const targetNode = this.pickNodeUnderCursor(this.hoverHitRadiusMultiplier);
    if (!targetNode) {
      return false;
    }

    if (!this.state.lastNode) {
      this.state.lastNode = targetNode;
      return true;
    }

    if (this.state.lastNode === targetNode) {
      return true;
    }

    return this.connectExistingNodes(this.state.lastNode, targetNode);
  }

  private connectExistingNodes(startNode: THREE.Mesh, targetNode: THREE.Mesh) {
    const startParticle = startNode.userData.particle as Particle | undefined;
    const targetParticle = targetNode.userData.particle as Particle | undefined;
    if (!startParticle || !targetParticle) {
      return false;
    }

    const threadData = this.sceneManager.createThread(startNode.position.clone(), targetNode.position.clone(), this.settings.threadColor);

    const action: HistoryAction = {
      type: 'connect',
      previousLastNode: startNode,
      threads: threadData
    };

    this.state.history.push(action);
    this.state.lastNode = targetNode;
    this.sceneManager.updateStats();
    this.sceneManager.updateThreadGeometries();
    return true;
  }

  private performCut() {
    this.sceneManager.performCut(this.sceneManager.raycaster);
  }

  private updateHover(color: number) {
    const node = this.pickNodeUnderCursor(this.hoverHitRadiusMultiplier);
    if (!node) {
      this.clearHoverState();
      return;
    }
    this.setHoveredNode(node, color);
  }

  private setHoveredNode(node: THREE.Mesh, color: number) {
    if (this.hoveredNode !== node) {
      this.clearHoverState();
      this.hoveredNode = node;
    }
    this.applyHoverAppearance(node, color);
  }

  private applyHoverAppearance(node: THREE.Mesh, color: number) {
    const baseScale = (node.userData.baseScale as number | undefined) ?? 1;
    node.scale.setScalar(baseScale * 2);
    // Create a colored overlay child mesh so highlight is visible regardless of the node's original material
    try {
      if (!node.userData._hoverOverlay) {
        const geom = (node.geometry && (node.geometry as THREE.BufferGeometry).clone()) as THREE.BufferGeometry;
        const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true, opacity: 1 });
        const overlay = new THREE.Mesh(geom, mat);
        overlay.renderOrder = 9999;
        overlay.scale.set(1.05, 1.05, 1.05);
        overlay.userData._isHoverOverlay = true;
        node.add(overlay);
        node.userData._hoverOverlay = overlay;
      } else {
        const overlay = node.userData._hoverOverlay as THREE.Mesh;
        overlay.visible = true;
        const overlayMaterial = overlay.material as THREE.MeshBasicMaterial;
        overlayMaterial.color.setHex(color);
        overlayMaterial.needsUpdate = true;
      }
      node.userData._hoverColor = color;
    } catch (e) {
      console.warn('Failed to create hover overlay', e);
    }
    this.sceneManager.renderer.domElement.style.cursor = 'pointer';
  }

  private clearHoverState() {
    if (!this.hoveredNode) return;
    // Remove hover overlay if present
    try {
      const overlay = this.hoveredNode.userData._hoverOverlay as THREE.Mesh | undefined;
      if (overlay) {
        if (overlay.geometry) overlay.geometry.dispose?.();
        if (overlay.material) (overlay.material as THREE.Material).dispose?.();
        if (overlay.parent) overlay.parent.remove(overlay);
        delete this.hoveredNode.userData._hoverOverlay;
      }
    } catch (e) {
      console.warn('Failed to remove hover overlay', e);
    }
    const baseScale = (this.hoveredNode.userData.baseScale as number | undefined) ?? 1;
    this.hoveredNode.scale.setScalar(baseScale);
    delete this.hoveredNode.userData._hoverColor;
    this.hoveredNode = null;
    this.sceneManager.renderer.domElement.style.cursor = 'default';
  }

  private rotateCamera(deltaX: number, deltaY: number) {
    this.cameraOrbitOffset.copy(this.sceneManager.camera.position).sub(this.cameraTarget);
    this.spherical.setFromVector3(this.cameraOrbitOffset);
    const rotationSpeed = 0.005;
    this.spherical.theta -= deltaX * rotationSpeed;
    this.spherical.phi -= deltaY * rotationSpeed;
    const minPhi = 0.05;
    const maxPhi = Math.PI - 0.05;
    this.spherical.phi = THREE.MathUtils.clamp(this.spherical.phi, minPhi, maxPhi);
    this.cameraOrbitOffset.setFromSpherical(this.spherical);
    this.sceneManager.camera.position.copy(this.cameraTarget).add(this.cameraOrbitOffset);
    this.sceneManager.camera.lookAt(this.cameraTarget);
    this.cameraDistance = this.cameraOrbitOffset.length();
  }

  private panCamera(deltaX: number, deltaY: number) {
    const panSpeed = this.cameraDistance * 0.002;
    this.sceneManager.camera.getWorldDirection(this.cameraDirection).normalize();
    this.cameraRight.crossVectors(this.cameraDirection, this.sceneManager.camera.up).normalize();
    this.panOffset.copy(this.cameraRight).multiplyScalar(-deltaX * panSpeed);
    this.cameraUp.copy(this.sceneManager.camera.up).normalize().multiplyScalar(deltaY * panSpeed);
    this.panOffset.add(this.cameraUp);
    this.sceneManager.camera.position.add(this.panOffset);
    this.cameraTarget.add(this.panOffset);
    this.sceneManager.camera.lookAt(this.cameraTarget);
  }

  private updateShiftNavigation(dt: number) {
    if (!this.isShiftNavigationActive) return;
    this.sceneManager.camera.getWorldDirection(this.navigationForward).normalize();
    if (!this.navigationKeys.has('w') && !this.navigationKeys.has('s')) {
      this.navigationForward.y = 0;
      this.navigationForward.normalize();
    }
    this.navigationRight.crossVectors(this.navigationForward, this.navigationWorldUp).normalize();
    this.navigationMove.set(0, 0, 0);

    if (this.navigationKeys.has('w')) {
      this.navigationMove.add(this.navigationForward);
    }
    if (this.navigationKeys.has('s')) {
      this.navigationMove.sub(this.navigationForward);
    }
    if (this.navigationKeys.has('a')) {
      this.navigationMove.sub(this.navigationRight);
    }
    if (this.navigationKeys.has('d')) {
      this.navigationMove.add(this.navigationRight);
    }

    if (this.navigationMove.lengthSq() > 0) {
      this.navigationMove.normalize().multiplyScalar(this.baseNavigationSpeed * dt);
      this.sceneManager.camera.position.add(this.navigationMove);
    }

    this.applyShiftCameraOrientation();
    this.cameraDistance = this.sceneManager.camera.position.distanceTo(this.cameraTarget);
  }

  private isNavigationKey(key: string) {
    return key === 'w' || key === 'a' || key === 's' || key === 'd';
  }

  private frameCurrentScene() {
    const bounds = this.sceneManager.getSceneBounds();
    this.frameScene(bounds);
  }

  private frameScene(bounds: SceneBounds) {
    this.cameraTarget.copy(bounds.center);
    this.cameraOrbitOffset.copy(this.sceneManager.camera.position).sub(this.cameraTarget);
    if (this.cameraOrbitOffset.lengthSq() < 1e-4) {
      this.cameraOrbitOffset.set(1, 1, 1);
    }
    this.cameraOrbitOffset.normalize().multiplyScalar(Math.max(bounds.radius * 2.2, 2));
    this.sceneManager.camera.position.copy(this.cameraTarget).add(this.cameraOrbitOffset);
    this.sceneManager.camera.lookAt(this.cameraTarget);
    this.cameraDistance = this.sceneManager.camera.position.distanceTo(this.cameraTarget);
  }

  private findNode(object: THREE.Object3D | null): THREE.Mesh | null {
    while (object) {
      if (object instanceof THREE.Mesh && object.userData && object.userData.particle) {
        return object as THREE.Mesh;
      }
      object = object.parent;
    }
    return null;
  }

  private pickNodeUnderCursor(radiusMultiplier = 1) {
    const nodeIntersects = this.sceneManager.raycaster.intersectObjects(this.state.nodes, true);
    if (nodeIntersects.length) {
      const node = this.findNode(nodeIntersects[0].object);
      if (node) {
        return node;
      }
    }

    if (this.state.nodes.length === 0) {
      return null;
    }

    const baseSize = this.sceneManager.getNodeSizeWorldUnits();
    const threshold = Math.max(0.001, baseSize * radiusMultiplier);
    const thresholdSq = threshold * threshold;
    const ray = this.sceneManager.raycaster.ray;
    let closest: THREE.Mesh | null = null;
    let bestDistance = thresholdSq;

    for (const node of this.state.nodes) {
      this.hoverTempVector.copy(node.position).sub(ray.origin);
      if (this.hoverTempVector.dot(ray.direction) < 0) {
        continue;
      }
      const distSq = ray.distanceSqToPoint(node.position);
      if (distSq <= bestDistance) {
        bestDistance = distSq;
        closest = node;
      }
    }

    return closest;
  }

  private undo() {
    if (this.state.history.length === 0) return;
    this.state.isUndoing = true;
    const action = this.state.history.pop();
    if (!action) return;

    if (action.type === 'add') {
      this.sceneManager.removeNode(action.node);
      this.rollbackThreadHistory(action.threads);
    } else if (action.type === 'connect') {
      this.rollbackThreadHistory(action.threads);
    }

    this.state.lastNode = action.previousLastNode;

    this.sceneManager.updateThreadGeometries();
    this.sceneManager.updateStats();
    this.draggedParticle = null;
    this.sceneManager.setDraggedParticle(null);
    this.clearHoverState();
    this.state.isUndoing = false;
  }

  private rollbackThreadHistory(bundle: HistoryThreadBundle) {
    bundle.nodes.forEach(node => this.sceneManager.removeNode(node));
    bundle.threads.forEach(thread => {
      const idx = this.state.threads.indexOf(thread);
      if (idx > -1) this.state.threads.splice(idx, 1);
    });
    bundle.constraints.forEach(constraint => this.sceneManager.removeConstraintInstance(constraint, true));
  }

  private randomizeColors() {
    const randomColor = () => Math.random() * 0xffffff;
    this.settings.nodeColor = randomColor();
    this.settings.threadColor = randomColor();
    const nodeColorInput = document.getElementById('node-color') as HTMLInputElement | null;
    const threadColorInput = document.getElementById('thread-color') as HTMLInputElement | null;
    if (nodeColorInput) {
      nodeColorInput.value = `#${Math.floor(this.settings.nodeColor).toString(16).padStart(6, '0')}`;
    }
    if (threadColorInput) {
      threadColorInput.value = `#${Math.floor(this.settings.threadColor).toString(16).padStart(6, '0')}`;
    }
    this.clearHoverState();
    this.sceneManager.refreshNodeSizes();
    this.sceneManager.refreshNodeColors();
    this.sceneManager.refreshThreadAppearance();
  }

  private setupSceneMenu() {
    const menu = document.getElementById('scene-menu');
    const toggle = document.getElementById('scene-menu-toggle');
    toggle?.addEventListener('click', () => {
      menu?.classList.toggle('collapsed');
    });

    this.sceneFileInput = document.getElementById('scene-file-input') as HTMLInputElement | null;
    this.sceneFileInput?.addEventListener('change', event => this.onSceneFileSelected(event));
    this.meshFileInput = document.getElementById('mesh-file-input') as HTMLInputElement | null;
    this.meshFileInput?.addEventListener('change', event => this.onMeshFileSelected(event));

    this.bindSceneMenuAction('save', () => this.saveScene());
    this.bindSceneMenuAction('load', () => this.requestSceneLoad());
    this.bindSceneMenuAction('export', () => this.exportWeb());
    this.bindSceneMenuAction('import-obj', () => this.requestMeshImport());
  }

  private bindSceneMenuAction(action: string, handler: () => void) {
    const button = document.querySelector(`[data-scene-action="${action}"]`) as HTMLButtonElement | null;
    button?.addEventListener('click', handler);
  }

  private async saveScene() {
    try {
      const data = serializeScene({ sceneManager: this.sceneManager, state: this.state, settings: this.settings });
      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const defaultFileName = `spiderweb-scene-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

      // Try to use File System Access API (always shows save dialog)
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: defaultFileName,
            types: [{
              description: 'Spiderweb Scene',
              accept: { 'application/json': ['.json'] }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (err) {
          // User cancelled or API failed, fall through to legacy method
          if ((err as Error).name !== 'AbortError') {
            console.warn('File System Access API failed, falling back to download link', err);
          } else {
            return; // User cancelled, don't show fallback
          }
        }
      }

      // Fallback for browsers without File System Access API
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = defaultFileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to save scene', error);
      alert('Failed to save scene. Check console for details.');
    }
  }

  private requestSceneLoad() {
    if (!this.sceneFileInput) return;
    this.sceneFileInput.value = '';
    this.sceneFileInput.click();
  }

  private onSceneFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    this.loadSceneFromFile(file);
    input.value = '';
  }

  private requestMeshImport() {
    if (!this.meshFileInput) return;
    this.meshFileInput.value = '';
    this.meshFileInput.click();
  }

  private onMeshFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    void this.importMeshFromFile(file);
    input.value = '';
  }

  private loadSceneFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const contents = reader.result as string;
        const data = JSON.parse(contents) as SerializedScene;
        await this.applySceneData(data);
      } catch (error) {
        console.error('Failed to load scene file', error);
        alert(error instanceof Error ? error.message : 'Failed to load scene. Ensure the file is valid.');
      }
    };
    reader.readAsText(file);
  }

  private async importMeshFromFile(file: File) {
    try {
      if (this.state.nodes.length > 0 || this.state.threads.length > 0) {
        const confirmed = window.confirm('Importing a mesh will clear the current web. Continue?');
        if (!confirmed) return;
      }

      const objText = await file.text();
      const identifier = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? file.name;
      this.clearWeb();
      await this.sceneManager.setCustomMeshFromText(objText);
      this.physicsController.setCustomMesh(objText);
      this.state.customMeshPath = identifier;
      this.state.customMeshText = objText;
      this.frameCurrentScene();
      // Refresh wireframe overlays after user imports a mesh
      this.sceneManager.setWireframeVisible(this.settings.showWireframe);
      this.disableCollisionForCustomMeshRule();
    } catch (error) {
      console.error('Failed to import OBJ mesh', error);
      alert('Failed to import mesh. Ensure the OBJ file is valid.');
    }
  }

  private async exportWeb() {
    try {
      const plyData = generatePly(this.state);
      const blob = new Blob([plyData], { type: 'text/plain' });
      const defaultFileName = `spiderweb-export-${new Date().toISOString().replace(/[:.]/g, '-')}.ply`;

      // Try to use File System Access API (always shows save dialog)
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: defaultFileName,
            types: [{
              description: 'PLY 3D Model',
              accept: { 'text/plain': ['.ply'] }
            }]
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (err) {
          // User cancelled or API failed, fall through to legacy method
          if ((err as Error).name !== 'AbortError') {
            console.warn('File System Access API failed, falling back to download link', err);
          } else {
            return; // User cancelled, don't show fallback
          }
        }
      }

      // Fallback for browsers without File System Access API
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = defaultFileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export web to PLY', error);
      alert('Failed to export web. Check console for details.');
    }
  }

  private async applySceneData(scene: SerializedScene) {
    if (scene.version !== 1) {
      throw new Error(`Unsupported scene version: ${scene.version}`);
    }
    this.clearWeb();
    this.applyLoadedSettings(scene.settings);
    // Restore scene data into state first so embedded mesh text is available
    restoreSceneFromData(scene, { sceneManager: this.sceneManager, state: this.state });

    // If the scene file contained embedded mesh text, apply it directly.
    if (scene.customMeshData !== undefined && scene.customMeshData !== null) {
      try {
        await this.sceneManager.setCustomMeshFromText(scene.customMeshData);
        this.physicsController.setCustomMesh(scene.customMeshData);
        // Ensure state reflects what we've applied
        this.state.customMeshPath = scene.customMeshPath ?? null;
        this.state.customMeshText = scene.customMeshData ?? null;
        // Refresh wireframe overlays so they appear immediately if user has toggled wireframe on
        this.sceneManager.setWireframeVisible(this.settings.showWireframe);
        this.disableCollisionForCustomMeshRule();
        if (!this.sceneManager.hasCustomMesh()) {
          console.warn('Embedded mesh data was applied but scene manager reports no custom mesh. Retrying...');
          try {
            await this.sceneManager.setCustomMeshFromText(this.state.customMeshText ?? '');
            this.physicsController.setCustomMesh(this.state.customMeshText ?? '');
            this.disableCollisionForCustomMeshRule();
          } catch (err2) {
            console.error('Retry applying embedded mesh failed', err2);
          }
        }
      } catch (err) {
        console.warn('Failed to apply embedded custom mesh data, falling back to loader', err);
        await this.applySceneCustomMesh(scene.customMeshPath ?? null);
        // Refresh wireframe overlays after loader fallback
        this.sceneManager.setWireframeVisible(this.settings.showWireframe);
      }
    } else {
      await this.applySceneCustomMesh(scene.customMeshPath ?? null);
      // Ensure wireframe overlays are refreshed after fetch-based load too
      this.sceneManager.setWireframeVisible(this.settings.showWireframe);
    }
    this.sceneManager.camera.position.set(scene.camera.position.x, scene.camera.position.y, scene.camera.position.z);
    this.cameraTarget.set(scene.camera.target.x, scene.camera.target.y, scene.camera.target.z);
    this.sceneManager.camera.lookAt(this.cameraTarget);
    this.sceneManager.camera.updateProjectionMatrix();
    this.cameraDistance = this.sceneManager.camera.position.distanceTo(this.cameraTarget);
    this.sceneManager.refreshThreadAppearance();
  }

  private applyLoadedSettings(newSettings: Settings) {
    Object.assign(this.settings, newSettings);
    syncControlsWithSettings(this.settings);
    this.sceneManager.setWireframeVisible(this.settings.showWireframe);
  }

  private async applySceneCustomMesh(path: string | null) {
    const trimmedPath = path?.trim() ?? '';
    if (!trimmedPath) {
      // If there is embedded mesh text in state use it; otherwise clear
      if (this.state.customMeshText) {
        await this.sceneManager.setCustomMeshFromText(this.state.customMeshText);
        this.physicsController.setCustomMesh(this.state.customMeshText);
        this.disableCollisionForCustomMeshRule();
        return;
      }
      this.sceneManager.clearCustomMesh();
      this.physicsController.clearCustomMesh();
      this.state.customMeshPath = null;
      this.state.customMeshText = null;
      return;
    }

    // If scene already has the same custom mesh loaded, skip
    if (this.sceneManager.hasCustomMesh() && this.state.customMeshPath === trimmedPath) {
      return;
    }

    // If we have embedded mesh text matching this path, use it (helps when scene saved with embedded data)
    if (this.state.customMeshText) {
      try {
        await this.sceneManager.setCustomMeshFromText(this.state.customMeshText);
        this.physicsController.setCustomMesh(this.state.customMeshText);
        this.state.customMeshPath = trimmedPath;
        this.disableCollisionForCustomMeshRule();
        return;
      } catch (err) {
        console.warn('Failed to apply embedded custom mesh text, falling back to fetch', err);
      }
    }

    try {
      const response = await fetch(trimmedPath);
      if (!response.ok) {
        throw new Error(`Failed to fetch mesh (${response.status})`);
      }
      const objText = await response.text();
      await this.sceneManager.setCustomMeshFromText(objText);
      this.physicsController.setCustomMesh(objText);
      this.state.customMeshPath = trimmedPath;
      this.state.customMeshText = null; // we didn't load embedded text
      this.disableCollisionForCustomMeshRule();
    } catch (error) {
      console.warn(`Unable to load custom mesh at "${trimmedPath}"`, error);
      this.sceneManager.clearCustomMesh();
      this.physicsController.clearCustomMesh();
      this.state.customMeshPath = null;
      this.state.customMeshText = null;
      alert(`Custom mesh "${trimmedPath}" could not be loaded. The scene will open without it.`);
    }
  }

  private disableCollisionForCustomMeshRule() {
    if (!this.sceneManager.hasCustomMesh()) return;
    if (!this.settings.enableCollision) return;
    this.settings.enableCollision = false;
    const collisionToggle = document.getElementById('collision-toggle') as HTMLInputElement | null;
    if (collisionToggle) {
      collisionToggle.checked = false;
    }
  }

  private notifyComingSoon(feature: string) {
    alert(`${feature} is coming soon.`);
  }

  private clearWeb() {
    this.draggedParticle = null;
    this.sceneManager.setDraggedParticle(null);
    this.clearHoverState();
    this.sceneManager.renderer.domElement.style.cursor = 'default';
    this.sceneManager.clearWeb();
  }
}
